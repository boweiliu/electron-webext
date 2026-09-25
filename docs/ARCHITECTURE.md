# Architecture & details

> Companion to the [README](../README.md). This covers options, project layout,
> the implemented API surface, the debug-verification procedure, why-not-the-obvious
> alternatives, and the roadmap.

## Options
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
    slack-channel-info/    POC #1: isolated-world content script — reads Slack channel from DOM, storage, runtime.sendMessage, tabs
      manifest.json
      content.js
    action-logger/         POC #2: isolated-world content script — action.onClicked, management.getAll, tabs.query, onMessage, storage.onChanged
    slack-hud/            DEMO: floating overlay (live channel + workspace + clock) + Night Mode toggle that re-themes the real Slack UI via CSS injection
docs/
  RESEARCH.md             prior art, live CDP findings, standardized surface, architecture
  MANAGEMENT.md           the management UI design
  PROGRESS.md             step-by-step verification against the real Slack.app
```

## What's implemented (working slice)
- **Host**: CDP target discovery, per-target attach, **per-extension isolated worlds**
  (`Page.addScriptToEvaluateOnNewDocument` with `worldName`), respects `run_at`,
  `Runtime.addBinding` bridge, in-process backends, hot reload with **build hashing +
  `node --check`** so stale or malformed code can never ship silently. Host→page
  events are delivered to **every execution context** (main + all isolated worlds).
- **`chrome.*` shim** (Promise-based, MV3): `management`, `runtime`, `storage`
  (local/session/sync), `action`, `tabs`, `commands`, `i18n`, `windows`, plus an
  event system (`onInstalled`, `onMessage`, `onClicked`, `onChanged`, …).
  `runtime.getId`/`getManifest`/`getURL` and `i18n.getMessage` are **synchronous**
  (backed by injected `__ewSelfInfo`), matching real Chrome.
- **Backends**: `chrome.management` (getAll/get/getSelf/setEnabled/uninstall/
  loadUnpacked/reload), `chrome.runtime` (sendMessage/getInfo/getSelf),
  `chrome.storage.local` (in-memory per extension), `chrome.tabs` (query/get/
  sendMessage/reload/executeScript), `chrome.action.onClicked`.
- **Built-in `_management` extension**: injected top toolbar + management panel +
  full-page `chrome://extensions`-style UI. It's just a normal client of
  `chrome.management` — not special-cased.
- **POC extensions** (auto-loaded from `framework/extensions/`):
  - `slack-channel-info` — isolated-world content script that reads the current
    Slack channel from the page DOM, stores it in `chrome.storage.local`,
    broadcasts via `chrome.runtime.sendMessage`, and queries `chrome.tabs`.
  - `action-logger` — isolated-world content script with a toolbar action; on
    click it calls `chrome.management.getAll` + `chrome.tabs.query` +
    `chrome.storage.local`, and receives `onMessage` / `storage.onChanged` /
    `action.onClicked`.
  - `slack-hud` — **demo**: a floating overlay (closed shadow DOM) showing the
    live channel + workspace + clock, with a Night Mode toggle that injects a
    `<style>` into the page head to re-theme the real Slack UI
    (`body { filter: invert(1) hue-rotate(180deg) }`). Visibly mutates the page.

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
**Working:** per-extension isolated worlds; toolbar + management panel render in the
real Slack.app; `chrome.management`/`storage`/`tabs`/`action`/`runtime` resolve;
cross-extension `sendMessage`/`onMessage`; `storage.onChanged`; hot reload; build-hash
verification; click-through toolbar; stable pins; two POC extensions verified e2e.

**Known deviation:** `chrome.action.onClicked` is delivered to the extension's own
content-script world (electron-webext has no background service worker yet); in
real Chrome it fires in the background.

**TODO (in rough priority order):**
- background service worker (Node Worker) + `chrome.runtime` messaging between
  background and content scripts (so `action.onClicked` fires in the background)
- `chrome.cookies` backed by CDP `Network` on the app's real cookie jar
- `chrome.declarativeNetRequest` / `webRequest` backed by CDP `Fetch`
- "Load unpacked…" folder picker in the management panel
- persistent `chrome.storage` (currently in-memory; lost on host restart)
- `all_frames` / iframe targeting, multi-window auto-attach
- match-pattern / glob enforcement for `content_scripts.matches` (currently all
  matched targets receive all content scripts)
