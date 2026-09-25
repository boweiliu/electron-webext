# TODO

Open work for electron-webext, roughly in priority order. Checked items are done.

## Done
- [x] Host runtime: CDP target manager, per-target attach, `Runtime.addBinding` bridge, in-process backends
- [x] Per-extension isolated worlds (`Page.addScriptToEvaluateOnNewDocument` + `worldName`)
- [x] Host→page events delivered to every execution context (main + all isolated worlds)
- [x] `chrome.*` shim (MV3, promise-based): `management`, `runtime`, `storage`, `action`, `tabs`, `commands`, `i18n`, `windows` + event system
- [x] Synchronous APIs (`runtime.getId/getManifest/getURL`, `i18n.getMessage`) via injected `__ewSelfInfo`
- [x] Backends: `management` (getAll/get/getSelf/setEnabled/setEnabledAll/uninstall/loadUnpacked/reload), `runtime` (sendMessage/getInfo/getSelf), `storage.local`, `tabs` (query/get/sendMessage/reload/executeScript), `action.onClicked`
- [x] Built-in `_management` extension: toolbar (click-through, stable pins, 2x) + management panel + full-page UI
- [x] Guard built-in extensions from being disabled/uninstalled
- [x] Disable all / Enable all (batched, single reinject)
- [x] Hot reload (`fs.watch`) + `--autoreload` + build-hash + `node --check` verification
- [x] Demo extensions: `slack-channel-info`, `action-logger` (live overlay), `slack-hud` (overlay + Night Mode)
- [x] Verified cross-app: Slack, Antigravity, Grok Bot (all Electron)

## TODO
- [ ] **Match-pattern enforcement** — currently every enabled extension injects into every matched target regardless of its manifest `content_scripts.matches`/`exclude_matches`/globs. Enforce them so Slack-specific extensions don't load into Antigravity/Grok, and `all_frames`/`match_about_blank`/`match_origin_as_fallback` are respected. (Highest priority — its absence was visible when demo extensions leaked across apps.)
- [ ] `chrome.cookies` backed by CDP `Network` (getAllCookies/setCookie/deleteCookies) on the app's real cookie jar
- [ ] `chrome.declarativeNetRequest` / `chrome.webRequest` backed by CDP `Fetch` (requestPaused → continue/fulfill/fail)
- [ ] Background service worker (Node Worker) + `chrome.runtime` messaging between background and content scripts — so `action.onClicked` fires in the background (matching real Chrome), not the content world
- [ ] "Load unpacked…" folder picker in the management panel (host-side dialog → `management.loadUnpacked(path)`)
- [ ] Persistent `chrome.storage` (currently in-memory per host process; lost on host restart) — leveldb or JSON file
- [ ] `all_frames` / iframe targeting, multi-window auto-attach (use `Target.setDiscoverTargets` + `targetCreated` instead of polling)
- [ ] `bin/launch.mjs --app <name> --port <n>` helper: quit-if-running → relaunch with `--remote-debugging-port` → wait for CDP → start host (one command per app)
- [ ] `chrome.contextMenus`, `chrome.notifications`, `chrome.alarms`, `chrome.commands` (hotkey dispatch), `chrome.windows` (real)
- [ ] `chrome.scripting.executeScript/insertCSS` with `world: 'MAIN'|'ISOLATED'` and `files` (not just `code`)
- [ ] Document the `action.onClicked`-in-content-world deviation (goes away once background SW lands)
- [ ] WebKit Inspector Protocol transport backend (so the same `chrome.*` shim can drive Tauri/WKWebView apps on macOS — currently Electron/CDP only)
