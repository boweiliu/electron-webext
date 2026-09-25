# electron-webext

Run **standard web extensions** (Chrome MV3 / WebExtensions API) **inside any
installed Electron desktop app** — Slack, Discord, Notion, WhatsApp Desktop,
etc. — by plugging into the app's `--remote-debugging-port` and reimplementing
the extension runtime that Electron doesn't ship, on top of the Chrome DevTools
Protocol (CDP).

No app-author cooperation. No iframe. No cookie theft. No repackaging `app.asar`.
You write a normal web extension (manifest + content scripts + `chrome.*`), point
the host at the app, and your extension runs inside the real desktop app — with
access to the app's real DOM, cookies, and network.

> Think [Mozilla `web-ext`](https://github.com/mozilla/web-ext) hot-reload, but the
> target is an arbitrary Electron app instead of Firefox.

## How it works (Slack → debug port → browser-ext surface)

```
 ┌─────────────────────┐     open -a Slack --args --remote-debugging-port=9222
 │  Slack.app (Electron)│ ◀── exposes Chrome DevTools Protocol on localhost:9222
 │  real logged-in session│
 └──────────┬──────────┘
            │ CDP (Page.addScriptToEvaluateOnNewDocument, Runtime.addBinding, …)
            ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  electron-webext host  (Node)                                            │
 │   • target manager  (discovers renderer targets, auto-attaches)          │
 │   • injector        (isolated worlds per extension, respects run_at)      │
 │   • chrome.* shim   (injected into the page; calls back over a binding)   │
 │   • backends        (management, runtime, storage, tabs, action, …)      │
 │   • hot reload      (fs.watch → reinject → autoreload, with build hashes) │
 └──────────▲───────────────────────────────────────────────────────────────┘
            │ Runtime.bindingCalled (page→host)        Runtime.evaluate (host→page)
            │
 ┌──────────┴───────────────────────────────────────────────────────────────┐
 │  Your extension's content scripts  (window.chrome.*)                      │
 │   + the built-in _management extension (toolbar + extensions panel)       │
 └───────────────────────────────────────────────────────────────────────────┘
```

The native CDP `Extensions.loadUnpacked` domain is **not exposed by Electron**
(verified on Slack), so this project polyfills the WebExtensions runtime on the
lower-level CDP primitives that *are* available: named isolated worlds,
`Runtime.addBinding` for page→host messaging, `Target.*` for tab/window
lifecycle, and `Network`/`Fetch` for cookies and request interception.

## Quick start

```bash
git clone https://github.com/boweiliu/electron-webext.git
cd electron-webext
npm install                       # installs chrome-remote-interface

# 1. Launch the Electron app with a debug port (Slack example):
open -a Slack --args --remote-debugging-port=9222

# 2. Run the host:
node bin/ew-host.mjs --port 9222 --match slack.com
```

You should see a dark **toolbar** pinned across the top of the Slack window:

- **⚙** — opens the **extensions management panel** (list / enable / disable /
  reload / uninstall loaded extensions).
- **📌** — choose a stable screen position (top/bottom × left/center/right).
- **– / +** — minimize the toolbar (state persisted in `chrome.storage.local`).
- **Cmd/Ctrl+Shift+E** — toggle the whole injected chrome.

Quit Slack and close the port with:
```bash
pkill -f "Slack.app/Contents/MacOS/Slack"
```

### Options
| flag | default | description |
|---|---|---|
| `--port` | `9222` | CDP port the app was launched with |
| `--match` | (all) | only attach to targets whose URL/title contains this string |
| `--no-autoreload` | off | disable auto-reload of the target after a reinject |
| `--verbose` | on | verbose host logging |

## Project layout
```
bin/
  ew-host.mjs            the host runtime (CDP target manager, injector, bridge, backends)
  hotmod.mjs              minimal standalone CDP hot-mod injector (the original proof of concept)
framework/
  host/
    shim.js               chrome.*/browser.* shim injected into each target (over the CDP binding)
    api/
      management.js       chrome.management backend (spec/skeleton)
  extensions/
    _management/          built-in first-party extension: toolbar + management panel + full-page UI
      manifest.json
      toolbar.js
      panel.js
      management.html
docs/
  RESEARCH.md             prior art, live CDP findings, standardized surface, architecture
  MANAGEMENT.md           the management UI design
  PROGRESS.md             step-by-step verification against the real Slack.app
```

## What's implemented (working slice)
- **Host**: CDP target discovery, per-target attach, `Page.addScriptToEvaluateOnNewDocument`
  injection (respects `run_at`), `Runtime.addBinding` bridge, in-process backends,
  hot reload with **build hashing + `node --check`** so stale or malformed code can
  never ship silently.
- **`chrome.*` shim** (Promise-based, MV3): `management`, `runtime`, `storage`
  (local/session/sync), `action`, `tabs`, `commands`, `i18n`, `windows`, plus an
  event system (`onInstalled`, `onMessage`, …).
- **Backends**: `chrome.management` (getAll/get/getSelf/setEnabled/uninstall/
  loadUnpacked/reload), `chrome.runtime` (getURL/getManifest/getId/sendMessage),
  `chrome.storage.local` (in-memory per extension), `chrome.tabs` (query/get/
  sendMessage/reload/executeScript), `chrome.action.onClicked`.
- **Built-in `_management` extension**: injected top toolbar + management panel +
  full-page `chrome://extensions`-style UI. It's just a normal client of
  `chrome.management` — not special-cased — so third-party extensions can build
  their own managers too.

## Debug verification (how we prove the running code is the latest)
Every generated source is stamped with an FNV-1a hash. Three places must agree:
1. host log: `inject build=<hash>` / `reinject build=<hash>`
2. page console: `[ew] shim init build=<hash>`
3. `window.__ewBuild` (query via CDP)

On every inject the host also writes the generated source to `debug-build.js` and
runs `node --check` on it (`node --check OK for build=<hash>`). With `--autoreload`
(default), editing any extension file reloads the target so the new build is live
immediately.

## Why not the obvious paths
- **Mozilla `web-ext` / temporary extensions** — Firefox-only; Electron is Chromium.
- **Chrome MV3 unpacked extensions / `--load-extension`** — Electron disables
  Chromium's extension subsystem; `session.loadExtension` needs the app author.
- **CDP `Extensions.loadUnpacked`** — exists in upstream Chromium CDP but **not
  exposed by Electron** (`'Extensions.loadUnpacked' wasn't found`). So we polyfill.

## Status & roadmap
**Working:** toolbar + management panel render in the real Slack.app;
`chrome.management`/`storage`/`tabs` resolve; hot reload; build-hash verification;
click-through toolbar; stable pins.

**TODO (in rough priority order):**
- per-extension isolated worlds (currently single-extension; `extId=_management`)
- `chrome.cookies` backed by CDP `Network` on the app's real cookie jar
- `chrome.declarativeNetRequest` / `webRequest` backed by CDP `Fetch`
- background service worker (Node Worker) + `chrome.runtime` messaging between
  background and content scripts
- "Load unpacked…" folder picker in the management panel
- persistent `chrome.storage` (currently in-memory; lost on host restart)
- `all_frames` / iframe targeting, multi-window auto-attach
- sample POC extensions that exercise the API surface

## License
MIT. See [LICENSE](LICENSE).
