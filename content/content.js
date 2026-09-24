// content/content.js - Content Script for X Radar on x.com

(function() {
  console.log('[X Radar] Content script loaded on', window.location.hostname);

  function parseStatNumber(str) {
    if (!str) return null;
    const clean = str.replace(/,/g, '').trim().toUpperCase();
    const m = clean.match(/^([\d\.]+)\s*([KM]?)$/);
    if (!m) {
      const val = parseInt(clean, 10);
      return isNaN(val) ? null : val;
    }
    const num = parseFloat(m[1]);
    const unit = m[2];
    if (unit === 'M') return Math.round(num * 1000000);
    if (unit === 'K') return Math.round(num * 1000);
    return Math.round(num);
  }

  // ==========================================
  // Part 1: Auto-Detect Current Logged-In User Profile from Page DOM
  // ==========================================
  let loggedInScreenName = '';

  function isOwnFollowersPage() {
    if (!loggedInScreenName) return false;
    const name = loggedInScreenName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^/${name}/(verified_followers|followers)/?$`, 'i').test(window.location.pathname);
  }

  function isSingleProfilePage() {
    const match = window.location.pathname.match(/^\/([A-Za-z0-9_]+)\/?$/);
    if (!match) return false;
    return !['home', 'explore', 'notifications', 'messages', 'i', 'settings'].includes(match[1]);
  }

  function detectCurrentUserFromDom() {
    try {
      // 1. Profile link in left sidebar navigation: href="/<screen_name>"
      const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      let screenName = '';
      if (profileLink) {
        const href = profileLink.getAttribute('href') || '';
        const match = href.match(/^\/([a-zA-Z0-9_]+)$/);
        if (match && match[1] && match[1] !== 'home' && match[1] !== 'explore' && match[1] !== 'notifications') {
          screenName = match[1];
        }
      }

      // 2. Account switcher in bottom-left
      let name = '';
      let avatar = '';
      const accountSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (accountSwitcher) {
        const avatarImg = accountSwitcher.querySelector('img');
        if (avatarImg && avatarImg.src) {
          avatar = avatarImg.src.replace('_normal', '_200x200');
        }

        // Search text for @handle and name
        const textNodes = accountSwitcher.innerText.split('\n').filter(Boolean);
        for (const t of textNodes) {
          if (t.startsWith('@') && !screenName) {
            screenName = t.replace('@', '').trim();
          } else if (!t.startsWith('@') && !name) {
            name = t.trim();
          }
        }
      }

      // 3. Detect following and followers counts from profile links if available
      let followingCount = null;
      let followersCount = null;

      if (screenName) {
        const followingLinks = document.querySelectorAll(`a[href="/${screenName}/following"], a[href$="/following"]`);
        for (const link of followingLinks) {
          const spans = link.querySelectorAll('span');
          for (const s of spans) {
            const txt = s.innerText.trim();
            if (/^[\d\.,]+[KMkm]?$/.test(txt)) {
              const parsed = parseStatNumber(txt);
              if (parsed != null) {
                followingCount = parsed;
                break;
              }
            }
          }
          if (followingCount != null) break;
        }

        const followersLinks = document.querySelectorAll(`a[href="/${screenName}/verified_followers"], a[href="/${screenName}/followers"], a[href$="/verified_followers"], a[href$="/followers"]`);
        for (const link of followersLinks) {
          const spans = link.querySelectorAll('span');
          for (const s of spans) {
            const txt = s.innerText.trim();
            if (/^[\d\.,]+[KMkm]?$/.test(txt)) {
              const parsed = parseStatNumber(txt);
              if (parsed != null) {
                followersCount = parsed;
                break;
              }
            }
          }
          if (followersCount != null) break;
        }
      }

      if (screenName) {
        loggedInScreenName = screenName;
        chrome.storage.local.set({
          xradar_user_screen_name: screenName,
          ...(name ? { xradar_user_name: name } : {}),
          ...(avatar ? { xradar_user_avatar: avatar } : {}),
          ...(followingCount != null ? { xradar_user_following_count: followingCount } : {}),
          ...(followersCount != null ? { xradar_user_followers_count: followersCount } : {})
        });
      }
    } catch (e) {
      // silent
    }
  }

  chrome.storage.local.get('xradar_user_screen_name', (res) => {
    if (res?.xradar_user_screen_name) loggedInScreenName = res.xradar_user_screen_name;
  });

  // Periodic DOM profile check
  setTimeout(detectCurrentUserFromDom, 1500);
  setInterval(detectCurrentUserFromDom, 5000);

  // ==========================================
  // Part 2: Passive GraphQL Query ID Discovery
  // ==========================================
  function detectGraphQLFromResources() {
    try {
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        if (entry.name && entry.name.includes('/i/api/graphql/')) {
          const match = entry.name.match(/\/i\/api\/graphql\/([a-zA-Z0-9_-]+)\/(Following|Followers|UserByRestId|UserByScreenName)/);
          if (match) {
            const [, queryId, operation] = match;
            chrome.storage.local.set({ [`queryId_${operation}`]: queryId });
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  setInterval(detectGraphQLFromResources, 10000);
  detectGraphQLFromResources();

  // ==========================================
  // Part 3: In-Page Native "Only Show Non-Followers" Filter Engine
  // (Hides mutual followers so user only sees users who don't follow back)
  // ==========================================
  const FILTER_STYLE_ID = 'x-radar-inpage-filter-style';
  let isFollowingFilterActive = false;
  let isFollowersFilterActive = false;
  let observer = null;

  // Clean up any lingering toast element
  try {
    document.getElementById('x-radar-status-toast')?.remove();
    document.getElementById('x-radar-toast-anim')?.remove();
  } catch (e) {}

  function isFollowingPage() {
    return /\/[a-zA-Z0-9_]+\/following/i.test(window.location.pathname);
  }

  function isFollowersPage() {
    return /\/[a-zA-Z0-9_]+\/(verified_followers|followers)/i.test(window.location.pathname);
  }

  // Check if a user cell has the mutual "Follows you / 关注了你" badge
  function checkFollowsYou(cell) {
    if (!cell) return false;
    // 1. Direct native testid check
    if (cell.querySelector('[data-testid="userFollowIndicator"]')) {
      return true;
    }

    // 2. Multilingual text fallback in case testid is obscured
    const text = cell.innerText || '';
    if (
      text.includes('关注了你') ||
      text.includes('Follows you') ||
      text.includes('フォローされています') ||
      text.includes('Te sigue') ||
      text.includes('Vous suit')
    ) {
      return true;
    }

    return false;
  }

  // Check if I follow this user (Follow/Unfollow button indicator)
  function checkIFollow(cell) {
    if (cell.querySelector('[data-testid$="-unfollow"]')) {
      return true;
    }
    const buttons = cell.querySelectorAll('button, div[role="button"]');
    for (const btn of buttons) {
      const txt = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase();
      if (
        txt.includes('正在关注') ||
        txt.includes('following') ||
        txt.includes('フォロー中') ||
        txt.includes('siguiendo') ||
        txt.includes('abonné')
      ) {
        return true;
      }
    }
    return false;
  }

  function ensureFilterStyle() {
    if (!document.getElementById(FILTER_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = FILTER_STYLE_ID;
      style.textContent = `
        [data-testid="UserCell"][data-xradar-hide="1"],
        [data-testid="UserCell"][data-xradar-noback="0"],
        [data-testid="UserCell"][data-noback="0"] {
          display: none !important;
        }
      `;
      document.head.appendChild(style);
    }
  }

  function removeFilterStyleIfIdle() {
    if (!isFollowingFilterActive && !isFollowersFilterActive) {
      const style = document.getElementById(FILTER_STYLE_ID);
      if (style) style.remove();
    }
  }

  // Scan & Tag DOM User Cells
  function scanCells() {
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    let hiddenCount = 0;
    const onFollowing = isFollowingPage();
    const onFollowers = isFollowersPage();

    cells.forEach(cell => {
      let shouldHide = false;
      if (onFollowing && isFollowingFilterActive) {
        // "只看未回关我": Hide users who follow me back
        shouldHide = checkFollowsYou(cell);
      } else if (onFollowers && isFollowersFilterActive) {
        // "只看我未回关": Hide users whom I already follow back
        shouldHide = checkIFollow(cell);
      }

      if (shouldHide) {
        cell.setAttribute('data-xradar-hide', '1');
        cell.setAttribute('data-xradar-noback', '0');
        cell.setAttribute('data-noback', '0');
        hiddenCount++;
      } else {
        cell.removeAttribute('data-xradar-hide');
        cell.removeAttribute('data-xradar-noback');
        cell.removeAttribute('data-noback');
      }
    });

    return hiddenCount;
  }

  function getHiddenCount() {
    return document.querySelectorAll('[data-testid="UserCell"][data-xradar-hide="1"]').length;
  }

  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      if ((isFollowingFilterActive && isFollowingPage()) || (isFollowersFilterActive && isFollowersPage())) {
        scanCells();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Enable In-Page Filter
  function enableFilter(target = 'following') {
    if (target === 'following') {
      isFollowingFilterActive = true;
    } else if (target === 'followers') {
      isFollowersFilterActive = true;
    }
    ensureFilterStyle();
    const count = scanCells();
    setupObserver();
    return count;
  }

  // Disable In-Page Filter
  function disableFilter(target = 'following') {
    if (target === 'following') {
      isFollowingFilterActive = false;
    } else if (target === 'followers') {
      isFollowersFilterActive = false;
    } else {
      isFollowingFilterActive = false;
      isFollowersFilterActive = false;
    }

    scanCells();
    removeFilterStyleIfIdle();

    if (!isFollowingFilterActive && !isFollowersFilterActive && observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // Check if we should auto-enable on following / followers page
  async function checkAutoFilter() {
    try {
      const stored = await chrome.storage.local.get([
        'autoEnableInpageFilterOnFollowing',
        'autoEnableInpageFilterOnFollowers'
      ]);

      if (isFollowingPage()) {
        if (stored.autoEnableInpageFilterOnFollowing) {
          enableFilter('following');
        } else if (isFollowingFilterActive) {
          disableFilter('following');
        }
      } else {
        if (isFollowingFilterActive) disableFilter('following');
      }

      if (isFollowersPage()) {
        if (stored.autoEnableInpageFilterOnFollowers) {
          enableFilter('followers');
        } else if (isFollowersFilterActive) {
          disableFilter('followers');
        }
      } else {
        if (isFollowersFilterActive) disableFilter('followers');
      }
    } catch (e) {}
  }

  // Monitor URL changes
  let lastPathname = window.location.pathname;
  function handleUrlChange() {
    const currentPath = window.location.pathname;
    if (currentPath === lastPathname) return;
    lastPathname = currentPath;

    detectCurrentUserFromDom();
    checkAutoFilter();
  }

  window.addEventListener('popstate', handleUrlChange);
  setInterval(handleUrlChange, 1000);
  checkAutoFilter();

  // Listen to control messages from extension popup/sidepanel
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'GET_INPAGE_FILTER_STATUS') {
      sendResponse({
        isFollowingPage: isFollowingPage(),
        isFollowersPage: isFollowersPage(),
        isFollowingFilterActive,
        isFollowersFilterActive,
        isFilterActive: isFollowingFilterActive || isFollowersFilterActive,
        hiddenCount: getHiddenCount()
      });
      return false;
    }

    if (req.action === 'TOGGLE_INPAGE_FILTER') {
      const target = req.target || (isFollowersPage() ? 'followers' : 'following');
      let count = 0;
      if (req.enable) {
        count = enableFilter(target);
      } else {
        disableFilter(target);
      }
      sendResponse({
        success: true,
        target,
        isFollowingFilterActive,
        isFollowersFilterActive,
        hiddenCount: count
      });
      return false;
    }
  });

  // ==========================================
  // Part 4: Real-time Follow & Unfollow Tracking
  // ==========================================
  let pendingUnfollowTarget = null;

  function extractUserFromCellOrPage(cell, btn) {
    let id = '';
    const testid = btn?.getAttribute('data-testid') || '';
    const idMatch = testid.match(/^(\d+)-(unfollow|follow)$/);
    if (idMatch) {
      id = idMatch[1];
    }

    let screen_name = '';
    const ariaHandle = (btn?.getAttribute('aria-label') || '').match(/@([A-Za-z0-9_]+)/);
    if (ariaHandle) screen_name = ariaHandle[1];

    // Check links in cell
    if (!screen_name && cell) {
      const links = cell.querySelectorAll('a[role="link"][href^="/"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/^\/([a-zA-Z0-9_]+)$/);
        if (match && !['home', 'explore', 'notifications', 'messages', 'i', 'settings'].includes(match[1])) {
          screen_name = match[1];
          break;
        }
      }

      // Multilingual text handle fallback
      if (!screen_name) {
        const text = cell.innerText || '';
        const handleMatch = text.match(/@([a-zA-Z0-9_]+)/);
        if (handleMatch) {
          screen_name = handleMatch[1];
        }
      }
    }

    // If on profile page header
    if (!screen_name) {
      const pathMatch = window.location.pathname.match(/^\/([a-zA-Z0-9_]+)$/);
      if (pathMatch && !['home', 'explore', 'notifications', 'messages', 'i', 'settings'].includes(pathMatch[1])) {
        screen_name = pathMatch[1];
      }
    }

    // Display Name
    let name = '';
    if (cell) {
      const lines = (cell.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        if (!line.startsWith('@') && !line.includes('关注') && !line.includes('Follow') && line.length < 50) {
          name = line;
          break;
        }
      }
    }
    if (!name) name = screen_name || 'X 用户';

    // Avatar
    let avatar = '';
    const avatarImg = cell?.querySelector('img[src*="profile_images"]');
    if (avatarImg && avatarImg.src) {
      avatar = avatarImg.src.replace('_normal', '_200x200');
    }

    return { id, screen_name, name, avatar };
  }

  function notifyRealtimeAction(type, user) {
    if (!user || (!user.id && !user.screen_name)) return;
    chrome.runtime.sendMessage({
      action: 'REALTIME_USER_ACTION',
      payload: { type, user }
    }).catch(() => {});
  }

  function isUnfollowControl(el) {
    const testid = el?.getAttribute?.('data-testid') || '';
    if (/-unfollow$/.test(testid) || testid === 'unfollow') return true;
    const label = `${el?.getAttribute?.('aria-label') || ''} ${el?.innerText || ''}`;
    return /取消关注|正在关注|Unfollow|Following|フォロー中|Siguiendo|Abonné|팔로잉/.test(label);
  }

  function isFollowControl(el) {
    if (!el || isUnfollowControl(el)) return false;
    const testid = el.getAttribute('data-testid') || '';
    if (/-follow$/.test(testid) || testid === 'follow') return true;
    const label = `${el.getAttribute('aria-label') || ''} ${el.innerText || ''}`.replace(/\s+/g, ' ').trim();
    return /(^|\s)(回关|关注|Follow|フォロー|Seguir|팔로우|Theo dõi)(\s|$)/i.test(label);
  }

  function findFollowButton(target) {
    const tagged = target.closest('[data-testid$="-follow"], [data-testid="follow"]');
    if (tagged && !isUnfollowControl(tagged)) return tagged;
    const btn = target.closest('button, [role="button"]');
    if (btn && isFollowControl(btn)) return btn;
    return null;
  }

  document.addEventListener('click', (e) => {
    // 1. Click on Unfollow button (prepares pending target)
    const cancelUnfollowBtn = e.target.closest('[data-testid="confirmationSheetCancel"]');
    if (cancelUnfollowBtn) {
      pendingUnfollowTarget = null;
      return;
    }

    const unfollowBtn = e.target.closest('[data-testid$="-unfollow"], [data-testid="unfollow"]');
    if (unfollowBtn) {
      const cell = unfollowBtn.closest('[data-testid="UserCell"]');
      const user = extractUserFromCellOrPage(cell, unfollowBtn);
      pendingUnfollowTarget = user.id || user.screen_name ? user : null;
      return;
    }

    // 2. Click confirm in Twitter's "Unfollow @user?" modal
    const confirmBtn = e.target.closest('[data-testid="confirmationSheetConfirm"]');
    if (confirmBtn && pendingUnfollowTarget) {
      notifyRealtimeAction('unfollow', pendingUnfollowTarget);
      pendingUnfollowTarget = null;
      return;
    }

    // 3. Click Follow / 回关
    const followBtn = findFollowButton(e.target);
    if (followBtn) {
      const cell = followBtn.closest('[data-testid="UserCell"]');
      const user = extractUserFromCellOrPage(cell, followBtn);
      if (!user.id && !user.screen_name) return;
      const profileIndicatesFollow = isSingleProfilePage()
        && Boolean(document.querySelector('[data-testid="userFollowIndicator"]'));
      user.followed_by = checkFollowsYou(cell) || profileIndicatesFollow || isOwnFollowersPage();
      notifyRealtimeAction('follow', user);
    }
  }, true);
})();
