# Setting up CDP on the Slack macOS desktop app (straight-shot)

This is the one thing that has to work before anything else in this repo does:
getting Chrome DevTools Protocol (CDP) live on the real, logged-in Slack.app so
the host can inject extensions into it.

## The flag

Every Electron app honors `--remote-debugging-port=PORT`. The old one-liner was:

```bash
open -a Slack --args --remote-debugging-port=9222
```

That stopped working in **Slack 4.53.x** (Electron 45 / Chrome 156).

## Why it stopped working

Slack added a guard in `app.asar` → `dist/boot.bundle.cjs`. When the app is
packaged and any of `remote-debugging-port` / `remote-debugging-pipe` /
`remote-debugging-address` is on the command line, it requires a
`--user-data-dir` that resolves **outside** the protected profile dirs, and
refuses to launch otherwise:

```
Refusing to launch: --remote-debugging-port requires --user-data-dir pointing outside the default profile
```

The protected dirs (canonicalized via `realpath`, lowercased, trailing slash
stripped) are, under `<appData>` (`~/Library/Application Support`):

- `Slack`
- `SlackDevEnv`
- `SlackIntegrationTest`

So pointing `--user-data-dir` at the real `~/Library/Application Support/Slack`
is also refused ("is not allowed against the default profile"). The check fires
before the app boots; you cannot enable CDP on an already-running instance.

## The bypass (straight-shot)

Copy the **auth-relevant** parts of the real profile to a sibling dir, then
launch Slack against the copy with the debug flag. The big stuff in the real
profile is ~1GB of caches (`Cache`, `Service Worker`, `GPUCache`,
`GraphiteDawnCache`, `logs`); you don't need any of it for auth, so the copy is
~5MB.

```bash
# 0. Quit Slack fully first (the flag only takes effect on a fresh launch):
osascript -e 'tell application "Slack" to quit'
sleep 2
pkill -9 -f "Slack.app/Contents/MacOS/Slack" 2>/dev/null
sleep 1

# 1. Copy the auth-relevant profile parts to a sibling dir:
SRC=~/Library/Application\ Support/Slack
DST=~/slack-debug-profile
rm -rf "$DST"; mkdir -p "$DST"
for f in Cookies Cookies-journal "Local State" Preferences local-settings.json TransportSecurity; do
  [ -e "$SRC/$f" ] && cp -p "$SRC/$f" "$DST/$f"
done
for d in "Local Storage" IndexedDB storage "Session Storage" WebStorage Network "Shared Dictionary"; do
  [ -e "$SRC/$d" ] && cp -Rp "$SRC/$d" "$DST/$d"
done

# 2. Launch Slack with the debug port against the copied profile:
nohup /Applications/Slack.app/Contents/MacOS/Slack \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/slack-debug-profile" \
  >/tmp/slack-cdp.out 2>&1 &

# 3. Wait for CDP:
until curl -s --max-time 1 http://localhost:9222/json/version >/dev/null; do sleep 1; done
curl -s http://localhost:9222/json/version   # should print Browser / Electron version JSON
```

## Why login survives the copy

Slack stores its session in the profile's `Cookies` sqlite DB (plus
`Local Storage` / `IndexedDB` for client state). Those bytes are encrypted with
Chromium Safe Storage, whose key lives in the **macOS Keychain under the app's
identity**, not under the profile path. Because we're still running the same
`Slack.app` binary (just with a different `--user-data-dir`), the Keychain key
is unchanged, so the copied `Cookies` DB decrypts and you boot straight into
the client instead of `/signin`. No re-login, no token re-issue.

The first launch against the copied profile will re-create the caches
in `~/slack-debug-profile` — that's expected and fine; it's throwaway.

## Verify, then run the host

Confirm you're logged in (the list endpoint should show a `app.slack.com/client/...`
target, not `/signin`):

```bash
curl -s http://localhost:9222/json/list | python3 -c \
  "import json,sys;[print(t['type'],'|',t['url'][:90]) for t in json.load(sys.stdin)]"
```

Then start the host as usual:

```bash
cd ~/code/electron-webext
node bin/ew-host.mjs --port 9222 --match slack.com
```

You should see a dark toolbar pinned across the top of Slack, and the host
log lines:

```
[ew-host] attach target <id> page https://app.slack.com/client/...
[ew-host] inject build=<hash> _management -> world main ...
[ew-host] inject build=<hash> ew... -> world ew:... ...
```

## Quit / cleanup

```bash
# Stop the host:
pkill -f "bin/ew-host.mjs"

# Quit Slack (closes the port):
pkill -f "Slack.app/Contents/MacOS/Slack"

# Throw away the copied profile (it's just a debug copy; re-copy from the
# real profile next time to pick up fresh cookies):
rm -rf ~/slack-debug-profile
```

## Notes / gotchas

- `open -a Slack --args --remote-debugging-port=9222` silently drops the flag if
  Slack is already running (or mid-quit). Launch the binary directly, or ensure
  Slack is fully quit first. The binary path used above is the reliable form.
- Re-copy from the real profile whenever your Slack session refreshes (token
  rotation, re-login on the real app). The debug copy is a point-in-time
  snapshot; it does not sync back to the real profile.
- This is a local-dev bypass, not a distribution path. For a permanent setup
  you'd instead patch `app.asar` to neuter the guard (heavier: invalidates the
  code signature, needs an ad-hoc re-sign on Apple Silicon). The profile-copy
  approach keeps the signed app untouched.
- The guard is Slack-specific (in `app.asar`), not an Electron built-in. Other
  Electron apps that haven't added this check still work with the bare
  `--remote-debugging-port` flag (e.g. Antigravity, Grok Bot — see
  `docs/PROGRESS.md`).
