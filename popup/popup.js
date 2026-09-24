// popup/popup.js - Interactive Controller for X Radar Popup

import {
  LOCALES,
  applyStaticText,
  getLocale,
  loadLocale,
  setLocale,
  t,
  translateError
} from '../utils/i18n.js';

import {
  saveAndApplyDisplayMode,
  sidePanelSupported
} from '../utils/display-mode.js';

// Synchronously detect and apply display mode to prevent layout jump / flash of unstyled content
try {
  const _params = new URLSearchParams(window.location.search);
  const _isSide = _params.get('view') === 'sidepanel' || (window.innerWidth > 0 && window.innerWidth !== 480);
  document.documentElement.classList.add(_isSide ? 'mode-sidepanel' : 'mode-popup');
} catch (e) {
  // fallback
}

// Application State
const state = {
  currentTab: 'notFollowingBack',
  profile: null,
  data: {
    notFollowingBack: [],
    fansNotFollowed: [],
    mutuals: [],
    followingList: [],
    followersList: []
  },
  timeline: [],
  isSyncing: false,
  countdownInterval: null,
  secRemaining: 0,
  cancelRequested: false,
  lastSyncTime: null,
  progress: null,
  visibleCount: 60
};

// DOM Elements
const elements = {
  // Quick Filter (Labels for navigation & Switches for toggling)
  labelNoBackMe: document.getElementById('label-noback-me'),
  labelINoBack: document.getElementById('label-i-noback'),
  switchNoBackMe: document.getElementById('switch-noback-me') || document.getElementById('switch-only-noback'),
  switchINoBack: document.getElementById('switch-i-noback'),

  // Profile & Collapsible Area
  radarSectionToggle: document.getElementById('radar-section-toggle'),
  radarCollapsibleArea: document.getElementById('radar-collapsible-area'),
  radarScanCard: document.getElementById('radar-scan-card'),
  userAvatar: document.getElementById('user-avatar'),
  userName: document.getElementById('user-name'),
  userHandle: document.getElementById('user-handle'),
  statFollowing: document.getElementById('stat-following'),
  statFollowers: document.getElementById('stat-followers'),
  loginAlert: document.getElementById('login-alert'),

  // Actions & Buttons
  btnSync: document.getElementById('btn-sync'),
  btnSyncText: document.getElementById('btn-sync-text'),
  btnRadarInfo: document.getElementById('btn-radar-info'),
  radarInfoCard: document.getElementById('radar-info-card'),
  btnCloseRadarInfo: document.getElementById('btn-close-radar-info'),
  btnClear: document.getElementById('btn-clear'),
  lastSyncTime: document.getElementById('last-sync-time'),

  // Progress
  progressContainer: document.getElementById('progress-container'),
  progressBarFill: document.getElementById('progress-bar-fill'),
  progressStatusText: document.getElementById('progress-status-text'),
  progressCountdown: document.getElementById('progress-countdown'),

  // Tabs & Badges
  tabs: document.querySelectorAll('.tab-item'),
  badgeNotFollowing: document.getElementById('badge-not-following'),
  badgeFans: document.getElementById('badge-fans'),
  badgeMutuals: document.getElementById('badge-mutuals'),
  badgeTimeline: document.getElementById('badge-timeline'),

  // Content Views
  userList: document.getElementById('user-list'),
  timelineList: document.getElementById('timeline-list'),
  emptyState: document.getElementById('empty-state'),
  langSelect: document.getElementById('lang-select'),
  listContainer: document.querySelector('.list-container')
};

// Utilities
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatNumber(num) {
  if (num == null) return '0';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return String(num);
}

function formatExactCount(num) {
  const count = Number(num);
  if (!Number.isFinite(count)) return '-';
  return Math.round(count).toLocaleString('en-US');
}

function formatCountdown(sec) {
  if (sec == null || sec <= 0) return t('progress.almost');
  if (sec < 60) return t('progress.seconds', { sec });
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? t('progress.minutesSeconds', { m, s }) : t('progress.minutes', { m });
}

function formatDateTime(isoString) {
  if (!isoString) return t('sync.never');
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return t('sync.never');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${h}:${min}`;
}

// Sync Quick Filter Switches state with storage & current tab status
async function syncQuickFilterState() {
  try {
    const stored = await chrome.storage.local.get([
      'autoEnableInpageFilterOnFollowing',
      'autoEnableInpageFilterOnFollowers'
    ]);

    if (elements.switchNoBackMe) {
      elements.switchNoBackMe.checked = Boolean(stored.autoEnableInpageFilterOnFollowing);
    }
    if (elements.switchINoBack) {
      elements.switchINoBack.checked = Boolean(stored.autoEnableInpageFilterOnFollowers);
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && tab.url && (tab.url.includes('x.com') || tab.url.includes('twitter.com'))) {
      chrome.tabs.sendMessage(tab.id, { action: 'GET_INPAGE_FILTER_STATUS' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        if (res.isFollowingPage && elements.switchNoBackMe) {
          elements.switchNoBackMe.checked = Boolean(res.isFollowingFilterActive);
        } else if (res.isFollowersPage && elements.switchINoBack) {
          elements.switchINoBack.checked = Boolean(res.isFollowersFilterActive);
        }
      });
    }
  } catch (e) {
    console.error('Failed to sync filter state:', e);
  }
}

// Handle "只看未回关我" Switch Toggle (Only toggles filter on/off, does not navigate)
async function onSwitchNoBackMeChange(e) {
  const enable = e.target.checked;
  await chrome.storage.local.set({ autoEnableInpageFilterOnFollowing: enable });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'TOGGLE_INPAGE_FILTER',
        target: 'following',
        enable
      });
    }
  } catch (err) {}
}

// Handle "只看我未回关" Switch Toggle (Only toggles filter on/off, does not navigate)
async function onSwitchINoBackChange(e) {
  const enable = e.target.checked;
  await chrome.storage.local.set({ autoEnableInpageFilterOnFollowers: enable });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'TOGGLE_INPAGE_FILTER',
        target: 'followers',
        enable
      });
    }
  } catch (err) {}
}

// Handle "只看未回关我" Label Click (Navigates to /following, stays if already there)
async function onGotoFollowingClick() {
  let screenName = state.profile?.screen_name || '';
  if (!screenName) {
    const stored = await chrome.storage.local.get(['xradar_user_screen_name', 'xradar_profile']);
    screenName = stored.xradar_user_screen_name || stored.xradar_profile?.screen_name || '';
  }

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url) {
      const parsed = new URL(activeTab.url);
      const isX = parsed.hostname.includes('x.com') || parsed.hostname.includes('twitter.com');
      if (isX) {
        const path = parsed.pathname.toLowerCase();
        const isAlreadyFollowing = screenName
          ? path === `/${screenName.toLowerCase()}/following`
          : /\/[a-zA-Z0-9_]+\/following/i.test(path);

        if (isAlreadyFollowing) {
          // 当前已经在对应页面了，保持当前页面不用再跳
          return;
        }
      }
    }

    await chrome.runtime.sendMessage({
      action: 'OPEN_FOLLOWING_FILTER_PAGE',
      payload: { screenName }
    });
  } catch (err) {
    const targetUrl = screenName ? `https://x.com/${screenName}/following` : 'https://x.com/following';
    window.open(targetUrl, '_blank');
  }
}

// Handle "只看我未回关" Label Click (Navigates to /followers, stays if already there)
async function onGotoFollowersClick() {
  let screenName = state.profile?.screen_name || '';
  if (!screenName) {
    const stored = await chrome.storage.local.get(['xradar_user_screen_name', 'xradar_profile']);
    screenName = stored.xradar_user_screen_name || stored.xradar_profile?.screen_name || '';
  }

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url) {
      const parsed = new URL(activeTab.url);
      const isX = parsed.hostname.includes('x.com') || parsed.hostname.includes('twitter.com');
      if (isX) {
        const path = parsed.pathname.toLowerCase();
        const isAlreadyFollowers = screenName
          ? (path === `/${screenName.toLowerCase()}/followers` || path === `/${screenName.toLowerCase()}/verified_followers`)
          : /\/[a-zA-Z0-9_]+\/(verified_followers|followers)/i.test(path);

        if (isAlreadyFollowers) {
          // 当前已经在对应页面了，保持当前页面不用再跳
          return;
        }
      }
    }

    await chrome.runtime.sendMessage({
      action: 'OPEN_FOLLOWERS_FILTER_PAGE',
      payload: { screenName }
    });
  } catch (err) {
    const targetUrl = screenName ? `https://x.com/${screenName}/followers` : 'https://x.com/followers';
    window.open(targetUrl, '_blank');
  }
}

// Toggle/Set Radar Collapsible Section State (Folds/unfolds everything below the divider)
const SCAN_SECTION_KEY = 'xradar_scan_section_collapsed';

function setRadarCollapseState(collapsed, persist = false) {
  if (!elements.radarCollapsibleArea) return;
  if (collapsed) {
    elements.radarCollapsibleArea.style.display = 'none';
    elements.radarCollapsibleArea.classList.add('is-collapsed');
    elements.radarSectionToggle?.classList.remove('is-expanded');
    document.body.classList.add('is-radar-collapsed');
    document.body.classList.remove('is-radar-expanded');
  } else {
    elements.radarCollapsibleArea.style.display = 'flex';
    elements.radarCollapsibleArea.classList.remove('is-collapsed');
    elements.radarSectionToggle?.classList.add('is-expanded');
    document.body.classList.remove('is-radar-collapsed');
    document.body.classList.add('is-radar-expanded');
  }
  if (persist) {
    chrome.storage.local.set({ [SCAN_SECTION_KEY]: collapsed }).catch(() => {});
  }
}

async function restoreRadarCollapseState() {
  try {
    const stored = await chrome.storage.local.get(SCAN_SECTION_KEY);
    if (typeof stored[SCAN_SECTION_KEY] === 'boolean') {
      setRadarCollapseState(stored[SCAN_SECTION_KEY]);
      return;
    }
  } catch (e) {
    // Keep the default folded state.
  }
  setRadarCollapseState(true);
}

// Initialize Popup
async function init() {
  const isSide = isSidePanelView();
  document.documentElement.classList.remove('mode-sidepanel', 'mode-popup');
  document.documentElement.classList.add(isSide ? 'mode-sidepanel' : 'mode-popup');

  await restoreRadarCollapseState();
  await setupLanguage();

  bindEvents();
  await loadStatus();
  await loadData();
  await syncQuickFilterState();
}

// Bind Event Listeners
function fillLanguageSelect() {
  if (!elements.langSelect) return;
  elements.langSelect.setAttribute('aria-label', t('lang.label'));
  elements.langSelect.innerHTML = LOCALES.map((item) => (
    `<option value="${item.id}">${item.label}</option>`
  )).join('');
  elements.langSelect.value = getLocale();
}

async function setupLanguage() {
  await loadLocale();
  fillLanguageSelect();
  applyStaticText();
  if (elements.userName) elements.userName.textContent = t('profile.loading');
  refreshLocalizedChrome();
}

function isSidePanelView() {
  const view = new URLSearchParams(window.location.search).get('view');
  if (view === 'popup') return false;
  if (view === 'sidepanel') return true;
  return window.innerWidth > 0 && window.innerWidth !== 480;
}

function refreshLocalizedChrome() {
  const isSide = isSidePanelView();
  const modeBadge = document.getElementById('display-mode-badge');
  if (modeBadge) {
    const canSwitch = sidePanelSupported();
    modeBadge.classList.toggle('is-available', canSwitch);
    modeBadge.hidden = !canSwitch;
    const modeLabel = document.getElementById('mode-label');
    const modeHoverLabel = document.getElementById('mode-hover-label');
    if (modeLabel) modeLabel.textContent = isSide ? t('mode.side') : t('mode.popup');
    if (modeHoverLabel) modeHoverLabel.textContent = isSide ? t('mode.switchToPopup') : t('mode.switchToSide');
  }

  if (elements.lastSyncTime) {
    elements.lastSyncTime.textContent = state.lastSyncTime
      ? t('sync.last', { time: formatDateTime(state.lastSyncTime) })
      : t('sync.never');
  }

  if (!state.isSyncing) setScanButton('idle');
  if (state.progress) updateSyncProgressUI(state.progress);
}

async function switchDisplayMode() {
  if (!sidePanelSupported()) return;
  const next = isSidePanelView() ? 'popup' : 'sidepanel';
  const applied = await saveAndApplyDisplayMode(next);
  if (applied === 'popup') {
    try {
      await chrome.action.openPopup();
    } catch (e) {
      // The next toolbar click still opens the popup.
    }
    window.close();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (e) {
      // The next toolbar click still opens the side panel.
    }
  }
  window.close();
}

function bindEvents() {
  document.getElementById('display-mode-badge')?.addEventListener('click', () => {
    switchDisplayMode().catch((err) => console.error(err));
  });

  elements.listContainer?.addEventListener('scroll', () => {
    const el = elements.listContainer;
    if (!el || el.scrollTop + el.clientHeight < el.scrollHeight - 48) return;
    const total = state.currentTab === 'timeline'
      ? (state.timeline || []).length
      : (state.data[state.currentTab] || []).length;
    if (state.visibleCount >= total) return;
    state.visibleCount += 60;
    renderActiveTabContent();
  });

  elements.langSelect?.addEventListener('change', async () => {
    await setLocale(elements.langSelect.value);
    applyStaticText();
    refreshLocalizedChrome();
    if (state.profile) renderProfile(state.profile);
    renderActiveTabContent();
  });

  // Quick Filter switches (Dual: 只看未回关我 & 只看我未回关 - 仅开启/关闭过滤)
  elements.switchNoBackMe?.addEventListener('change', onSwitchNoBackMeChange);
  elements.switchINoBack?.addEventListener('change', onSwitchINoBackChange);

  // Quick Filter labels (点击文字跳转到对应页面，若已在当前页面则不跳)
  elements.labelNoBackMe?.addEventListener('click', onGotoFollowingClick);
  elements.labelINoBack?.addEventListener('click', onGotoFollowersClick);

  // Collapsible Radar Section (Folds/unfolds everything below the divider)
  elements.radarSectionToggle?.addEventListener('click', (e) => {
    if (e.target.closest('#btn-clear')) return;
    if (!elements.radarCollapsibleArea) return;
    const isCollapsed = elements.radarCollapsibleArea.classList.contains('is-collapsed') ||
                        elements.radarCollapsibleArea.style.display === 'none';
    setRadarCollapseState(!isCollapsed, true);
  });

  // Sync button
  elements.btnSync?.addEventListener('click', async () => {
    if (state.isSyncing) {
      await cancelSync();
      return;
    }
    if (elements.btnSync?.dataset.blocked === '1') return;
    await startSync();
  });

  // Toggle Radar Info Card
  elements.btnRadarInfo?.addEventListener('click', () => {
    if (!elements.radarInfoCard) return;
    const isHidden = elements.radarInfoCard.style.display === 'none';
    elements.radarInfoCard.style.display = isHidden ? 'block' : 'none';
    elements.btnRadarInfo.classList.toggle('is-active', isHidden);
  });

  // Close Radar Info Card
  elements.btnCloseRadarInfo?.addEventListener('click', () => {
    if (!elements.radarInfoCard) return;
    elements.radarInfoCard.style.display = 'none';
    elements.btnRadarInfo?.classList.remove('is-active');
  });

  // Clear data button
  elements.btnClear?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(t('confirm.clear'))) {
      await chrome.runtime.sendMessage({ action: 'CLEAR_DATA' });
      await loadData();
      await loadStatus();
    }
  });

  // Tabs switching
  elements.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      switchTab(tabName);
    });
  });

  // Search input


  // Listen for broadcast messages from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SYNC_PROGRESS_UPDATE') {
      updateSyncProgressUI(message.progress);
      if (message.progress.stage === 'done') {
        loadStatus();
        loadData();
      }
    }

    if (message.type === 'DATA_UPDATED_REALTIME') {
      const { updatedData, profile, timeline } = message.payload || {};
      if (updatedData) state.data = updatedData;
      if (profile) {
        state.profile = profile;
        renderProfile(profile);
      }
      if (timeline) state.timeline = timeline;
      updateBadges();
      renderActiveTabContent();
    }
  });
}

// Load current status & credentials
async function loadStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });

    // Show/hide login alert
    if (elements.loginAlert) {
      elements.loginAlert.style.display = status.isLoggedIn ? 'none' : 'flex';
    }
    if (elements.btnSync) {
      elements.btnSync.dataset.blocked = status.isLoggedIn ? '0' : '1';
      if (!state.isSyncing) setScanButton('idle');
    }

    const domCounts = await chrome.storage.local.get([
      'xradar_user_following_count',
      'xradar_user_followers_count'
    ]);
    if (domCounts.xradar_user_following_count) state.domFollowing = domCounts.xradar_user_following_count;
    if (domCounts.xradar_user_followers_count) state.domFollowers = domCounts.xradar_user_followers_count;

    if (status.overview && status.overview.profile) {
      state.profile = status.overview.profile;
      renderProfile(state.profile);
    } else {
      // Check stored screen name from DOM detection
      chrome.storage.local.get([
        'xradar_user_screen_name',
        'xradar_user_name',
        'xradar_user_avatar',
        'xradar_user_following_count',
        'xradar_user_followers_count'
      ], (res) => {
        if (res.xradar_user_following_count) state.domFollowing = res.xradar_user_following_count;
        if (res.xradar_user_followers_count) state.domFollowers = res.xradar_user_followers_count;
        updateScanVisibility();
        if (res.xradar_user_screen_name) {
          if (elements.userHandle) elements.userHandle.textContent = `@${res.xradar_user_screen_name}`;
          if (res.xradar_user_name && elements.userName) elements.userName.textContent = res.xradar_user_name;
          if (res.xradar_user_avatar && elements.userAvatar) {
            elements.userAvatar.src = res.xradar_user_avatar;
            elements.userAvatar.style.display = 'block';
          }
          if (res.xradar_user_following_count && elements.statFollowing) {
            elements.statFollowing.textContent = formatExactCount(res.xradar_user_following_count);
          }
          if (res.xradar_user_followers_count && elements.statFollowers) {
            elements.statFollowers.textContent = formatExactCount(res.xradar_user_followers_count);
          }
        }
      });
    }

    if (status.overview && status.overview.lastSyncTime) {
      state.lastSyncTime = status.overview.lastSyncTime;
      if (elements.lastSyncTime) {
        elements.lastSyncTime.textContent = t('sync.last', { time: formatDateTime(status.overview.lastSyncTime) });
      }
    }

    if (status.syncProgress) {
      updateSyncProgressUI(status.syncProgress);
    }
  } catch (err) {
    console.error('Failed to load status:', err);
  }
}

// Load stored analyzed data
async function loadData() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_DATA' });
    if (res && res.success && res.data) {
      state.profile = res.data.profile || state.profile;
      state.data = res.data.data || state.data;
      state.timeline = res.data.timeline || [];

      if (state.profile) {
        if (!state.profile.following_count && state.data?.followingList?.length) {
          state.profile.following_count = state.data.followingList.length;
        }
        if (!state.profile.followers_count && state.data?.followersList?.length) {
          state.profile.followers_count = state.data.followersList.length;
        }
        renderProfile(state.profile);
      }

      updateBadges();
      renderActiveTabContent();
    }
  } catch (err) {
    console.error('Failed to load data:', err);
  }
}

// Render User Profile Section
const SCAN_ACCOUNT_LIMIT = 10000;

function positiveCount(...values) {
  const counts = values.map(Number).filter(n => Number.isFinite(n) && n > 0);
  return counts.length ? Math.max(...counts) : null;
}

function scanExceedsLimit() {
  const following = positiveCount(state.profile?.following_count, state.domFollowing);
  const followers = positiveCount(state.profile?.followers_count, state.domFollowers);
  if (following == null && followers == null) return false;
  return (following || 0) + (followers || 0) > SCAN_ACCOUNT_LIMIT;
}

function updateScanVisibility() {
  const hide = scanExceedsLimit();
  const toggle = document.getElementById('radar-section-toggle');
  if (toggle) toggle.hidden = hide;
  if (!elements.radarCollapsibleArea) return;
  if (hide) {
    elements.radarCollapsibleArea.style.display = 'none';
    return;
  }
  const collapsed = elements.radarCollapsibleArea.classList.contains('is-collapsed');
  setRadarCollapseState(collapsed);
}

function renderProfile(profile) {
  if (!profile) return;

  if (elements.userName) {
    elements.userName.textContent = profile.name || profile.screen_name || t('card.fallbackName');
  }
  if (elements.userHandle) {
    elements.userHandle.textContent = profile.screen_name ? `@${profile.screen_name}` : '@...';
  }
  if (elements.userAvatar) {
    if (profile.avatar) {
      elements.userAvatar.src = profile.avatar;
      elements.userAvatar.style.display = 'block';
    } else {
      elements.userAvatar.style.display = 'none';
    }
  }

  const followingCount = Number(profile.following_count) || 0;
  const followersCount = Number(profile.followers_count) || 0;

  if (elements.statFollowing) {
    elements.statFollowing.textContent = followingCount > 0 ? formatExactCount(followingCount) : (profile.following_count != null ? '0' : '-');
  }
  if (elements.statFollowers) {
    elements.statFollowers.textContent = followersCount > 0 ? formatExactCount(followersCount) : (profile.followers_count != null ? '0' : '-');
  }
  updateScanVisibility();
}

// Update Badges on Tabs
function updateBadges() {
  const { notFollowingBack, fansNotFollowed, mutuals } = state.data;

  if (elements.badgeNotFollowing) {
    elements.badgeNotFollowing.textContent = formatNumber(notFollowingBack?.length || 0);
  }
  if (elements.badgeFans) {
    elements.badgeFans.textContent = formatNumber(fansNotFollowed?.length || 0);
  }
  if (elements.badgeMutuals) {
    elements.badgeMutuals.textContent = formatNumber(mutuals?.length || 0);
  }
  if (elements.badgeTimeline) {
    elements.badgeTimeline.textContent = formatNumber(state.timeline?.length || 0);
  }
}

// Switch Active Tab
function switchTab(tabName) {
  state.currentTab = tabName;
  state.visibleCount = 60;

  elements.tabs.forEach(tab => {
    if (tab.dataset.tab === tabName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  updateBadges();
  renderActiveTabContent();
}

// Start Radar Scan
function setScanButton(mode) {
  const btn = elements.btnSync;
  if (!btn) return;
  const cancelling = mode === 'cancelling';
  const cancel = mode === 'cancel' || cancelling;
  btn.classList.toggle('is-cancel', cancel);
  btn.disabled = mode === 'starting' || cancelling || (!cancel && btn.dataset.blocked === '1');
  if (elements.btnSyncText) {
    elements.btnSyncText.textContent = t(
      mode === 'starting' ? 'action.starting'
        : cancelling ? 'action.cancelling'
        : cancel ? 'action.cancel'
        : 'action.scan'
    );
  }
}

async function cancelSync() {
  state.cancelRequested = true;
  setScanButton('cancelling');
  try {
    await chrome.runtime.sendMessage({ action: 'CANCEL_SYNC' });
  } catch (e) {
    console.error(e);
  }
}

async function startSync() {
  try {
    state.cancelRequested = false;
    setScanButton('starting');

    const res = await chrome.runtime.sendMessage({ action: 'START_SYNC' });
    if (!res.success) {
      alert(t('alert.scanFailed', { error: translateError(res.error) }));
    }
  } catch (err) {
    alert(t('alert.scanError', { error: translateError(err.message) }));
    updateSyncProgressUI({
      isSyncing: false,
      stage: 'error',
      message: err.message,
      error: err.message
    });
  } finally {
    state.cancelRequested = false;
    setScanButton('idle');
  }
}

// Update Sync Progress Bar & Overall Countdown
function syncStatusText(progress) {
  const loaded = formatExactCount(progress.loadedCount || 0);
  const total = progress.totalEstimate ? formatExactCount(progress.totalEstimate) : t('progress.many');
  switch (progress.stage) {
    case 'init': return t('progress.checking');
    case 'profile': return t('progress.profile');
    case 'following': return t('progress.following', { loaded, total });
    case 'followers': return t('progress.followers', { loaded, total });
    case 'analyzing': return t('progress.analyzing');
    case 'done': return t('progress.done');
    case 'cancelled': return t('progress.cancelled');
    case 'error': return translateError(progress.message || progress.error);
    default: return progress.message || t('progress.scanning');
  }
}

function updateSyncProgressUI(progress) {
  if (!progress) return;
  state.progress = progress;
  state.isSyncing = progress.isSyncing;

  if (progress.isSyncing) {
    setRadarCollapseState(false, true);

    elements.progressContainer.style.display = 'block';
    setScanButton(state.cancelRequested ? 'cancelling' : 'cancel');

    elements.progressStatusText.textContent = syncStatusText(progress);

    // Update overall countdown timer
    if (elements.progressCountdown) {
      elements.progressCountdown.style.display = 'inline-block';
      if (progress.estimatedRemainingSec != null && progress.estimatedRemainingSec > 0) {
        if (!state.secRemaining || Math.abs(state.secRemaining - progress.estimatedRemainingSec) > 3) {
          state.secRemaining = progress.estimatedRemainingSec;
        }
        elements.progressCountdown.textContent = t('progress.remaining', { time: formatCountdown(state.secRemaining) });
      }

      if (!state.countdownInterval) {
        state.countdownInterval = setInterval(() => {
          if (state.secRemaining > 1) {
            state.secRemaining--;
            elements.progressCountdown.textContent = t('progress.remaining', { time: formatCountdown(state.secRemaining) });
          } else if (state.secRemaining === 1) {
            elements.progressCountdown.textContent = t('progress.almost');
          }
        }, 1000);
      }
    }

    // Calculate approximate percent
    const totalAll = (progress.overallFollowingTotal || 0) + (progress.overallFollowersTotal || 0);
    let percent = 10;
    if (totalAll > 0) {
      const overallLoaded = (progress.stage === 'following') ? progress.loadedCount : (progress.overallFollowingTotal || 0) + progress.loadedCount;
      percent = Math.min(95, Math.max(10, Math.round((overallLoaded / totalAll) * 95)));
    } else {
      if (progress.stage === 'following') percent = 35;
      else if (progress.stage === 'followers') percent = 75;
      else if (progress.stage === 'analyzing') percent = 95;
    }
    elements.progressBarFill.style.width = `${percent}%`;
  } else {
    // Clear countdown interval
    if (state.countdownInterval) {
      clearInterval(state.countdownInterval);
      state.countdownInterval = null;
    }
    if (elements.progressCountdown) {
      elements.progressCountdown.style.display = 'none';
    }

    state.cancelRequested = false;
    setScanButton('idle');
    elements.progressBarFill.style.width = '100%';

    setTimeout(() => {
      if (!state.isSyncing) {
        elements.progressContainer.style.display = 'none';
      }
    }, 1200);
  }
}

// Render Content for Currently Selected Tab
function renderActiveTabContent() {
  if (state.currentTab === 'timeline') {
    elements.userList.style.display = 'none';
    elements.timelineList.style.display = 'flex';
    elements.timelineList.style.flexDirection = 'column';
    renderTimeline();
  } else {
    elements.userList.style.display = 'flex';
    elements.userList.style.flexDirection = 'column';
    elements.timelineList.style.display = 'none';
    renderUserCards();
  }
}

// Render User Cards
function renderUserCards() {
  const list = state.data[state.currentTab] || [];

  // Handle empty data state
  if (list.length === 0) {
    elements.userList.innerHTML = '';
    elements.emptyState.style.display = 'flex';
    const tabNames = {
      notFollowingBack: t('empty.notFollowingBackTitle'),
      fansNotFollowed: t('empty.fansTitle'),
      mutuals: t('empty.mutualsTitle')
    };
    elements.emptyState.querySelector('.empty-title').textContent = tabNames[state.currentTab] || t('empty.noData');
    elements.emptyState.querySelector('.empty-desc').textContent = t('empty.scanHint');
    return;
  }

  elements.emptyState.style.display = 'none';

  // Render cards
  const fragment = document.createDocumentFragment();
  const shown = list.slice(0, state.visibleCount);

  shown.forEach(user => {
    const card = document.createElement('div');
    card.className = 'user-card';

    let pillHtml = '';
    if (state.currentTab === 'notFollowingBack') {
      pillHtml = `<span class="meta-pill pill-red">${escapeHtml(t('card.notFollowing'))}</span>`;
    } else if (state.currentTab === 'fansNotFollowed') {
      pillHtml = `<span class="meta-pill pill-blue">${escapeHtml(t('card.fan'))}</span>`;
    } else if (state.currentTab === 'mutuals') {
      pillHtml = `<span class="meta-pill pill-green">${escapeHtml(t('card.mutual'))}</span>`;
    }

    const avatarUrl = user.avatar || '../icons/icon48.png';
    const rawScreenName = (user.screen_name || '').trim();
    const displayName = user.name || rawScreenName || t('card.fallbackName');
    const handleDisplay = rawScreenName ? `@${rawScreenName}` : (user.id ? `ID: ${user.id}` : t('card.unknownHandle'));

    // Safe profile URL (never defaults to raw https://x.com homepage)
    let profileUrl = 'https://x.com/home';
    if (rawScreenName) {
      profileUrl = `https://x.com/${encodeURIComponent(rawScreenName)}`;
    } else if (user.id) {
      profileUrl = `https://x.com/i/user/${encodeURIComponent(user.id)}`;
    }

    card.innerHTML = `
      <a href="${profileUrl}" target="_blank" rel="noopener noreferrer">
        <img class="card-avatar" src="${avatarUrl}" alt="${escapeHtml(displayName)}" loading="lazy" />
      </a>
      <div class="card-body">
        <div class="card-title-row">
          <div class="card-names">
            <span class="card-name">${escapeHtml(displayName)}</span>
            <span class="card-handle">${escapeHtml(handleDisplay)}</span>
          </div>
          <a href="${profileUrl}" target="_blank" rel="noopener noreferrer" class="card-btn-link">${escapeHtml(t('card.profile'))} ↗</a>
        </div>
        ${user.description ? `<p class="card-bio">${escapeHtml(user.description)}</p>` : ''}
        <div class="card-meta-row">
          ${pillHtml}
          ${user.followers_count != null && user.followers_count > 0 ? `<span>${escapeHtml(t('card.followers'))}: <b>${formatNumber(user.followers_count)}</b></span>` : ''}
          ${user.following_count != null && user.following_count > 0 ? `<span>${escapeHtml(t('card.following'))}: <b>${formatNumber(user.following_count)}</b></span>` : ''}
        </div>
      </div>
    `;

    fragment.appendChild(card);
  });

  if (shown.length < list.length) {
    const more = document.createElement('div');
    more.className = 'list-more';
    more.textContent = t('list.shown', { shown: shown.length, total: list.length });
    fragment.appendChild(more);
  }

  elements.userList.innerHTML = '';
  elements.userList.appendChild(fragment);
}

// Render Timeline Events
function renderTimeline() {
  const events = state.timeline || [];

  if (events.length === 0) {
    elements.timelineList.innerHTML = '';
    elements.emptyState.style.display = 'flex';
    elements.emptyState.querySelector('.empty-title').textContent = t('empty.timelineTitle');
    elements.emptyState.querySelector('.empty-desc').textContent = t('empty.timelineDesc');
    return;
  }

  elements.emptyState.style.display = 'none';

  const fragment = document.createDocumentFragment();

  events.slice(0, state.visibleCount).forEach(evt => {
    const card = document.createElement('div');
    card.className = 'user-card';

    let tagClass = 'pill-red';
    let tagText = t('timeline.unfollowed');
    const rawScreenName = (evt.user?.screen_name || '').trim();
    const handle = rawScreenName || t('card.unknownUser');
    let description = evt.description || '';

    if (evt.type === 'followed_me') {
      tagClass = 'pill-green';
      tagText = t('timeline.followed');
      description = t('timeline.followedDesc', { handle });
    } else if (evt.type === 'unfollowed_me') {
      tagClass = 'pill-red';
      tagText = t('timeline.unfollowed');
      description = t('timeline.unfollowedDesc', { handle });
    } else if (evt.type === 'i_unfollowed') {
      tagClass = 'pill-red';
      tagText = t('timeline.iUnfollowed');
      description = t('timeline.iUnfollowedDesc', { handle });
    } else if (evt.type === 'i_followed_back') {
      tagClass = 'pill-green';
      tagText = t('timeline.iFollowedBack');
      description = t('timeline.iFollowedBackDesc', { handle });
    } else if (evt.type === 'i_followed') {
      tagClass = 'pill-blue';
      tagText = t('timeline.iFollowed');
      description = t('timeline.iFollowedDesc', { handle });
    } else if (evt.type === 'baseline_created') {
      tagClass = 'pill-blue';
      tagText = t('timeline.baselineTitle');
      const nums = String(evt.description || '').match(/\d+/g);
      description = nums && nums.length >= 2
        ? t('timeline.baselineDesc', { following: nums[0], followers: nums[1] })
        : t('timeline.baselineDescShort');
    }

    const timeStr = formatDateTime(evt.timestamp);
    const displayName = evt.user?.name || (rawScreenName ? `@${rawScreenName}` : t('card.unknownUser'));
    const avatarUrl = evt.user?.avatar || '../icons/icon48.png';
    const handleDisplay = rawScreenName ? `@${rawScreenName}` : (evt.user?.id ? `ID: ${evt.user.id}` : t('card.unknownHandle'));

    let profileUrl = 'https://x.com/home';
    if (rawScreenName) {
      profileUrl = `https://x.com/${encodeURIComponent(rawScreenName)}`;
    } else if (evt.user?.id) {
      profileUrl = `https://x.com/i/user/${encodeURIComponent(evt.user.id)}`;
    }

    card.innerHTML = `
      <a href="${profileUrl}" target="_blank" rel="noopener noreferrer">
        <img class="card-avatar" src="${avatarUrl}" alt="${escapeHtml(displayName)}" loading="lazy" />
      </a>
      <div class="card-body">
        <div class="card-title-row">
          <div class="card-names">
            <span class="card-name">${escapeHtml(displayName)}</span>
            <span class="card-handle">${escapeHtml(handleDisplay)}</span>
          </div>
          <a href="${profileUrl}" target="_blank" rel="noopener noreferrer" class="card-btn-link">${escapeHtml(t('card.profile'))} ↗</a>
        </div>
        ${description ? `<p class="card-bio">${escapeHtml(description)}</p>` : ''}
        <div class="card-meta-row">
          <span class="meta-pill ${tagClass}">${escapeHtml(tagText)}</span>
          <span>${escapeHtml(t('card.time'))}: <b>${timeStr}</b></span>
        </div>
      </div>
    `;

    fragment.appendChild(card);
  });

  if (state.visibleCount < events.length) {
    const more = document.createElement('div');
    more.className = 'list-more';
    more.textContent = t('list.shown', { shown: Math.min(state.visibleCount, events.length), total: events.length });
    fragment.appendChild(more);
  }

  elements.timelineList.innerHTML = '';
  elements.timelineList.appendChild(fragment);
}

// Start application
document.addEventListener('DOMContentLoaded', init);
