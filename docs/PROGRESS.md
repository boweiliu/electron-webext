# PROGRESS — 473 hot-modding real OSX Electron apps

## Goal
Instead of iframing Slack/WhatsApp/Muse (sessions 457/471/472), inject "extension"
JS straight into the **installed Slack.app** on OSX, with web-ext-style hot reload.

## Verdict (research)
- `web-ext` / Mozilla temporary extensions → **Firefox only**, irrelevant: Slack.app
  is Electron (Chromium). Confirmed: `Slack.app/Contents/Frameworks/Electron
  Framework.framework` + `Resources/app.asar`, UA string `Electron/44.3.0`.
- Chrome MV2/MV3 unpacked extensions → **not loadable**: Electron disables Chromium's
  extension subsystem; Slack doesn't call `session.loadExtension`. `--load-extension`
  is ignored.
- **What works = Chrome DevTools Protocol (CDP)** via `--remote-debugging-port`.
  Every Electron app honors it. CDP gives us `Runtime.evaluate` (immediate inject)
  and `Page.addScriptToEvaluateOnNewDocument` (runs on every navigation/reload =
  the persistent "content script" analog). That is the hot-mod primitive.

## What we built
- `bin/hotmod.mjs` — Node + `chrome-remote-interface` harness:
  1. `GET /json/list` → find renderer targets matching `--match`.
  2. For each `page` target: `Page.addScriptToEvaluateOnNewDocument(src)` (persist)
     + `Runtime.evaluate(src)` (immediate). Optional `--reload`.
  3. `fs.watch(src)` → on any `*.js` change, re-read + re-inject into all targets.
     This is the web-ext hot-reload loop, on CDP.
- `ext-src/content.js` — sample "extension": idempotent IIFE, a visible
  `#hotmod-banner` div, `window.slackHotMod = { say, workspace }` hook.

## Verification against the REAL Slack.app (not a mock)
1. `open -a Slack --args --remote-debugging-port=9222` → CDP up in 2s.
   `/json/version` → `Chrome/152, Electron/44.3.0, Slack/4.52.162`.
   `/json/list` → `page` target `https://app.slack.com/client/TSTHRQ7MY/...`
   (the actual logged-in workspace) + a service_worker target.
2. `node bin/hotmod.mjs --port 9222 --src ext-src --match slack.com --reload`
   → "injected -> ...", "reloaded -> ...".
3. Remote eval from a separate CDP client:
   ```
   {"demo":true,"banner":true,
    "ws":"project-minds-internal-product (Channel) - Imbue - 1 new item - Slack",
    "say":"ping"}
   ```
   → our code is running **inside the real Slack desktop renderer**, reads the real
   workspace title, exposes a callable hook, and renders a visible banner over the
   actual app UI. No iframe, no cookie theft, no tunnel.
4. Hot reload: appending `// hot-reload test <ts>` to `ext-src/content.js` twice →
   harness logged `change detected (content.js) — re-injecting` + `re-injected`
   each time, with no manual restart. (web-ext-style loop confirmed.)
5. Persistence sanity: a manually appended fixed `<div>` survives 4s in the live
   Slack DOM → Slack does NOT strip injected nodes.

## How to run
```bash
open -a Slack --args --remote-debugging-port=9222
node bin/hotmod.mjs --port 9222 --src ext-src --match slack.com --reload
# edit ext-src/content.js → it re-injects live into Slack
```
Quit cleanly: `pkill -f "Slack.app/Contents/MacOS/Slack"` (also closes the port).

## Notes / limits
- Must launch the app with the flag; can't attach to an already-running instance
  that wasn't started with it. (Could wrap the app bundle to always pass the flag,
  or set `Electron` defaults — left for later.)
- One target per Slack workspace/window; `--match slack.com` catches them all.
- This is local dev tooling, not a distributable extension. For distribution you'd
  cold-mod: unpack `app.asar` (`npx asar extract app.asar app`), edit, repack
  (`asar pack app app.asar`), and re-sign. That survives restarts but no hot reload.
- Same technique works for any Electron app that honors the flag: VS Code (already
  has an extension API), Discord, Notion, WhatsApp Desktop, Muse desktop, etc.

## Next directions (open)
- Bridge `window.slackHotMod` to a desktop CLI agent (pi-coding-agent) over a
  localhost WS so the agent can read/send Slack messages — same "agent chat"
  goal as 472 but without iframes/cookies.
- Hook Slack's internal IPC (`slack:*` events) from the renderer to expose
  send-message / read-channel APIs to our injected code.
- Multi-target: also inject into the service_worker target to intercept network.
