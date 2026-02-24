# Screenshot Handling

## Overview

Screenshots are captured automatically after Docker preview deployment. Each screenshot shows a specific page of the ZoomWarriors application with the changes applied.

## URL Structure

Screenshot URLs follow this pattern:

```
{ZW2_BASE}/api/v1/developer-studio/requests/{request_id}/screenshot/{index}/
{ZW2_BASE}/api/v1/frontend-studio/requests/{request_id}/screenshot/{index}/
```

These endpoints are **public** — no authentication required. URLs work as clickable links in any channel.

## Presenting Screenshots

### All Channels (Default)

Present screenshots as a numbered list with the page name and clickable URL:

```
Screenshots:
1. Dashboard: {url}/screenshot/0/
2. Order Form: {url}/screenshot/1/
3. Settings: {url}/screenshot/2/
```

### Channels with Image Embeds (Slack, Discord)

If the channel supports image embeds, the URLs will render inline automatically when sent as messages. Present them one per line for clean rendering.

### Channels without Image Support (SMS, basic WhatsApp)

Use the numbered list format above. Users can tap/click the URLs to view in their browser.

## SOW Screenshots

SOW (Statement of Work) document screenshots are separate from page screenshots:

```
{ZW2_BASE}/api/v1/developer-studio/requests/{request_id}/sow-screenshot/{index}/
```

Present these only when the user specifically asks about the SOW or document changes:

```
SOW Document Pages:
- Page 1: {url}/sow-screenshot/0/
- Page 2: {url}/sow-screenshot/1/
```

## Screenshot Count

The `screenshots` array in the response tells you how many are available. The `index` is zero-based:

- 3 screenshots → indices 0, 1, 2

## Tips

- Always show the page name alongside the URL so users know what they're looking at.
- If there are many screenshots (5+), summarize: "8 screenshots captured. Here are the key ones:" and show the first 3-4.
- Screenshot mode can be configured: `modified` (only changed pages), `all` (every page), or `custom` (specific pages). The default is `modified`.
