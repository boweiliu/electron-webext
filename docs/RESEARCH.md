# RESEARCH — building a Chrome-extensions-compatible runtime on CDP for Electron

## Restatement (what we're building)
A framework (`electron-webext`, working name) that lets you write a **standard
web extension** (MV3 manifest + content scripts + background + `chrome.*` API
usage) and run it **inside an arbitrary installed Electron desktop app** — no app
author cooperation, no iframe, no cookie theft. Transport = Chrome DevTools
Protocol over the app's `--remote-debugging-port`. We implement the missing
"extension runtime" that Electron doesn't ship.

## Prior art

| Project | What it is | Usable for us? |
|---|---|---|
| **Electron `session.loadExtension`** (official) | Loads unpacked extensions into an Electron session. Subset of `chrome.*`, focused on DevTools. | **No** — must be called by the app author in-process. Can't call it on Slack from outside. |
| **`electron-chrome-extensions`** (samuelmaddock / Polypane) | The most complete in-process polyfill: `chrome.tabs`, `browserAction/action`, popups, `storage`, `webRequest`, context menus, etc. Powers `electron-browser-shell` (runs uBlock Origin, Dark Reader). GPL-3. | **No directly** — in-process, needs preload + `addTab` wiring by app author. But **excellent reference** for API surface + edge-case behavior. |
| **`getstation/electron-chrome-extension`** | Older similar in-process shim. | Reference only. |
| **`webextension-polyfill`** (Mozilla) | The `browser.*` Promise wrapper injected into content scripts. | **Yes — reuse directly** in our injected content-script world. |
| **`chrome-remote-interface`** | Node CDP client. | Our transport. |
| **Puppeteer `--load-extension`** | Loads MV3 extensions into *headful Chrome* (not Electron) via Chromium's extension subsystem. | No — Electron disables that subsystem; confirmed below. |
| **CDP-external extension runner** | — | **None found.** Our external/CDP angle appears novel. |

## Key live findings (tested against the real Slack.app, Electron 44.3.0)

1. **CDP `Extensions` domain is NOT exposed by Electron.** Upstream Chromium CDP
   has an experimental `Extensions` domain: `loadUnpacked`, `getExtensions`,
   `uninstall`, `triggerAction`, and storage ops (`get/set/remove/clearStorageItems`,
   `StorageArea` = local/session/sync/managed). That would have made the framework
   trivial. But on Slack it returns **`'Extensions.loadUnpacked' wasn't found`** —
   Electron gates the whole domain behind the extension subsystem it disables.
   ⇒ **We must build the polyfill on lower-level CDP primitives.**

2. **The primitives we need ARE available in Electron** (all confirmed live):
   - `Page.addScriptToEvaluateOnNewDocument({source, worldName, runImmediately})`
     → persistent injection across navigations/reloads, **with a named isolated
     world**. Confirmed: a global set in a `worldName`-script is **not visible from
     the main world** (`window.__isoWorld__` undefined in main world) — true
     content-script isolation, for free.
   - `Page.createIsolatedWorld({frameId, worldName})` → explicit world creation.
   - `Runtime.evaluate({expression, contextId|uniqueContextId, returnByValue,
     awaitPromise})` → run code in a chosen world; our host→page channel.
   - `Runtime.addBinding({name})` + `Runtime.bindingCalled` event → exposes a
     global fn on the page that calls back into the host with a JSON payload.
     **Confirmed working in Slack**: page called `window.__hotmodSend(...)`,
     host received `bindingCalled {name, payload}`. This is our page→host channel.
   - `Target.targetCreated / targetInfoChanged / setAutoAttach / setDiscoverTargets`
     → detect new renderer targets (new Slack windows/workspaces) and auto-inject.
   - `Network.*` (getAllCookies, setCookie, deleteCookies, requestWillBeSent…) +
     `Fetch.requestPaused/continueRequest/fulfillRequest/failRequest` →
     `chrome.cookies` and `chrome.webRequest`/`declarativeNetRequest`.
   - `Storage` / `DOMStorage` → backing for `chrome.storage.local` (or our own
     leveldb).
   - `Page.setBypassCSP(true)` → Slack's CSP can't block us (and
     `addScriptToEvaluateOnNewDocument` already bypasses CSP since it's compiled
     by the renderer, not injected as a `<script>` tag — confirmed by our banner
     surviving in Slack).

3. **CDP domain inventory** (browser_protocol.json, 52 domains). Relevant ones:
   `Page` (65 cmds, 28 evts), `Runtime` (21 cmds, 8 evts), `Target` (19/7),
   `Network` (35/43), `Fetch` (9/2), `Storage` (27/7), `ServiceWorker` (12/3),
   `Emulation` (49/2), `DOM` (57/19), `DOMDebugger`, `Extensions` (8/0 — gated).

## The standardized surface (W3C WebExtensions)

The W3C **WebExtensions Community/Working Group** (w3c/webextensions) maintains a
draft spec (`specification/index.bs`). It standardizes exactly the things we must
support to claim "standardized web extensions":
- Manifest keys: `manifest_version`, `name`, `version`, `permissions`,
  `host_permissions`, `background`, `commands`, `content_scripts`,
  `content_security_policy`, `options_ui`, `web_accessible_resources`,
  `externally_connectable`, `devtools_page`, `icons`, etc.
- **Isolated worlds** (content-script execution context, separate from page's
  main world).
- **Content scripts**: `matches`, `exclude_matches`, `js`, `css`, `all_frames`,
  `match_about_blank`, `match_origin_as_fallback`, `run_at`
  (`document_start/end/idle`), `include_globs`, `exclude_globs`, `world`
  (`isolated|main`).
- Background (service worker / event page), extension pages, match patterns,
  globs, extension IDs, localization.

So "most of the major API surface" = the Chrome MV3 reference modules, which we'd
prioritize in this order (by usefulness for desktop-app hot-modding):

**Tier 1 (must have):** `runtime`, `tabs`, `scripting`, `storage`, `cookies`,
`runtime.sendMessage`/`onMessage`, `i18n`.
**Tier 2 (high value):** `declarativeNetRequest` (+ `webRequest`), `alarms`,
`notifications`, `contextMenus`, `action`, `windows`, `idle`, `permissions`.
**Tier 3 (nice):** `sidePanel`, `commands`, `identity`, `downloads`, `menus`,
`options` page.

## Proposed architecture: `electron-webext`

```
                ┌──────────────────────── electron-webext (Node host) ─────────────────────────┐
                │  Loader  · Manifest validator · ID assignment · Hot-reload watcher          │
                │  Target manager (Target.targetCreated/InfoChanged)  →  "tabs" registry       │
                │  Message bus (call-id → promise, background↔content routing)                │
                │  API backends: storage(leveldb) · cookies(CDP Network) ·                      │
                │                 DNR/webRequest(CDP Fetch) · tabs(CDP Target) · alarms · …     │
                └───────────▲───────────────────────────────────────────────▲──────────────────┘
                            │ Runtime.addBinding (page→host)                  │ Runtime.evaluate (host→page)
                            │ bindingCalled event                            │ (in named isolated world)
                ┌───────────┴──────────────┐                  ┌──────────────┴─────────────────┐
                │  Renderer target (Slack) │  ...per target   │  Background (Node Worker or     │
                │  isolated world           │                  │  hidden CDP target)             │
                │  ┌─ webextension-polyfill │                  │  ┌─ chrome.* shim (full perms)   │
                │  ├─ chrome.* shim (content)│                  │  └─ extension background.js     │
                │  └─ content scripts        │                  └─────────────────────────────────┘
                └──────────────────────────┘
```

### Content-script injection (the core)
For each renderer target whose `url` matches a manifest `content_scripts` entry
(matches/exclude_matches/globs), per frame:
1. Ensure an isolated world named `electron-webext:<extId>` exists
   (`Page.createIsolatedWorld` once; `addScriptToEvaluateOnNewDocument` with that
   `worldName` re-creates it on every navigation).
2. `Page.addScriptToEvaluateOnNewDocument({source: bootstrap+api-shim+cs, worldName,
   runImmediately:true})` → persists across Slack's SPA reloads (our verified
   behavior). `run_at` maps to ordering / `Page.lifecycleEvent`.
3. CSS files → inject a `<style>` via the same mechanism (or `CSS.*`).
4. `world:"main"` entries → omit `worldName` (run in main world).
5. Re-evaluate matches on `Page.frameNavigated` (URL changes in SPA) and
   `Target.targetInfoChanged`.

### Messaging bridge
- Page→host: `Runtime.addBinding("__ew_send")`; content script calls
  `__ew_send({api, method, args, callId})`; host dispatches to the API backend,
  returns result via `Runtime.evaluate` resolving a promise keyed by `callId`.
- Background↔content: host routes by extension id + tab id; `chrome.runtime.sendMessage`
  / `onMessage` / `chrome.tabs.sendMessage` are just bus messages.
- `externally_connectable`: allow the app's main world to call
  `chrome.runtime.sendMessage(extId, …)` via a binding we expose on `window`.

### Background
Run the extension's `background` SW in a **Node Worker** (simplest) with the same
`chrome.*` shim but full host powers (fs, real fetch, CDP). Persistence/events
handled by the host. (Alternative: a hidden `Target.createTarget` about:blank page
running the SW in real Chromium — closer to spec, more work.)

### Storage / cookies / DNR
- `chrome.storage.local` → leveldb under our data dir; `session` in-memory;
  `sync`/`managed` stubbed (no Chrome account). Multiplexed to all worlds via bus.
- `chrome.cookies.*` → CDP `Network.getAllCookies/setCookie/deleteCookies`
  operating on the **app's real cookie jar** (the live Slack session) — a major win
  over the iframe/cookie-stealing approach.
- `declarativeNetRequest`/`webRequest` → `Fetch.enable` + `requestPaused` →
  match rules → `continueRequest`/`fulfillRequest`/`failRequest`.

### Hot reload (the web-ext loop)
`fs.watch` the extension dir → on change: `removeScriptToEvaluateOnNewDocument`
(old ids) → re-parse manifest → re-inject all matched targets → restart
background worker. Same loop we already proved in `bin/hotmod.mjs`, generalized.

## Reuse / reference
- `webextension-polyfill` (Mozilla, MPL) — inject verbatim into content world.
- `electron-chrome-extensions` source (GPL, read-only reference) — for API
  behavior, event semantics, tab model edge cases.
- `chrome-remote-interface` — CDP transport.

## Open risks / to-test
- `Target.setDiscoverTargets`/`setAutoAttach` behavior on Electron with multiple
  Slack windows/workspaces (need a multi-window test).
- `all_frames` / iframes inside Slack's renderer — `Page.getFrameTree` + per-frame
  `createIsolatedWorld`.
- Service-worker target injection (Slack has a SW) — separate target type.
- `Runtime.addBinding` is per-target; must re-add on each new target / context
  clear. Track `executionContextCreated/Destroyed` per world.
- Background-as-Node-Worker vs real SW: some extensions assume `self`,
  `importScripts`, `fetch` to extension origin — may need shims.

## Bottom line
The native CDP `Extensions` domain is closed in Electron, but every primitive
needed to **reimplement the WebExtensions runtime externally over CDP** is
available and verified working in the real Slack.app: named isolated worlds,
persistent inject-on-new-document, `addBinding` messaging, target lifecycle,
network/fetch interception, and the app's real cookie jar. The framework is
buildable; nothing in research blocks it.
