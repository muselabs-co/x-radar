export const DISPLAY_MODE_KEY = 'xradar_display_mode';

const POPUP_URL = 'popup/popup.html?view=popup';

export function sidePanelSupported() {
  return typeof chrome.sidePanel !== 'undefined'
    && typeof chrome.sidePanel.setPanelBehavior === 'function';
}

export async function readDisplayMode() {
  try {
    const stored = await chrome.storage.local.get(DISPLAY_MODE_KEY);
    if (stored[DISPLAY_MODE_KEY] === 'popup' || stored[DISPLAY_MODE_KEY] === 'sidepanel') {
      return stored[DISPLAY_MODE_KEY];
    }
  } catch (e) {
    return 'popup';
  }
  return sidePanelSupported() ? 'sidepanel' : 'popup';
}

export async function applyDisplayMode(mode) {
  const useSidePanel = mode === 'sidepanel' && sidePanelSupported();
  if (useSidePanel) {
    await chrome.action.setPopup({ popup: '' });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    return 'sidepanel';
  }
  if (sidePanelSupported()) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  }
  await chrome.action.setPopup({ popup: POPUP_URL });
  return 'popup';
}

export async function saveAndApplyDisplayMode(mode) {
  const applied = await applyDisplayMode(mode);
  await chrome.storage.local.set({ [DISPLAY_MODE_KEY]: applied });
  return applied;
}
