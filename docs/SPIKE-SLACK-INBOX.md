# Spike: Slack Inbox → real Discord DMs

Step 2 of using the real Slack.app as a **UI shell for cross-platform
responsiveness** (discord / email / linkedin), so you can answer people outside
your team from the workflow you already live in.

The first spike injected a *fake* "discord - alice" channel + a hardcoded
conversation. This spike makes the conversation **real**: it pulls your actual
Discord DMs into the injected Slack channel and sends real replies, all without
the page ever touching the Discord token.

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

Key point: the content script runs in `slack.com`'s renderer. It can't reach
`discord.com` directly (cross-origin + Slack's CSP) and must never see the token.
So the **host** makes the calls, via `latchkey curl`, where latchkey injects the
stored `Authorization` header. The extension only ever sees parsed JSON.

## Credentials

The Discord token is provided to **latchkey** (never to the extension). Either:

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

If you run the host but haven't configured creds, the extension automatically
falls back to the original fake "discord - alice" conversation so the spike still
renders (the footer reads "fake mode").

## Run it (with the live host)

The shared hackathon host runs from the main worktree and **doesn't have the
`discord` backend**. To exercise the real wiring, run the host from this
worktree:

```bash
# (only one host can attach to Slack's renderer at a time — stop the shared one)
pkill -f "bin/ew-host.mjs"

# then, from this worktree:
cd ~/code/electron-webext-n4
node bin/ew-host.mjs --port 9222 --match slack.com
```

You should now see one `discord - <name>` row under your bowei sidebar section
**per real Discord DM** (capped at 8). Click one — the overlay loads the real
thread from Discord; typing + Enter sends a real message. The thread auto-
refreshes every 6s.

> Because the host hot-reloads on file change, edits to
> `framework/extensions/slack-inbox/content.js` reinject + reload Slack
> automatically once the worktree host is running.

## Harness hooks (window.__ewInbox)

```js
__ewInbox.status()        // bridge status: { ok, account, bot, latchkey, reason }
__ewInbox.channels()      // discovered Discord DM channels (or [] in fake mode)
__ewInbox.open(channelId) // open the overlay on a channel
__ewInbox.close()         // hide the overlay
__ewInbox.refresh()       // force refetch the active thread
__ewInbox.capture()       // { visible, activeId, fakeMode, conversation, conversationHtml }
```

From the page main world (no extension world needed for these read-only hooks):
```bash
node bin/eval.mjs '() => window.__ewInbox.channels()'
node bin/screenshot.mjs /tmp/discord-in-slack.png
```

## What changed from spike 1

- `bin/ew-host.mjs` — new `backends.discord` (`status / me / listDMs / messages
  / send`) backed by `latchkey curl`; token stays host-side.
- `framework/host/shim.js` — new `chrome.discord` namespace exposed to
  extensions.
- `framework/extensions/slack-inbox/content.js` — one row per real DM channel;
  overlay pulls real messages and sends real replies; live 6s poll; graceful
  fake fallback when the bridge/creds are unavailable.
- `bin/test-discord.mjs` — standalone end-to-end check of the latchkey→Discord
  path (no Slack needed).

## Next

- More sources: gmail / linkedin rows under the section, each with its own
  bridge + renderer (the `discord` backend is the template).
- Persist last-open thread + unread counts in `chrome.storage.local`.
- A screenshot + HTML-capture harness loop so an external e2e driver can assert
  on the rendered cross-platform inbox without a human in the loop.
- Send-receipt / typing indicators; switch from polling to gateway events
  (`latchkey` could expose a WS proxy).
