// utils/storage.js - Local Data Persistence & Snapshot Diff Engine

const STORAGE_KEYS = {
  PROFILE: 'xradar_profile',
  LATEST_DATA: 'xradar_latest_data',
  PREVIOUS_SNAPSHOT: 'xradar_previous_snapshot',
  TIMELINE_EVENTS: 'xradar_timeline_events',
  SETTINGS: 'xradar_settings',
  LAST_SYNC_TIME: 'xradar_last_sync_time'
};

const DEFAULT_SETTINGS = {
  requestDelayMs: 1000,
  maxFetchCount: 10000
};

async function writeLocal(items) {
  try {
    await chrome.storage.local.set(items);
  } catch (err) {
    const message = String(err?.message || err || '');
    if (message.toLowerCase().includes('quota')) {
      throw new Error('STORAGE_QUOTA');
    }
    throw err;
  }
}

function readPositiveCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Header total for "following". A short local list is only the people touched
 * since the last scan, so it must not replace the account total. A stored
 * count far below the page total was incremented from zero (0, 1, 2...) and
 * the page total is the real base.
 */
export function resolveFollowingTotal(profileCount, listLength, domCount) {
  const profile = readPositiveCount(profileCount);
  const list = readPositiveCount(listLength);
  const dom = readPositiveCount(domCount);
  const listLooksComplete = list > 0 && (dom === 0 || list >= dom * 0.5);

  if (listLooksComplete) return Math.max(profile, list, dom);
  if (dom > profile) return dom;
  return profile;
}

/**
 * Get extension settings
 */
export async function getSettings() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS]);
  return { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };
}

/**
 * Save extension settings
 */
export async function saveSettings(settings) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: settings
  });
}

/**
 * Get cached profile and sync overview
 */
export async function getStoredOverview() {
  const res = await chrome.storage.local.get([
    STORAGE_KEYS.PROFILE,
    STORAGE_KEYS.LATEST_DATA,
    STORAGE_KEYS.LAST_SYNC_TIME
  ]);

  const profile = res[STORAGE_KEYS.PROFILE] || null;
  const latestData = res[STORAGE_KEYS.LATEST_DATA] || null;
  const lastSyncTime = res[STORAGE_KEYS.LAST_SYNC_TIME] || null;
  const domStats = await chrome.storage.local.get(['xradar_user_following_count', 'xradar_user_followers_count']);

  if (profile) {
    profile.following_count = resolveFollowingTotal(
      profile.following_count,
      latestData?.followingList?.length,
      domStats.xradar_user_following_count
    );
    if (!profile.followers_count) {
      profile.followers_count = latestData?.followersList?.length || domStats.xradar_user_followers_count || 0;
    }
  }

  return {
    profile,
    lastSyncTime,
    counts: latestData ? {
      notFollowingBack: latestData.notFollowingBack?.length || 0,
      fansNotFollowed: latestData.fansNotFollowed?.length || 0,
      mutuals: latestData.mutuals?.length || 0,
      totalFollowing: latestData.followingList?.length || 0,
      totalFollowers: latestData.followersList?.length || 0
    } : null
  };
}

/**
 * Get all current analyzed lists
 */
export async function getAnalyzedData() {
  const res = await chrome.storage.local.get([
    STORAGE_KEYS.PROFILE,
    STORAGE_KEYS.LATEST_DATA,
    STORAGE_KEYS.TIMELINE_EVENTS,
    STORAGE_KEYS.LAST_SYNC_TIME,
    'xradar_user_following_count',
    'xradar_user_followers_count'
  ]);

  const profile = res[STORAGE_KEYS.PROFILE] || null;
  const data = res[STORAGE_KEYS.LATEST_DATA] || {
    notFollowingBack: [],
    fansNotFollowed: [],
    mutuals: [],
    followingList: [],
    followersList: []
  };

  if (profile) {
    profile.following_count = resolveFollowingTotal(
      profile.following_count,
      data.followingList?.length,
      res.xradar_user_following_count
    );
    if (!profile.followers_count) {
      profile.followers_count = data.followersList?.length || res.xradar_user_followers_count || 0;
    }
  }

  return {
    profile,
    data,
    timeline: res[STORAGE_KEYS.TIMELINE_EVENTS] || [],
    lastSyncTime: res[STORAGE_KEYS.LAST_SYNC_TIME] || null
  };
}

/**
 * Save newly fetched Following & Followers lists, compute relationships & diff
 */
export async function processAndSaveSyncResults(profile, followingList, followersList) {
  const now = new Date().toISOString();

  // Retrieve previous snapshot to compute diffs
  const prevRes = await chrome.storage.local.get([
    STORAGE_KEYS.PREVIOUS_SNAPSHOT,
    STORAGE_KEYS.TIMELINE_EVENTS
  ]);
  const prevSnapshot = prevRes[STORAGE_KEYS.PREVIOUS_SNAPSHOT] || null;
  const existingTimeline = prevRes[STORAGE_KEYS.TIMELINE_EVENTS] || [];

  // Build maps and sets for bulletproof lookup (by ID and by screen_name)
  const followersIdSet = new Set();
  const followersScreenNameSet = new Set();
  const followersMap = new Map();
  for (const u of followersList) {
    if (u.id) {
      followersIdSet.add(String(u.id));
      followersMap.set(String(u.id), u);
    }
    if (u.screen_name) {
      followersScreenNameSet.add(u.screen_name.toLowerCase());
    }
  }

  const followingIdSet = new Set();
  const followingScreenNameSet = new Set();
  const followingMap = new Map();
  for (const u of followingList) {
    if (u.id) {
      followingIdSet.add(String(u.id));
      followingMap.set(String(u.id), u);
    }
    if (u.screen_name) {
      followingScreenNameSet.add(u.screen_name.toLowerCase());
    }
  }

  // Determine if a user you follow follows you back (Mutual)
  const doesFollowMe = (u) => {
    if (u.id && followersIdSet.has(String(u.id))) return true;
    if (u.screen_name && followersScreenNameSet.has(u.screen_name.toLowerCase())) return true;
    if (u.followed_by === true) return true;
    return false;
  };

  // Determine if you follow this user
  const doIFollow = (u) => {
    if (u.id && followingIdSet.has(String(u.id))) return true;
    if (u.screen_name && followingScreenNameSet.has(u.screen_name.toLowerCase())) return true;
    if (u.following === true) return true;
    return false;
  };

  // 1. Compute Relationship Categorization
  // A. Not Following Back (你关注了他，但他没回关你)
  const notFollowingBack = followingList.filter(u => !doesFollowMe(u));

  // C. Mutuals (双向奔赴/互相关注)
  const mutuals = followingList.filter(u => doesFollowMe(u));

  // B. Fans Not Followed Back (他关注了你，但你没回关他)
  const fansNotFollowed = followersList.filter(u => !doIFollow(u));

  // 2. Compute Snapshot Diffs (谁关注了我、谁取关了我)
  const newTimelineEvents = [];

  if (prevSnapshot && prevSnapshot.followersMap) {
    const prevFollowers = Object.values(prevSnapshot.followersMap);
    const prevIds = new Set(prevFollowers.map(user => String(user.id || '')).filter(Boolean));
    const prevNames = new Set(prevFollowers.map(user => (user.screen_name || '').toLowerCase()).filter(Boolean));
    const currentIds = new Set([...followersMap.keys()].map(id => String(id)));
    const currentNames = new Set(
      [...followersMap.values()].map(user => (user.screen_name || '').toLowerCase()).filter(Boolean)
    );

    const seenBefore = (user) => {
      if (user.id && prevIds.has(String(user.id))) return true;
      const name = (user.screen_name || '').toLowerCase();
      return Boolean(name && prevNames.has(name));
    };
    const stillPresent = (user) => {
      if (user.id && currentIds.has(String(user.id))) return true;
      const name = (user.screen_name || '').toLowerCase();
      return Boolean(name && currentNames.has(name));
    };

    for (const user of followersMap.values()) {
      if (seenBefore(user)) continue;
      newTimelineEvents.push({
        id: `follow_${user.id || user.screen_name}_${Date.now()}`,
        type: 'followed_me',
        title: '新增粉丝',
        description: `@${user.screen_name} 关注了你`,
        user: {
          id: user.id,
          name: user.name,
          screen_name: user.screen_name,
          avatar: user.avatar
        },
        timestamp: now
      });
    }

    for (const oldUser of prevFollowers) {
      if (stillPresent(oldUser)) continue;
      newTimelineEvents.push({
        id: `unfollow_${oldUser.id || oldUser.screen_name}_${Date.now()}`,
        type: 'unfollowed_me',
        title: '粉丝取关',
        description: `@${oldUser.screen_name} 取关了你`,
        user: {
          id: oldUser.id,
          name: oldUser.name,
          screen_name: oldUser.screen_name,
          avatar: oldUser.avatar
        },
        timestamp: now
      });
    }
  } else {
    // First time initializing
    newTimelineEvents.push({
      id: `init_${Date.now()}`,
      type: 'baseline_created',
      title: '初始化雷达底库',
      description: `初次建立关系底库（关注 ${followingList.length} 人，粉丝 ${followersList.length} 人）`,
      user: null,
      timestamp: now
    });
  }

  // Combine timeline events, most recent first (limit to 500 records)
  const updatedTimeline = [...newTimelineEvents, ...existingTimeline].slice(0, 500);

  // Prepare simple snapshot object for next diff comparison
  const nextSnapshot = {
    timestamp: now,
    followingMap: Object.fromEntries(followingMap),
    followersMap: Object.fromEntries(followersMap)
  };

  const latestData = {
    notFollowingBack,
    fansNotFollowed,
    mutuals,
    followingList,
    followersList
  };

  if (profile) {
    if (!profile.following_count && followingList.length > 0) {
      profile.following_count = followingList.length;
    }
    if (!profile.followers_count && followersList.length > 0) {
      profile.followers_count = followersList.length;
    }
  }

  await writeLocal({
    [STORAGE_KEYS.PROFILE]: profile,
    [STORAGE_KEYS.LATEST_DATA]: latestData,
    [STORAGE_KEYS.PREVIOUS_SNAPSHOT]: nextSnapshot,
    [STORAGE_KEYS.TIMELINE_EVENTS]: updatedTimeline,
    [STORAGE_KEYS.LAST_SYNC_TIME]: now
  });

  return {
    latestData,
    newTimelineEvents
  };
}

/**
 * Clear all stored data
 */
export async function clearAllData() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.PROFILE,
    STORAGE_KEYS.LATEST_DATA,
    STORAGE_KEYS.PREVIOUS_SNAPSHOT,
    STORAGE_KEYS.TIMELINE_EVENTS,
    STORAGE_KEYS.LAST_SYNC_TIME
  ]);
}

/**
 * Handle real-time user follow / unfollow action intercepted from webpage
 */
export async function updateRealtimeAction({ type, user }) {
  if (!user || (!user.id && !user.screen_name)) return null;

  const now = new Date().toISOString();
  const res = await chrome.storage.local.get([
    STORAGE_KEYS.PROFILE,
    STORAGE_KEYS.LATEST_DATA,
    STORAGE_KEYS.TIMELINE_EVENTS,
    STORAGE_KEYS.PREVIOUS_SNAPSHOT,
    'xradar_user_following_count'
  ]);

  let profile = res[STORAGE_KEYS.PROFILE] || null;
  let data = res[STORAGE_KEYS.LATEST_DATA] || {
    notFollowingBack: [],
    fansNotFollowed: [],
    mutuals: [],
    followingList: [],
    followersList: []
  };
  let timeline = res[STORAGE_KEYS.TIMELINE_EVENTS] || [];
  let prevSnapshot = res[STORAGE_KEYS.PREVIOUS_SNAPSHOT] || null;

  const targetId = String(user.id || '');
  const targetScreenName = (user.screen_name || '').toLowerCase();

  const matchesUser = (u) => {
    if (targetId && String(u.id) === targetId) return true;
    if (targetScreenName && u.screen_name && u.screen_name.toLowerCase() === targetScreenName) return true;
    return false;
  };

  if (type === 'unfollow') {
    // 1. Check if user was in mutuals (if so, they become fansNotFollowed)
    const wasMutual = (data.mutuals || []).some(matchesUser);

    // 2. Remove from followingList, notFollowingBack, mutuals
    data.followingList = (data.followingList || []).filter(u => !matchesUser(u));
    data.notFollowingBack = (data.notFollowingBack || []).filter(u => !matchesUser(u));
    data.mutuals = (data.mutuals || []).filter(u => !matchesUser(u));

    if (wasMutual) {
      if (!data.fansNotFollowed) data.fansNotFollowed = [];
      if (!data.fansNotFollowed.some(matchesUser)) {
        data.fansNotFollowed.unshift({
          ...user,
          following: false,
          followed_by: true
        });
      }
    }

    // 3. Adjust the account total. Seed from the page count when the stored
    // value was never a real total (missing, or incremented from zero).
    if (profile) {
      const base = resolveFollowingTotal(
        profile.following_count,
        0,
        res.xradar_user_following_count
      );
      profile.following_count = Math.max(0, base - 1);
    }

    // 4. Update previous snapshot
    if (prevSnapshot && prevSnapshot.followingMap && targetId) {
      delete prevSnapshot.followingMap[targetId];
    }

    // 5. Add timeline event
    timeline.unshift({
      id: `realtime_unfollow_${targetId || targetScreenName}_${Date.now()}`,
      type: 'i_unfollowed',
      title: '主动取关',
      description: `你主动取关了 @${user.screen_name || '用户'}`,
      user: {
        id: user.id || '',
        name: user.name || user.screen_name || '',
        screen_name: user.screen_name || '',
        avatar: user.avatar || ''
      },
      timestamp: now
    });
  } else if (type === 'follow') {
    // 1. Check if user is in fansNotFollowed (if so, they become mutuals)
    const wasFan = (data.fansNotFollowed || []).some(matchesUser);
    const followedBack = wasFan || user.followed_by === true;

    if (followedBack) {
      data.fansNotFollowed = (data.fansNotFollowed || []).filter(u => !matchesUser(u));
      if (!data.mutuals) data.mutuals = [];
      if (!data.mutuals.some(matchesUser)) {
        data.mutuals.unshift({
          ...user,
          following: true,
          followed_by: true
        });
      }
    } else {
      if (!data.notFollowingBack) data.notFollowingBack = [];
      if (!data.notFollowingBack.some(matchesUser)) {
        data.notFollowingBack.unshift({
          ...user,
          following: true,
          followed_by: false
        });
      }
    }

    if (!data.followingList) data.followingList = [];
    if (!data.followingList.some(matchesUser)) {
      data.followingList.unshift({
        ...user,
        following: true
      });
    }

    // Seed from the page total, then add this follow. Passing list length 0
    // avoids treating the people just prepended to followingList as the total.
    if (profile) {
      const base = resolveFollowingTotal(
        profile.following_count,
        0,
        res.xradar_user_following_count
      );
      profile.following_count = base + 1;
    }

    // Add timeline event
    timeline.unshift({
      id: `realtime_follow_${targetId || targetScreenName}_${Date.now()}`,
      type: followedBack ? 'i_followed_back' : 'i_followed',
      title: followedBack ? '回关' : '主动关注',
      description: followedBack
        ? `你回关了 @${user.screen_name || '用户'}`
        : `你主动关注了 @${user.screen_name || '用户'}`,
      user: {
        id: user.id || '',
        name: user.name || user.screen_name || '',
        screen_name: user.screen_name || '',
        avatar: user.avatar || ''
      },
      timestamp: now
    });
  }

  // Trim timeline to max 500 events
  timeline = timeline.slice(0, 500);

  // Save back to storage
  await writeLocal({
    [STORAGE_KEYS.PROFILE]: profile,
    [STORAGE_KEYS.LATEST_DATA]: data,
    [STORAGE_KEYS.TIMELINE_EVENTS]: timeline,
    [STORAGE_KEYS.PREVIOUS_SNAPSHOT]: prevSnapshot
  });

  return {
    updatedData: data,
    profile,
    timeline
  };
}

