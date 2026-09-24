// utils/x-api.js - Robust X (Twitter) API & GraphQL Communication Layer

export const X_CONSTANTS = {
  BEARER_TOKEN: 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',

  // Modern 2026 Query IDs with fallbacks
  QUERY_IDS: {
    Following: [
      'qGZZDF3mp91q7X22s3HxpA', // Latest 2026
      '2_chGa4hnDgvdL3k2bY0IQ',
      't-BPmETKx-IqdwhdUeao1w',
      'be-mBwUghrZ8sM0LwU0aMg',
      'iSiccAlmAi59L7fn68kI3A',
      'd98w9j1y1tHl3c7p7hP8zg'
    ],
    Followers: [
      'JNyQdTISpzCkj_1fqxDvFg', // Latest 2026
      'e36zpEZQv-FvG3pnWcG4Kg',
      'pdNDbtARwKvdvupz3ypCVQ',
      'b92_eXG7k9p_C479WdEwgg',
      '3-bO4wV_l_e2hF6zVqJk8A'
    ],
    UserByRestId: [
      'xvmVfRLmnr1alc5f2dib0Q', // Latest 2026
      'GazOglcBvgLigl3ywt6b3Q',
      's9w5kH2F9N0l2p_xY7g8zw'
    ],
    UserByScreenName: [
      'Gb-d6r0vxPOADdG62OEBpQ',
      'sP3-9bS9l5kF9N0l2p_xY7',
      '1Vo9yo4g7bO0Vq3f4k2'
    ]
  },

  DEFAULT_FEATURES: {
    articles_preview_enabled: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    communities_web_enable_tweet_community_results_fetch: true,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    longform_notetweets_consumption_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    responsive_web_enhance_cards_enabled: false,
    responsive_web_graphql_exclude_directive_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_grok_community_note_auto_translation_is_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: false,
    responsive_web_media_download_video_enabled: false,
    responsive_web_profile_redirect_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    rweb_video_timestamps_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_awards_web_tipping_enabled: false,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    tweet_with_visibility_results_prefer_gql_media_interstitial_enabled: false,
    tweetypie_unmention_optimization_enabled: true,
    verified_phone_label_enabled: false,
    view_counts_everywhere_api_enabled: true
  }
};

/**
 * Get all authentication cookies from x.com or twitter.com
 */
export async function getAuthCredentials() {
  const getCookiesForDomain = (domain) => {
    return new Promise((resolve) => {
      chrome.cookies.getAll({ domain }, (cookies) => {
        resolve(cookies || []);
      });
    });
  };

  const [xCookies, twitterCookies] = await Promise.all([
    getCookiesForDomain('x.com'),
    getCookiesForDomain('twitter.com')
  ]);

  const allCookies = [...xCookies, ...twitterCookies];
  let ct0 = null;
  let twid = null;
  let authToken = null;

  for (const c of allCookies) {
    if (c.name === 'ct0' && !ct0) ct0 = c.value;
    if (c.name === 'twid' && !twid) twid = c.value;
    if (c.name === 'auth_token' && !authToken) authToken = c.value;
  }

  if (!ct0) {
    return {
      isLoggedIn: false,
      error: '未检测到 X.com 登录凭证 (ct0)，请确保已在浏览器中登录 x.com'
    };
  }

  // Parse numeric user ID from twid if available
  let userId = null;
  if (twid) {
    const cleaned = decodeURIComponent(twid).replace(/^"+|"+$/g, '');
    const m = cleaned.match(/u[=:]\s*(\d+)/i) || cleaned.match(/(\d{5,})/);
    if (m) {
      userId = m[1];
    }
  }

  return {
    isLoggedIn: true,
    csrfToken: ct0,
    userId,
    authToken
  };
}

/**
 * Request headers builder
 */
function buildHeaders(csrfToken) {
  return {
    'authorization': X_CONSTANTS.BEARER_TOKEN,
    'x-csrf-token': csrfToken,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': 'zh-cn',
    'content-type': 'application/json'
  };
}

/**
 * Safely extracts normalized user data from any variant of Twitter/X GraphQL User object
 */
export function extractUserData(rawResult) {
  if (!rawResult) return null;

  let target = rawResult;
  // Handle nested objects or wrappers
  if (target.user) target = target.user;
  if (target.result) target = target.result;
  if (target.user) target = target.user;

  if (target.__typename === 'UserUnavailable') return null;

  const id = target.rest_id || target.id_str || target.id;
  const legacy = target.legacy || {};
  const core = target.core || {};
  const avatarObj = target.avatar || {};

  const screen_name =
    legacy.screen_name ||
    core.screen_name ||
    target.screen_name ||
    '';

  // If both id and screen_name are missing, it's not a valid user
  if (!id && !screen_name) return null;

  const name =
    legacy.name ||
    core.name ||
    target.name ||
    screen_name ||
    'X 用户';

  let avatar =
    legacy.profile_image_url_https ||
    core.profile_image_url_https ||
    avatarObj.image_url ||
    target.profile_image_url_https ||
    '';
  if (avatar) {
    avatar = avatar.replace('_normal', '_200x200');
  }

  const description =
    legacy.description ||
    core.description ||
    target.description ||
    '';

  const followers_count =
    legacy.followers_count ??
    legacy.normal_followers_count ??
    target.followers_count ??
    target.normal_followers_count ??
    target.relationship_counts?.followers ??
    core.followers_count ??
    null;

  const following_count =
    legacy.friends_count ??
    target.friends_count ??
    target.following_count ??
    target.relationship_counts?.following ??
    core.friends_count ??
    null;

  const following = Boolean(
    legacy.following ??
    target.following ??
    target.relationship?.following
  );

  const followed_by = Boolean(
    legacy.followed_by ??
    target.followed_by ??
    target.relationship?.followed_by
  );

  const verified = Boolean(
    target.is_blue_verified ||
    legacy.verified ||
    target.verified ||
    legacy.is_blue_verified
  );

  return {
    id: String(id || screen_name),
    name,
    screen_name,
    avatar,
    description,
    followers_count: followers_count != null ? Number(followers_count) : null,
    following_count: following_count != null ? Number(following_count) : null,
    following,
    followed_by,
    verified
  };
}

/**
 * Bulk lookup user entities via /1.1/users/lookup.json to enrich counts
 */
export async function enrichUsersWithLookup(users, credentials, maxCount = 200) {
  if (!users || users.length === 0 || !credentials?.csrfToken) return;

  const targetUsers = users.slice(0, maxCount);
  const chunks = [];
  for (let i = 0; i < targetUsers.length; i += 100) {
    chunks.push(targetUsers.slice(i, i + 100));
  }

  const mapById = new Map();
  const mapByScreenName = new Map();
  for (const u of targetUsers) {
    if (u.id) mapById.set(String(u.id), u);
    if (u.screen_name) mapByScreenName.set(u.screen_name.toLowerCase(), u);
  }

  for (const chunk of chunks) {
    const ids = chunk.map(u => u.id).filter(id => id && /^\d+$/.test(id));
    if (ids.length === 0) continue;

    try {
      const url = new URL('https://x.com/i/api/1.1/users/lookup.json');
      url.searchParams.set('user_id', ids.join(','));
      url.searchParams.set('include_entities', 'false');

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: buildHeaders(credentials.csrfToken),
        credentials: 'include'
      });

      if (res.ok) {
        const list = await res.json();
        for (const item of list) {
          const u = mapById.get(String(item.id_str)) || (item.screen_name && mapByScreenName.get(item.screen_name.toLowerCase()));
          if (u) {
            if (item.followers_count != null) u.followers_count = Number(item.followers_count);
            if (item.friends_count != null) u.following_count = Number(item.friends_count);
          }
        }
      }
    } catch (e) {
      // Lookup is best-effort enrichment, ignore errors
      break;
    }
  }
}

/**
 * Fetch current user profile using multiple strategies:
 * 1. account/settings.json (gives screen_name)
 * 2. verify_credentials.json (full profile)
 * 3. UserByRestId / UserByScreenName GraphQL
 * 4. Cache in chrome.storage.local
 */
export async function fetchCurrentUserProfile(credentials) {
  const { csrfToken } = credentials;

  // Retrieve cached screen_name or profile from DOM content script
  let storedScreenName = '';
  let storedName = '';
  let storedAvatar = '';
  try {
    const stored = await chrome.storage.local.get([
      'xradar_user_screen_name',
      'xradar_user_name',
      'xradar_user_avatar'
    ]);
    if (stored.xradar_user_screen_name) storedScreenName = stored.xradar_user_screen_name;
    if (stored.xradar_user_name) storedName = stored.xradar_user_name;
    if (stored.xradar_user_avatar) storedAvatar = stored.xradar_user_avatar;
  } catch (e) {}

  // 1. Try account/settings.json to reliably fetch screen_name
  let accountScreenName = storedScreenName;
  try {
    const settingsUrl = 'https://x.com/i/api/1.1/account/settings.json';
    const sRes = await fetch(settingsUrl, {
      method: 'GET',
      headers: buildHeaders(csrfToken),
      credentials: 'include'
    });
    if (sRes.ok) {
      const sData = await sRes.json();
      if (sData.screen_name) {
        accountScreenName = sData.screen_name;
        await chrome.storage.local.set({ xradar_user_screen_name: accountScreenName });
      }
    }
  } catch (e) {
    console.warn('[X-Radar] account/settings.json fetch error:', e);
  }

  // 2. Try verify_credentials.json (gives full account details without needing userId)
  try {
    const url = 'https://x.com/i/api/1.1/account/verify_credentials.json?include_entities=false&skip_status=true';
    const res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(csrfToken),
      credentials: 'include'
    });

    if (res.ok) {
      const data = await res.json();
      const profile = {
        id: data.id_str || credentials.userId,
        name: data.name || storedName || accountScreenName || 'X 用户',
        screen_name: data.screen_name || accountScreenName || '',
        avatar: data.profile_image_url_https?.replace('_normal', '_200x200') || storedAvatar || '',
        followers_count: data.followers_count || 0,
        following_count: data.friends_count || 0,
        description: data.description || ''
      };
      credentials.userId = profile.id;
      if (profile.screen_name) {
        await chrome.storage.local.set({ xradar_user_screen_name: profile.screen_name });
      }
      return profile;
    }
  } catch (e) {
    console.warn('[X-Radar] verify_credentials failed, trying GraphQL:', e);
  }

  // 3. Try UserByRestId GraphQL if userId exists
  if (credentials.userId) {
    try {
      const variables = { userId: credentials.userId, withSafetyModeUserFields: true };
      const res = await requestWithQueryIdFallback('UserByRestId', variables, credentials);
      const userResult = res?.data?.user?.result;
      const extracted = extractUserData(userResult);
      if (extracted) {
        if (!extracted.screen_name && accountScreenName) {
          extracted.screen_name = accountScreenName;
        }
        if (extracted.screen_name) {
          await chrome.storage.local.set({ xradar_user_screen_name: extracted.screen_name });
        }
        return extracted;
      }
    } catch (e) {
      console.warn('[X-Radar] UserByRestId GraphQL failed:', e);
    }
  }

  // 4. Try UserByScreenName GraphQL if screen_name is known
  if (accountScreenName) {
    try {
      const variables = { screen_name: accountScreenName, withSafetyModeUserFields: true };
      const res = await requestWithQueryIdFallback('UserByScreenName', variables, credentials);
      const userResult = res?.data?.user?.result;
      const extracted = extractUserData(userResult);
      if (extracted) {
        credentials.userId = extracted.id;
        return extracted;
      }
    } catch (e) {
      console.warn('[X-Radar] UserByScreenName GraphQL failed:', e);
    }
  }

  return {
    id: credentials.userId || 'me',
    name: storedName || (accountScreenName ? `@${accountScreenName}` : 'X 用户'),
    screen_name: accountScreenName || '',
    avatar: storedAvatar || '',
    followers_count: 0,
    following_count: 0,
    description: ''
  };
}

/**
 * Execute GraphQL request with automatic Query ID fallbacks
 */
async function requestWithQueryIdFallback(operationName, variables, credentials, signal = null) {
  const { csrfToken } = credentials;

  // Retrieve cached dynamically discovered queryId if present
  const cacheKey = `queryId_${operationName}`;
  const stored = await chrome.storage.local.get([cacheKey]);
  const cachedId = stored[cacheKey];

  // Candidates list: cached first, then known query IDs
  const candidates = [
    cachedId,
    ...(X_CONSTANTS.QUERY_IDS[operationName] || [])
  ].filter(Boolean);

  let lastError = null;

  for (const queryId of candidates) {
    const url = new URL(`https://x.com/i/api/graphql/${queryId}/${operationName}`);
    url.searchParams.set('variables', JSON.stringify(variables));
    url.searchParams.set('features', JSON.stringify(X_CONSTANTS.DEFAULT_FEATURES));

    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: buildHeaders(csrfToken),
        credentials: 'include',
        signal
      });

      if (res.status === 429) {
        throw new Error('RATE_LIMITED: 触发 X 访问频率限制，请等待 10~15 分钟后再试');
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error('AUTH_ERROR: 登录态失效，请刷新 x.com 重新登录');
      }

      // If 404, try next queryId candidate
      if (res.status === 404) {
        lastError = new Error(`Query ID [${queryId}] returned 404`);
        continue;
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`HTTP_${res.status}: 请求失败 (${res.statusText || bodyText})`);
      }

      // Save successful queryId to cache
      await chrome.storage.local.set({ [cacheKey]: queryId });
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError' || err.message?.includes('RATE_LIMITED') || err.message?.includes('AUTH_ERROR')) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError || new Error(`无法找到可用的 ${operationName} 接口`);
}

/**
 * Fallback to REST API /i/api/1.1/friends/list.json or /i/api/1.1/followers/list.json
 */
function stoppedShortOfTotal(loaded, expected, hasMore) {
  if (!hasMore) return false;
  if (!expected || expected <= 0) return false;
  return loaded + 20 < expected * 0.9;
}

async function fetchRelationshipListViaRest({
  type, // 'Following' or 'Followers'
  userId,
  credentials,
  delayMs,
  maxCount,
  expectedCount = 0,
  onProgress,
  signal
}) {
  const { csrfToken } = credentials;
  const endpoint = type === 'Following' ? 'friends' : 'followers';
  const allUsers = [];
  let cursor = '-1';
  let page = 0;

  while (cursor !== '0') {
    if (signal && signal.aborted) {
      throw new Error('SYNC_CANCELLED: 同步已由用户取消');
    }

    page++;
    if (onProgress) {
      onProgress({
        type,
        page,
        loadedCount: allUsers.length,
        status: `正在通过兼容接口拉取【${type === 'Following' ? '正在关注' : '粉丝列表'}】第 ${page} 页 (已获取 ${allUsers.length} 人)...`
      });
    }

    const url = new URL(`https://x.com/i/api/1.1/${endpoint}/list.json`);
    url.searchParams.set('user_id', userId);
    url.searchParams.set('count', '200');
    url.searchParams.set('cursor', cursor);
    url.searchParams.set('skip_status', 'true');
    url.searchParams.set('include_user_entities', 'false');

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: buildHeaders(csrfToken),
      credentials: 'include',
      signal
    });

    if (res.status === 429) {
      throw new Error('RATE_LIMITED: 触发 X 访问频率限制，请稍后再试');
    }
    if (!res.ok) {
      throw new Error(`REST_HTTP_${res.status}: 请求失败`);
    }

    const data = await res.json();
    const users = data.users || [];

    for (const u of users) {
      allUsers.push({
        id: u.id_str,
        name: u.name || '',
        screen_name: u.screen_name || '',
        avatar: u.profile_image_url_https?.replace('_normal', '_200x200') || '',
        description: u.description || '',
        followers_count: u.followers_count || 0,
        following_count: u.friends_count || 0,
        following: Boolean(u.following),
        followed_by: Boolean(u.followed_by),
        verified: Boolean(u.verified),
        order_index: allUsers.length + 1
      });
    }

    cursor = data.next_cursor_str || '0';
    if (users.length === 0) {
      const hasMore = cursor !== '0';
      return {
        users: allUsers,
        complete: !stoppedShortOfTotal(allUsers.length, expectedCount, hasMore)
      };
    }
    if (allUsers.length >= maxCount) {
      return { users: allUsers, complete: cursor === '0' };
    }

    await new Promise(r => setTimeout(r, delayMs));
  }

  return { users: allUsers, complete: true };
}

function isTerminalSyncError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const message = String(err.message || '');
  return message.includes('RATE_LIMITED') || message.includes('AUTH_ERROR') || message.includes('SYNC_CANCELLED');
}

/**
 * Parse users and bottom cursor from GraphQL timeline instructions
 */
export function parseTimelineUsers(data) {
  const users = [];
  let bottomCursor = null;

  // Extract root user profile if available (gives true following and followers count)
  let rootUserProfile = null;
  const rootResult = data?.data?.user?.result;
  if (rootResult) {
    rootUserProfile = extractUserData(rootResult);
  }

  const instructions =
    data?.data?.user?.result?.timeline?.timeline?.instructions ||
    data?.data?.user?.result?.timeline?.instructions ||
    data?.data?.user?.result?.timeline_response?.timeline?.instructions ||
    data?.data?.user?.result?.timeline_response?.instructions ||
    [];

  for (const instruction of instructions) {
    if (instruction.type === 'TimelineTimelineCursor' && (instruction.cursorType === 'Bottom' || instruction.cursorType === 'ShowMore')) {
      bottomCursor = instruction.value;
    }

    const entries = instruction.entries || [];
    for (const entry of entries) {
      const entryId = entry.entryId || '';

      // Bottom pagination cursor
      if (entryId.startsWith('cursor-bottom-') || entry.content?.cursorType === 'Bottom') {
        bottomCursor = entry.content?.value;
        continue;
      }

      // 1. Direct TimelineTimelineItem -> itemContent
      const itemContent = entry.content?.itemContent;
      if (itemContent) {
        const extracted = extractUserData(itemContent.user_results?.result);
        if (extracted) {
          users.push(extracted);
          continue;
        }
      }

      // 2. TimelineTimelineModule -> items
      const moduleItems = entry.content?.items || [];
      for (const mItem of moduleItems) {
        const mContent = mItem.item?.itemContent || mItem.itemContent;
        if (mContent) {
          const extracted = extractUserData(mContent.user_results?.result);
          if (extracted) {
            users.push(extracted);
          }
        }
      }
    }
  }

  return { users, bottomCursor, rootUserProfile };
}

/**
 * Fetch relationship list with GraphQL + fallback to REST
 */
export async function fetchRelationshipList({
  type = 'Following', // 'Following' or 'Followers'
  userId,
  credentials,
  delayMs = 1000,
  maxCount = 10000,
  expectedCount = 0,
  onProgress = null,
  onProfileDiscovered = null,
  signal = null
}) {
  try {
    // 1. Primary approach: GraphQL
    const allUsers = [];
    const seenIds = new Set();
    let cursor = null;
    let page = 0;
    let complete = true;

    while (true) {
      if (signal && signal.aborted) {
        throw new Error('SYNC_CANCELLED: 同步已由用户取消');
      }

      page++;
      const variables = {
        userId,
        count: 50,
        includePromotedContent: false
      };

      if (cursor) {
        variables.cursor = cursor;
      }

      if (onProgress) {
        onProgress({
          type,
          page,
          loadedCount: allUsers.length,
          status: `正在拉取【${type === 'Following' ? '正在关注' : '粉丝列表'}】第 ${page} 页 (已获取 ${allUsers.length} 人)...`
        });
      }

      const data = await requestWithQueryIdFallback(type, variables, credentials, signal);
      const { users, bottomCursor, rootUserProfile } = parseTimelineUsers(data);

      if (rootUserProfile && onProfileDiscovered) {
        onProfileDiscovered(rootUserProfile);
      }

      if (users.length === 0) {
        const hasMore = Boolean(bottomCursor && bottomCursor !== cursor);
        if (stoppedShortOfTotal(allUsers.length, expectedCount, hasMore)) complete = false;
        break;
      }

      let addedInThisPage = 0;
      for (const u of users) {
        if (!seenIds.has(u.id)) {
          seenIds.add(u.id);
          allUsers.push({
            ...u,
            order_index: allUsers.length + 1
          });
          addedInThisPage++;
        }
      }

      if (allUsers.length >= maxCount) {
        complete = !bottomCursor || bottomCursor === cursor;
        break;
      }

      if (!bottomCursor || bottomCursor === cursor) {
        break;
      }

      if (addedInThisPage === 0) {
        if (stoppedShortOfTotal(allUsers.length, expectedCount, true)) complete = false;
        break;
      }

      cursor = bottomCursor;
      const jitter = Math.floor(Math.random() * 400);
      await new Promise(r => setTimeout(r, delayMs + jitter));
    }

    return { users: allUsers, complete };
  } catch (gqlError) {
    if (isTerminalSyncError(gqlError)) throw gqlError;
    console.warn(`[X-Radar] GraphQL ${type} failed, attempting REST API fallback:`, gqlError);

    // 2. Secondary fallback: Standard REST endpoint
    return await fetchRelationshipListViaRest({
      type,
      userId,
      credentials,
      delayMs,
      maxCount,
      expectedCount,
      onProgress,
      signal
    });
  }
}

/**
 * Dynamically extract latest query IDs from X client scripts
 */
export async function updateDynamicQueryIds() {
  try {
    const res = await fetch('https://x.com/xdevelopers');
    if (!res.ok) return;
    const html = await res.text();

    const matches = html.match(/https:\/\/abs\.twimg\.com\/x-web\/x-web\/[a-zA-Z0-9_\.\-]+\.js/g) || [];
    for (const scriptUrl of matches.slice(0, 3)) {
      try {
        const jsRes = await fetch(scriptUrl);
        if (!jsRes.ok) continue;
        const text = await jsRes.text();
        const mFollow = text.match(/queryId:"([a-zA-Z0-9_-]+)",operationName:"Following"/);
        if (mFollow) await chrome.storage.local.set({ queryId_Following: mFollow[1] });
        const mFollowers = text.match(/queryId:"([a-zA-Z0-9_-]+)",operationName:"Followers"/);
        if (mFollowers) await chrome.storage.local.set({ queryId_Followers: mFollowers[1] });
      } catch (e) {}
    }
  } catch (err) {
    // silent
  }
}
