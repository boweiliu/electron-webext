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
 └──────────▲────────────────────────────────────────────────────────────────┘
            │ Runtime.bindingCalled (page→host)        Runtime.evaluate (host→page)
            │
 ┌──────────┴────────────────────────────────────────────────────────────────┐
 │  Your extension's content scripts  (window.chrome.*)                        │
 │   + the built-in _management extension (toolbar + extensions panel)         │
 └─────────────────────────────────────────────────────────────────────────────┘
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

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for options, project layout,
the implemented API surface, the debug-verification procedure, why-not-the-obvious
alternatives, and the roadmap. Verification against the real Slack.app is in
[docs/PROGRESS.md](docs/PROGRESS.md); prior art + CDP findings are in
[docs/RESEARCH.md](docs/RESEARCH.md).

MIT — see [LICENSE](LICENSE).
