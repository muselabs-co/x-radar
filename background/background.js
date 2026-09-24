// background/background.js - Service Worker for X Radar

import {
  getAuthCredentials,
  fetchCurrentUserProfile,
  fetchRelationshipList,
  updateDynamicQueryIds,
  enrichUsersWithLookup
} from '../utils/x-api.js';

import {
  getStoredOverview,
  getAnalyzedData,
  processAndSaveSyncResults,
  updateRealtimeAction,
  clearAllData,
  getSettings
} from '../utils/storage.js';

import {
  readDisplayMode,
  saveAndApplyDisplayMode
} from '../utils/display-mode.js';

const SYNC_STATE_KEY = 'xradar_sync_state';

let activeSyncController = null;
let currentSyncProgress = {
  isSyncing: false,
  stage: '',
  loadedCount: 0,
  totalEstimate: 0,
  estimatedRemainingSec: 0,
  overallFollowingTotal: 0,
  overallFollowersTotal: 0,
  message: '',
  error: null
};

async function configureDisplayMode() {
  const mode = await readDisplayMode();
  await saveAndApplyDisplayMode(mode);
}

// Initialize display mode and background tasks
configureDisplayMode().catch(console.warn);

chrome.runtime.onInstalled.addListener(() => {
  console.log('[X Radar] Extension installed.');
  configureDisplayMode().catch(console.warn);
  updateDynamicQueryIds().catch(console.warn);
});

chrome.runtime.onStartup.addListener(() => {
  configureDisplayMode().catch(console.warn);
  updateDynamicQueryIds().catch(console.warn);
});

async function rememberSyncRunning(running) {
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: { isSyncing: running } });
}

async function recoverInterruptedSync() {
  try {
    const stored = await chrome.storage.local.get(SYNC_STATE_KEY);
    if (!stored[SYNC_STATE_KEY]?.isSyncing) return;
    currentSyncProgress = {
      isSyncing: false,
      stage: 'error',
      loadedCount: 0,
      totalEstimate: 0,
      estimatedRemainingSec: 0,
      overallFollowingTotal: 0,
      overallFollowersTotal: 0,
      message: 'SCAN_INTERRUPTED',
      error: 'SCAN_INTERRUPTED'
    };
    await rememberSyncRunning(false);
  } catch (e) {
    // Ignore storage errors during startup recovery.
  }
}

const syncReady = recoverInterruptedSync();

// Broadcast progress to popup or listening views
function broadcastProgress(progressUpdate) {
  if (progressUpdate) {
    currentSyncProgress = { ...currentSyncProgress, ...progressUpdate };
  }
  chrome.runtime.sendMessage({
    type: 'SYNC_PROGRESS_UPDATE',
    progress: currentSyncProgress
  }).catch(() => {
    // Popup or side panel might not be open, safe to ignore
  });
}

// Perform full synchronization
async function executeFullSync() {
  await syncReady;
  if (currentSyncProgress.isSyncing) {
    throw new Error('已经在同步中，请勿重复操作');
  }

  activeSyncController = new AbortController();
  const signal = activeSyncController.signal;

  try {
    currentSyncProgress = {
      isSyncing: true,
      stage: 'init',
      loadedCount: 0,
      totalEstimate: 0,
      estimatedRemainingSec: 0,
      overallFollowingTotal: 0,
      overallFollowersTotal: 0,
      message: '正在检查 X.com 登录状态...',
      error: null
    };
    broadcastProgress();
    await rememberSyncRunning(true);

    // 1. Auth check
    const credentials = await getAuthCredentials();
    if (!credentials.isLoggedIn) {
      throw new Error(credentials.error || '未登录 X.com');
    }

    // 2. Fetch User Profile
    broadcastProgress({ stage: 'profile', message: '正在同步个人资料...' });
    let profile = await fetchCurrentUserProfile(credentials);
    const settings = await getSettings();
    const delayMs = settings.requestDelayMs || 1000;

    let followingTotal = profile.following_count || 0;
    let followersTotal = profile.followers_count || 0;

    const domCounts = await chrome.storage.local.get([
      'xradar_user_following_count',
      'xradar_user_followers_count'
    ]);
    followingTotal = Math.max(followingTotal, Number(domCounts.xradar_user_following_count) || 0);
    followersTotal = Math.max(followersTotal, Number(domCounts.xradar_user_followers_count) || 0);
    if (followingTotal + followersTotal > 10000) {
      throw new Error('SCAN_TOO_LARGE');
    }

    // Check previously stored overview or cached data for counts if 0
    if (!followingTotal || !followersTotal) {
      const stored = await getStoredOverview();
      if (stored?.profile) {
        if (!followingTotal && stored.profile.following_count) followingTotal = stored.profile.following_count;
        if (!followersTotal && stored.profile.followers_count) followersTotal = stored.profile.followers_count;
      }
      if (stored?.counts) {
        if (!followingTotal && stored.counts.totalFollowing) followingTotal = stored.counts.totalFollowing;
        if (!followersTotal && stored.counts.totalFollowers) followersTotal = stored.counts.totalFollowers;
      }
    }

    const targetUserId = profile.id || credentials.userId;
    if (!targetUserId || targetUserId === 'me') {
      throw new Error('无法确认当前登录的 X 账号 ID，请确保在 x.com 处于登录状态并刷新网页');
    }

    // Helper to calculate total overall remaining time across both following & followers
    const getOverallEstSec = (stage, loadedCount) => {
      const secPerBatch = (delayMs + 200 + 350) / 1000; // ~1.55s per batch of 50 users

      let remFollowingBatches = 0;
      let remFollowersBatches = 0;

      if (stage === 'following') {
        const effFollowingTotal = Math.max(followingTotal, loadedCount + 50);
        const remFollowing = Math.max(0, effFollowingTotal - loadedCount);
        remFollowingBatches = Math.ceil(remFollowing / 50);

        const effFollowersTotal = Math.max(followersTotal, 50);
        remFollowersBatches = Math.ceil(effFollowersTotal / 50);
      } else if (stage === 'followers') {
        remFollowingBatches = 0;
        const effFollowersTotal = Math.max(followersTotal, loadedCount + 50);
        const remFollowers = Math.max(0, effFollowersTotal - loadedCount);
        remFollowersBatches = Math.ceil(remFollowers / 50);
      } else if (stage === 'analyzing') {
        return 1;
      }

      const totalRemainingBatches = remFollowingBatches + remFollowersBatches;
      return Math.max(2, Math.round(totalRemainingBatches * secPerBatch));
    };

    // Callback when GraphQL returns root user profile
    const onProfileDiscovered = (discoveredProfile) => {
      let updated = false;
      if (discoveredProfile.following_count && discoveredProfile.following_count > followingTotal) {
        followingTotal = discoveredProfile.following_count;
        profile.following_count = followingTotal;
        updated = true;
      }
      if (discoveredProfile.followers_count && discoveredProfile.followers_count > followersTotal) {
        followersTotal = discoveredProfile.followers_count;
        profile.followers_count = followersTotal;
        updated = true;
      }
      if (discoveredProfile.screen_name && !profile.screen_name) {
        profile.screen_name = discoveredProfile.screen_name;
        updated = true;
      }
      if (updated) {
        chrome.storage.local.set({ xradar_profile: profile });
      }
    };

    // 3. Scan Following (正在关注)
    broadcastProgress({
      stage: 'following',
      message: `正在扫描关注列表 (共约 ${followingTotal || '多'} 人)...`,
      totalEstimate: followingTotal,
      overallFollowingTotal: followingTotal,
      overallFollowersTotal: followersTotal,
      estimatedRemainingSec: getOverallEstSec('following', 0)
    });

    const followingResult = await fetchRelationshipList({
      type: 'Following',
      userId: targetUserId,
      credentials,
      delayMs,
      maxCount: settings.maxFetchCount || 10000,
      expectedCount: followingTotal,
      signal,
      onProfileDiscovered,
      onProgress: (prog) => {
        const estSec = getOverallEstSec('following', prog.loadedCount);
        broadcastProgress({
          stage: 'following',
          loadedCount: prog.loadedCount,
          totalEstimate: followingTotal,
          overallFollowingTotal: followingTotal,
          overallFollowersTotal: followersTotal,
          estimatedRemainingSec: estSec,
          message: prog.status || `正在获取正在关注列表... (已完成 ${prog.loadedCount} 人)`
        });
      }
    });

    // 4. Scan Followers (粉丝)
    broadcastProgress({
      stage: 'followers',
      message: `正在扫描粉丝账号 (共约 ${followersTotal || '多'} 人)...`,
      totalEstimate: followersTotal,
      overallFollowingTotal: followingTotal,
      overallFollowersTotal: followersTotal,
      estimatedRemainingSec: getOverallEstSec('followers', 0)
    });

    const followersResult = await fetchRelationshipList({
      type: 'Followers',
      userId: targetUserId,
      credentials,
      delayMs,
      maxCount: settings.maxFetchCount || 10000,
      expectedCount: followersTotal,
      signal,
      onProfileDiscovered,
      onProgress: (prog) => {
        const estSec = getOverallEstSec('followers', prog.loadedCount);
        broadcastProgress({
          stage: 'followers',
          loadedCount: prog.loadedCount,
          totalEstimate: followersTotal,
          overallFollowingTotal: followingTotal,
          overallFollowersTotal: followersTotal,
          estimatedRemainingSec: estSec,
          message: prog.status || `正在获取粉丝列表... (已完成 ${prog.loadedCount} 人)`
        });
      }
    });

    const followingList = followingResult.users || [];
    const followersList = followersResult.users || [];
    if (!followingResult.complete || !followersResult.complete) {
      throw new Error('SCAN_INCOMPLETE');
    }

    // 5. Compare Snapshots & Categorize
    broadcastProgress({
      stage: 'analyzing',
      message: '正在对比关系快照，精确计算未回关与变动历史...',
      estimatedRemainingSec: 1
    });

    // Ensure profile following and follower counts are accurately recorded
    if (!profile.following_count || profile.following_count === 0) {
      profile.following_count = followingList.length;
    }
    if (!profile.followers_count || profile.followers_count === 0) {
      profile.followers_count = followersList.length;
    }

    // Try to enrich followingList user entities with real follower counts via bulk lookup
    try {
      await enrichUsersWithLookup(followingList, credentials, 300);
    } catch (e) {
      // non-critical
    }

    const { latestData, newTimelineEvents } = await processAndSaveSyncResults(
      profile,
      followingList,
      followersList
    );

    currentSyncProgress = {
      isSyncing: false,
      stage: 'done',
      loadedCount: 0,
      totalEstimate: 0,
      estimatedRemainingSec: 0,
      overallFollowingTotal: followingTotal,
      overallFollowersTotal: followersTotal,
      message: '扫描完成！',
      error: null
    };
    broadcastProgress();

    return { success: true, latestData, newTimelineEvents };
  } catch (err) {
    const isCancelled = err.name === 'AbortError' || err.message?.includes('SYNC_CANCELLED');
    currentSyncProgress = {
      isSyncing: false,
      stage: isCancelled ? 'cancelled' : 'error',
      loadedCount: 0,
      totalEstimate: 0,
      estimatedRemainingSec: 0,
      message: isCancelled ? '同步已取消' : (err.message || '同步失败'),
      error: err.message
    };
    broadcastProgress();
    throw err;
  } finally {
    activeSyncController = null;
    await rememberSyncRunning(false);
  }
}

// Handle runtime messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action, payload } = request;

  if (action === 'GET_STATUS') {
    syncReady.then(() => getAuthCredentials()).then(async (credentials) => {
      const overview = await getStoredOverview();
      sendResponse({
        isLoggedIn: credentials.isLoggedIn,
        userId: credentials.userId,
        loginError: credentials.error,
        overview,
        syncProgress: currentSyncProgress
      });
    }).catch(err => {
      sendResponse({ isLoggedIn: false, error: err.message, syncProgress: currentSyncProgress });
    });
    return true; // Keep channel open for async response
  }

  if (action === 'START_SYNC') {
    executeFullSync()
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (action === 'CANCEL_SYNC') {
    if (activeSyncController) {
      activeSyncController.abort();
      activeSyncController = null;
    }
    sendResponse({ success: true });
    return false;
  }

  if (action === 'GET_DATA') {
    getAnalyzedData().then(data => {
      sendResponse({ success: true, data });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (action === 'CLEAR_DATA') {
    clearAllData().then(() => {
      sendResponse({ success: true });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (action === 'OPEN_FOLLOWING_FILTER_PAGE') {
    (async () => {
      let screenName = payload?.screenName;
      if (!screenName) {
        const stored = await chrome.storage.local.get(['xradar_user_screen_name', 'xradar_profile']);
        screenName = stored.xradar_user_screen_name || stored.xradar_profile?.screen_name || '';
      }

      const targetUrl = screenName ? `https://x.com/${screenName}/following` : 'https://x.com/following';

      const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
      if (tabs.length > 0) {
        const tab = tabs.find(t => t.active) || tabs[0];
        const isAlreadyOnPage = tab.url && (
          tab.url.toLowerCase() === targetUrl.toLowerCase() ||
          (screenName && tab.url.toLowerCase().includes(`/${screenName.toLowerCase()}/following`))
        );
        if (!isAlreadyOnPage) {
          await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
        } else {
          await chrome.tabs.update(tab.id, { active: true });
        }
        if (tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } else {
        await chrome.tabs.create({ url: targetUrl, active: true });
      }

      sendResponse({ success: true, targetUrl });
    })().catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (action === 'OPEN_FOLLOWERS_FILTER_PAGE') {
    (async () => {
      let screenName = payload?.screenName;
      if (!screenName) {
        const stored = await chrome.storage.local.get(['xradar_user_screen_name', 'xradar_profile']);
        screenName = stored.xradar_user_screen_name || stored.xradar_profile?.screen_name || '';
      }

      const targetUrl = screenName ? `https://x.com/${screenName}/followers` : 'https://x.com/followers';

      const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
      if (tabs.length > 0) {
        const tab = tabs.find(t => t.active) || tabs[0];
        const isAlreadyOnPage = tab.url && (
          tab.url.toLowerCase() === targetUrl.toLowerCase() ||
          (screenName && (
            tab.url.toLowerCase().includes(`/${screenName.toLowerCase()}/followers`) ||
            tab.url.toLowerCase().includes(`/${screenName.toLowerCase()}/verified_followers`)
          ))
        );
        if (!isAlreadyOnPage) {
          await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
        } else {
          await chrome.tabs.update(tab.id, { active: true });
        }
        if (tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } else {
        await chrome.tabs.create({ url: targetUrl, active: true });
      }

      sendResponse({ success: true, targetUrl });
    })().catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (action === 'REALTIME_USER_ACTION') {
    updateRealtimeAction(payload).then(result => {
      if (result) {
        chrome.runtime.sendMessage({
          type: 'DATA_UPDATED_REALTIME',
          payload: result
        }).catch(() => {});
      }
      sendResponse({ success: true, result });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});
