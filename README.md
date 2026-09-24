# X Radar

[中文](README.zh-CN.md)

A Chrome extension for seeing who does not follow you back, who you have not followed back, and how your follower list changes. It uses the X login already in this browser. Lists and history stay on this device.

## Features

- **Not following back, one-way fans, and mutuals.** A scan builds those lists from the accounts you follow and the accounts that follow you.
- **Change history.** A later full scan records new followers and unfollows. Follow, follow-back, and unfollow actions on x.com can also be recorded when the page identifies the account.
- **On-page filters.** On your Following or Followers page, hide people who already follow each other. This does not call the scan API.
- **Languages.** The panel supports Chinese, English, Japanese, Korean, Vietnamese, Spanish, and Portuguese. If the browser language is not one of these, the panel uses English.
- **Side panel or popup.** On browsers that support the side panel, the badge next to the title switches between side panel and popup. The choice is remembered. Browsers without a side panel only use the popup, and the switch is hidden.
- **Large accounts.** When following plus followers is over 10,000, the scan section is hidden. The on-page filters remain available.

## Project structure

```
x-radar/
├── manifest.json
├── background/
│   └── background.js       # Scan scheduling and progress
├── content/
│   └── content.js          # Page filters and follow / unfollow clicks
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js            # Panel UI
├── utils/
│   ├── x-api.js            # X web API client
│   ├── storage.js          # Local lists, snapshots, and history
│   ├── i18n.js             # Panel strings
│   └── display-mode.js     # Side panel / popup preference
├── icons/
├── generate_icons.js
├── README.md
└── README.zh-CN.md
```

The extension is plain JavaScript. It has no build step and no runtime dependencies.

## Install

1. Open `chrome://extensions/`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Pin **X Radar** to the toolbar.

## Use

1. Open [x.com](https://x.com) and sign in.
2. Open X Radar from the toolbar.
3. Use the switches at the top to filter the current Following or Followers page. Use **Open following** or **Open followers** to jump to that page.
4. If the scan section is available, expand **Deep scan** and start a scan. Results are grouped into tabs, including change history.

After reloading the extension, refresh the open x.com tab so the page script updates.
