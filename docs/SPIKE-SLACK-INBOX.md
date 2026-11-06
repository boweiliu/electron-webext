# Spike: Slack Inbox → real Discord DMs in a real-looking Slack channel

This spike uses the real Slack.app as a **UI shell for cross-platform
responsiveness** (discord / email / linkedin / …), so you can answer people
outside your team from the workflow you already live in. It injects one
`discord - <name>` row per **real** Discord DM under the "bowei" sidebar
section and renders the real conversation in the message pane — looking and
behaving like a genuine aubergine Slack channel — all via CDP injection (no
iframe, no cookie theft, no app repackaging).

Two v0.2 passes were merged into v0.3:

- **data (n4):** real Discord DMs pulled host-side via `latchkey curl` and a
  new `chrome.discord` bridge; real replies via the composer. The token never
  reaches the page. Graceful fake-"alice" fallback when creds/bridge are gone.
- **looks (n3):** aubergine Slack theme, 36px avatars (real self avatar reused
  for "me" messages), colored sender names + timestamps, same-sender grouping,
  hover action bar, date divider, contenteditable composer, sidebar selection
  state + right-click context menu.

## Architecture

```
 Slack renderer (slack.com, isolated world `ew:<slack-inbox>`)
   │  content.js
   │  chrome.discord.listDMs() / .messages(id) / .send(id, text)
   ▼  (Runtime.addBinding → __ewSend → host backends.discord)
 electron-webext host (Node, bin/ew-host.mjs)
   │  backends.discord.*  →  `latchkey curl 'https://discord.com/api/v10/...'`
   ▼
 latchkey  (stored `discord` service → injects Authorization header)
   ▼
 Discord REST API
```

The content script runs in `slack.com`'s renderer and can't reach `discord.com`
(cross-origin + Slack's CSP) and must never see the token, so the **host** makes
the calls via `latchkey curl`, where latchkey injects the stored
`Authorization` header. The extension only ever sees parsed JSON.

## What it does

- **Sidebar:** injects one `discord - <name>` row per real Discord DM channel
  (capped at 8) as the first channels under the `bowei` section. Each is a clone
  of a real channel row (inherits Slack's styling), renamed + re-stamped with our
  own `data-qa`. Idle by default; clicking selects it (aubergine `#7d3986`) and
  deselects the previously-active real channel. Selection persists across Slack
  re-renders. Right-click shows a Slack-style context menu (copy link / mute /
  mark read / leave).
- **Message pane:** clicking a row overlays a closed-shadow-DOM panel that mimics
  a real aubergine-dark Slack channel view:
  - **header** (`# discord - <name>` + live/fake status + member count).
  - **message kit** — 36px avatars (the real self avatar is reused for "me"
    messages, so they look pixel-identical; others get a Slack-colored initial
    circle), colored bold sender names + 12px timestamp, 15px/22px body,
    same-sender grouping (continuation rows hide the avatar/name), date divider,
    and a hover action bar (😊 ↪ 🔖 ⋯).
  - **composer** — rounded `.c-wysiwyg_container` look (bg #222529, border
    #565856), focus ring, `Message discord - <name>` placeholder, Enter sends a
    **real** Discord message, Shift+Enter for newline.
  - live-refreshes every 6s; clicking a real channel (or the × button) hides the
    overlay and deselects.
- **Harness hooks:** `window.__ewInbox` (in the extension's isolated world)
  exposes `.status() / .channels() / .open(id) / .close() / .refresh() /
  .select(id) / .deselect() / .capture()` so an e2e/dev harness can read the
  rendered HTML + structured conversation and drive the overlay.

## How it survives Slack's React virtualized sidebar

The sidebar is a `c-virtual_list__scroll_container`; every row is a
`[data-qa="virtual-list-item"]` positioned with an absolute `top` (px), height
28, computed by Slack from the item's index. React owns `top` but does **not**
touch `transform`. So:

1. Insert N fake rows starting at `top = (section heading top + 28)`.
2. Shift every real row at/ below that `top` down by `N * 28px` via
   `transform: translateY(N*28px)`. React can rewrite `top` all it wants — our
   transform persists.
3. A `MutationObserver` on the scroll container re-inserts the fake rows and
   re-applies the shifts whenever Slack re-renders.

## Credentials

The Discord token lives in **latchkey** (never in the extension). Either:

```bash
# user-session token — reads your REAL personal DMs (recommended for the spike)
latchkey auth browser discord

# bot token — reads the bot's channels / DMs-with-the-bot
latchkey auth set discord -H "Authorization: Bot <token>"
```

Verify the data path independently of the Slack UI:

```bash
node bin/test-discord.mjs                 # status + list DMs + dump first thread
node bin/test-discord.mjs <channelId> 20  # dump a specific thread
```

Without creds the extension automatically falls back to the fake "discord -
alice" conversation so the spike still renders (footer reads "fake mode").

## Run it (with the live host)

The shared hackathon host runs from the main worktree and lacks the `discord`
backend. To exercise the real wiring, run the host from this worktree:

```bash
# only one host can attach to Slack's renderer at a time — stop the shared one
pkill -f "bin/ew-host.mjs"

cd ~/code/electron-webext-n4
node bin/ew-host.mjs --port 9222 --match slack.com
```

You should now see one `discord - <name>` row per real Discord DM. Click one —
the overlay loads the real thread from Discord; typing + Enter sends a real
message. Hot-reload is on, so edits to `content.js` reinject + reload Slack
automatically.

## Harness

```bash
node bin/eval.mjs '() => window.__ewInbox.channels()'
node bin/eval.mjs '() => window.__ewInbox.capture()'
node bin/screenshot.mjs /tmp/discord-in-slack.png
```

## What changed

- `bin/ew-host.mjs` — new `backends.discord` (`status / me / listDMs / messages
  / send`) backed by `latchkey curl`; token stays host-side.
- `framework/host/shim.js` — new `chrome.discord` namespace.
- `framework/extensions/slack-inbox/content.js` — one row per real DM; overlay
  pulls real messages and sends real replies; realistic aubergine Slack message
  kit + composer + selection + context menu; live 6s poll; graceful fake
  fallback.
- `bin/test-discord.mjs` — standalone end-to-end check of the latchkey→Discord
  path.

## Next

- More sources: gmail / linkedin rows, each with its own bridge + renderer (the
  `discord` backend is the template).
- Persist last-open thread + unread counts in `chrome.storage.local`.
- A screenshot + HTML-capture harness loop for headless e2e assertions.
- Switch from polling to gateway events (`latchkey` could expose a WS proxy).
