// slack-hud — demo extension
// Renders a floating "HUD" overlay (closed shadow DOM, so Slack's CSS/JS can't touch it)
// showing the live channel + workspace + a clock, with a Night Mode toggle that
// re-themes the real Slack UI by injecting/removing a <style> in the page <head>.
//
// The overlay is appended to documentElement (NOT body), and Night Mode filters
// `body` only — so the overlay and the electron-webext toolbar stay un-inverted.
(() => {
  if (window.__ewHud) return;
  if (self !== top) return; // top frame only
  window.__ewHud = true;

  const tag = (...m) => console.log('%c[slack-hud]', 'color:#ffb000;font-weight:bold', ...m);
  tag('loaded', chrome.runtime.getId(), 'v' + chrome.runtime.getManifest().version, '| isolated world');

  // ---- host + closed shadow DOM ----
  const HOST = document.createElement('div');
  HOST.id = 'ew-hud-host';
  const root = HOST.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }
      #hud { position: fixed; top: 16px; right: 16px; width: 280px; z-index: 2147483646;
        pointer-events: auto; font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
        color: #e8e8ec; border-radius: 16px; padding: 1px;
        background: linear-gradient(135deg, #ffb000, #e01e5a, #6a6ad0, #2a8ad0);
        background-size: 300% 300%; animation: ewhud 8s ease infinite;
        box-shadow: 0 12px 40px rgba(0,0,0,.45); }
      @keyframes ewhud { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
      #hud .inner { background: rgba(20,22,28,.92); backdrop-filter: blur(10px); border-radius: 15px; padding: 14px 16px; }
      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 8px #4ade80; animation: pulse 1.6s infinite; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
      .title { font-weight: 700; font-size: 13px; letter-spacing: .3px; }
      .title small { color: #888; font-weight: 400; }
      .row { display: flex; justify-content: space-between; align-items: baseline; color: #9aa; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
      .channel { font-size: 18px; font-weight: 700; color: #fff; margin: 2px 0 8px; word-break: break-word; }
      .workspace { font-size: 12px; color: #bbb; margin-bottom: 10px; }
      .clock { font: 700 22px/1 ui-monospace, monospace; color: #ffb000; text-align: center; margin: 6px 0 12px; letter-spacing: 1px; }
      .btns { display: flex; gap: 8px; }
      button { flex: 1; pointer-events: auto; cursor: pointer; border: 1px solid #444; border-radius: 9px;
        padding: 8px 10px; font: 600 12px/1 ui-sans-serif, system-ui, sans-serif; color: #e8e8ec;
        background: #2a2f38; transition: background .15s, transform .05s; }
      button:hover { background: #353b46; }
      button:active { transform: scale(.97); }
      button.on { background: #ffb000; color: #1a1a1a; border-color: #ffb000; }
      .foot { margin-top: 10px; font-size: 10px; color: #666; text-align: center; }
    </style>
    <div id="hud"><div class="inner">
      <div class="head"><span class="dot"></span><span class="title">⚡ Slack HUD <small>· electron-webext</small></span></div>
      <div class="row"><span>Current channel</span></div>
      <div class="channel" id="channel">…</div>
      <div class="row"><span>Workspace</span></div>
      <div class="workspace" id="workspace">…</div>
      <div class="row"><span>Local time</span></div>
      <div class="clock" id="clock">--:--:--</div>
      <div class="btns">
        <button id="night" title="Re-theme the Slack UI">🌙 Night Mode</button>
        <button id="ping" title="Broadcast a message to other extensions">📡 Ping</button>
      </div>
      <div class="foot">injected via CDP · isolated world</div>
    </div></div>
  `;
  document.documentElement.appendChild(HOST);

  const channelEl = root.querySelector('#channel');
  const workspaceEl = root.querySelector('#workspace');
  const clockEl = root.querySelector('#clock');
  const nightBtn = root.querySelector('#night');
  const pingBtn = root.querySelector('#ping');

  // ---- live channel + workspace from the page DOM (shared with the page) ----
  // Slack document.title looks like: "channel-name (Channel) - workspace - … - Slack"
  function readTitle() {
    const t = document.title || '';
    const parts = t.split(' - ');
    return { channel: parts[0] || t, workspace: parts[1] || '' };
  }
  async function refreshChannel() {
    const { channel, workspace } = readTitle();
    if (channelEl.textContent !== channel) {
      channelEl.textContent = channel || '(unknown)';
      workspaceEl.textContent = workspace || '';
      await chrome.storage.local.set({ channel, workspace, ts: Date.now() });
      chrome.runtime.sendMessage('_management', { from: chrome.runtime.getId(), kind: 'hud-channel', channel, workspace });
      tag('channel =', JSON.stringify(channel), '| workspace =', JSON.stringify(workspace));
    }
  }

  // ---- clock ----
  function tickClock() {
    const d = new Date();
    clockEl.textContent = d.toLocaleTimeString();
  }

  // ---- Night Mode: inject/remove a <style> in the page <head> ----
  const NIGHT_CSS = `
    /* re-theme Slack by inverting the body; images double-inverted to stay sane */
    body { filter: invert(1) hue-rotate(180deg) !important; background: #1a1a1a !important; }
    body img, body video, body picture { filter: invert(1) hue-rotate(180deg) !important; }
  `;
  let night = false;
  function applyNight() {
    const id = 'ew-night-mode';
    const existing = document.getElementById(id);
    if (night && !existing) {
      const s = document.createElement('style');
      s.id = id; s.textContent = NIGHT_CSS;
      (document.head || document.documentElement).appendChild(s);
    } else if (!night && existing) {
      existing.remove();
    }
    nightBtn.classList.toggle('on', night);
    nightBtn.textContent = night ? '☀️ Night Mode' : '🌙 Night Mode';
  }
  nightBtn.onclick = async () => {
    night = !night; applyNight();
    try { await chrome.storage.local.set({ nightMode: night }); } catch {}
    tag('night mode =', night);
  };

  // ---- ping: broadcast to other extensions (e.g. action-logger) ----
  pingBtn.onclick = () => {
    chrome.runtime.sendMessage('_management', { from: chrome.runtime.getId(), kind: 'hud-ping', at: Date.now() });
    tag('ping sent');
  };

  // ---- restore persisted night mode ----
  (async () => {
    try { const s = await chrome.storage.local.get('nightMode'); if (s.nightMode) { night = true; applyNight(); } } catch {}
  })();

  // ---- run ----
  refreshChannel();
  tickClock();
  setInterval(() => { refreshChannel(); tickClock(); }, 1000);
  tag('HUD mounted at top-right');

  // ---- debug hooks ----
  window.__ewHudDebug = () => ({
    channel: channelEl.textContent, workspace: workspaceEl.textContent,
    night, hostExists: !!document.getElementById('ew-hud-host'),
    nightStyleInHead: !!document.getElementById('ew-night-mode'),
  });
  window.__ewHudToggleNight = () => nightBtn.click();
  window.__ewHudPing = () => pingBtn.click();
})();
