# Spike: Slack Inbox — a fake cross-platform channel inside Slack

The first step toward using the real Slack desktop app as a **UI shell for
cross-platform responsiveness** (email / linkedin / discord), so you can answer
people outside your team from the workflow you already live in.

This spike injects a fake **"discord - alice"** channel under the user's "bowei"
sidebar section and renders a fake conversation in the message pane — all via
CDP injection (no iframe, no cookie theft, no app repackaging).

## What it does

- **Sidebar:** injects a "discord - alice" row as the first channel under the
  `bowei` sidebar section. It's a clone of a real channel row (so it inherits
  Slack's exact styling), renamed and re-stamped with our own `data-qa`. Idle by
  default; clicking it toggles `--selected` (aubergine purple #7d3986) and
  deselects the previously-active real channel. Right-click shows a Slack-style
  context menu (copy link / mute / mark read / leave).
- **Message pane:** clicking the fake row overlays a closed-shadow-DOM panel
  over the message area that mimics a real aubergine-dark Slack channel view:
  - **header** (`# discord - alice` + active presence + member count)
  - **message kit** — 36px avatars (the real self avatar is reused for "me"
    messages, so they look pixel-identical; Alice gets a Slack-colored initial
    circle), colored bold sender names + 12px timestamp, 15px/22px body text,
    same-sender grouping (continuation rows hide the avatar/name), date divider,
    and a hover action bar (😊 ↪ 🔖 ⋯) like Slack's.
  - **composer** — rounded `.c-wysiwyg_container` look (bg #222529, border #565856),
    focus ring, `Message discord - alice` placeholder, Enter to send (appends a
    real-looking "me" message), Shift+Enter for newline.
  - clicking a real channel, or the × button, hides the overlay and deselects.
- **Harness hooks:** `window.__ewInbox` (in the extension's isolated world)
  exposes `.capture() / .show() / .hide() / .toggle() / .select() / .deselect()`
  so an e2e/dev harness can read the rendered HTML + structured conversation and
  drive the overlay.

## How it survives Slack's React virtualized sidebar

The sidebar is a `c-virtual_list__scroll_container`; every row is a
`[data-qa="virtual-list-item"]` positioned with an absolute `top` (px), height
28, computed by Slack from the item's index. React owns `top` but does **not**
touch `transform`. So:

1. Insert the fake row at `top = (section heading top + 28)`.
2. Shift every real row at/ below that `top` down by one row-height via
   `transform: translateY(28px)`. React can rewrite `top` all it wants — our
   transform persists.
3. A `MutationObserver` on the scroll container re-inserts the fake row and
   re-applies the shifts whenever Slack re-renders.

Result: no overlaps, the fake channel reads as the first channel under the
section, and it survives Slack's re-renders.

## Run it

(Requires the Slack CDP setup from [SETUP-SLACK-CDP.md](SETUP-SLACK-CDP.md) —
i.e. Slack running with `--remote-debugging-port=9222` and the host attached.)

```bash
# start the host (auto-loads every extension under framework/extensions/):
node bin/ew-host.mjs --port 9222 --match slack.com
```

You should see "discord - alice" under your bowei section. Click it.

## Inspect / harness

```bash
# DOM-level check from the page main world:
node bin/eval.mjs '() => !!document.querySelector("[data-ew=\"ew-inbox-fake\"]")'

# read the harness hook from the extension's isolated world
# (the world name is logged by the host at inject time, e.g.
#  inject build=<hash> ewXXXX -> world ew:ewXXXX):
node bin/eval.mjs '() => window.__ewInbox.capture()' --world ew:ewXXXX

# screenshot the rendered Slack window:
node bin/screenshot.mjs /tmp/slack-inbox.png
```

## Next

- Make the conversation real: pull actual Discord DMs (via Discord API or a
  bridge) into the overlay instead of the fake `CONVERSATION` array.
- Add more fake channels under the section: one per external source
  (linkedin / gmail / …), each with its own overlay renderer.
- Persist state in `chrome.storage.local` (last open thread, unread counts).
- A screenshot + HTML-capture harness loop so an external e2e driver can assert
  on the rendered cross-platform inbox without a human in the loop.
