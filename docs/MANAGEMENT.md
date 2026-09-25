# DESIGN — extensions management page (injected)

## Goal
A UI to manage loaded extensions (install/unpack, enable/disable, reload, view
errors, view source/manifest, permissions) — **injected into the actual Electron
app** so it's usable in-place, plus a full-page variant.

## Core decision: management is a built-in extension, not a special case
- The management UI is shipped as a built-in first-party extension `_management`
  that the host auto-loads.
- It consumes the **standard `chrome.management` API** (which we implement like any
  other `chrome.*` API). No special host code just for the UI — the UI is a normal
  client of our own API surface. This keeps the framework uniform and lets other
  extensions use `chrome.management` too.
- We also implement `chrome.runtime.reload`, `chrome.runtime.getManifest`,
  `chrome.management.install/uninstall` so the UI can drive the full lifecycle.

## `chrome.management` API surface (to implement in the host)
Standard methods we'll back:
- `getSelf()` → own extension info
- `getAll()` → all installed extensions (id, name, version, enabled, icons,
  permissions, installType, manifest)
- `get(id)` / `get([ids])`
- `setEnabled(id, enabled)` → toggle (controls whether content scripts inject +
  background runs)
- `uninstall(id)` → remove from loader, strip injections, stop background
- `install(path)` / `loadUnpacked(path)` → add a new extension from a folder
- `reload(id)` → re-parse manifest, re-inject all targets, restart background
  (same code path as the hot-reload watcher)
- `getPermissionWarnings(id)` / `setPermissionWarnings`
Events: `onInstalled`, `onUninstalled`, `onEnabled`, `onDisabled`.

## How you access it from inside Slack
There is no browser chrome to host a toolbar in, so we inject our own:

- **Top extension toolbar** (`toolbar.js`, part of the `_management` extension):
  a slim, draggable, collapsible bar pinned to the top center of the Slack
  window (closed shadow DOM, so Slack's CSS/JS can't touch it). It shows:
  - one action button per loaded extension (icon from its `action.default_icon`),
    clicking it opens the extension's `default_popup` (or fires
    `chrome.action.onClicked` if no popup);
  - a ⚙ management button → opens the management panel;
  - a –/+ minimize button (state persisted in `chrome.storage.local`).
- **Hotkey**: `Cmd/Ctrl+Shift+E` toggles the whole injected chrome (toolbar + panel).
- **Fallback gear**: if the toolbar is disabled, a small floating ⚙ button opens the panel.
- **Full page**: the ⚙ → "Open full page" (or `http://localhost:<port>/manage`) gives the
  `chrome://extensions`-style page in any browser.

The toolbar stays in sync via `chrome.management.onInstalled/onUninstalled/onEnabled`
so new extensions appear as buttons live.

## Delivery mode 1 — injected overlay panel (primary)
- `_management` content script matches `<all_urls>` (or the app's origins), runs
  in the **main world** (so it can render over the app freely) but renders into a
  **closed shadow DOM** root so the app's CSS/JS can't interfere.
- Panel is hidden by default; toggled by:
  - a `chrome.commands` shortcut (e.g. Cmd/Ctrl+Shift+E) → host dispatches a
    command event to the management content script, OR
  - a tiny floating "gear" button (also shadow-DOM) in a corner, draggable.
- Panel shows the extension list + controls + a "Load unpacked…" folder picker
  (uses `Page.setInterceptFileChooserDialog` / a binding to the host's dialog) +
  live error log (surfaced from `Runtime.exceptionThrown` per target).
- Talks to the host via the same `Runtime.addBinding` bridge as any content
  script; `chrome.management.*` calls go page→host→backend.

## Delivery mode 2 — full-page UI
- `_management/management.html` is served by the host's built-in localhost HTTP
  server (the same one that serves the WS bridge) at
  `http://localhost:<port>/manage`.
- Open in any browser; connects over WS to the host; same `chrome.management`
  calls (transport swapped: WS instead of CDP binding, same message schema).
- Useful for a bigger view / when you don't want to overlay the app.

## Skeleton (planned files)
```
framework/
  extensions/
    _management/            # built-in, auto-loaded by host
      manifest.json
      panel.js             # shadow-DOM overlay, calls chrome.management
      panel.css
      management.html      # full-page variant
      background.js         # optional: refresh polling, install events
  host/
    api/
      management.js        # chrome.management backend (getAll/setEnabled/...)
    server.js              # localhost HTTP + WS for full-page UI
```

## Why this is nice
- Zero special-casing: management UI = an extension using `chrome.management`.
- The injected overlay means you manage extensions **from inside Slack** while
  looking at Slack — matches the hot-mod ethos.
- Full-page variant gives a familiar `chrome://extensions`-like experience.
- `chrome.management` being standard means third-party extensions can build
  alternative managers / auto-updaters on top.
