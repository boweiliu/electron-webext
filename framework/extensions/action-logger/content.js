// action-logger — POC #2, now with a live on-screen log overlay.
// Renders a floating "console" panel (closed shadow DOM) that shows every event
// this extension receives: chrome.runtime.onMessage, chrome.storage.onChanged,
// chrome.action.onClicked. Clicking the Action Logger toolbar button exercises
// chrome.management.getAll + chrome.tabs.query + chrome.storage.local, and the
// resulting storage.onChanged shows up here too — a nice self-referential demo.
(() => {
  if (window.__ewActionLogger) return;
  if (self !== top) return; // top frame only
  window.__ewActionLogger = true;

  const tag = (...m) => console.log('%c[action-logger]', 'color:#e01e5a;font-weight:bold', ...m);
  const id = chrome.runtime.getId();
  tag('loaded ext', id, 'v' + chrome.runtime.getManifest().version, '| isolated world');

  // ---- overlay host + closed shadow DOM ----
  const HOST = document.createElement('div');
  HOST.id = 'ew-actionlog-host';
  const root = HOST.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }
      #panel { position: fixed; bottom: 16px; left: 16px; width: 380px; max-height: 300px;
        z-index: 2147483646; pointer-events: auto; display: flex; flex-direction: column;
        font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; color: #e8e8ec;
        background: rgba(20,22,28,.94); border: 1px solid #333; border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,.5); backdrop-filter: blur(8px); overflow: hidden; }
      .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #2a2f36;
        background: rgba(224,30,90,.12); }
      .title { font-weight: 700; font-size: 12px; letter-spacing: .3px; flex: 1; }
      .title .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#e01e5a; margin-right:6px; box-shadow:0 0 6px #e01e5a; }
      .count { color: #9aa; font-size: 11px; }
      button { pointer-events: auto; cursor: pointer; border: 1px solid #444; border-radius: 6px;
        background: #2a2f38; color: #e8e8ec; font-size: 11px; padding: 3px 8px; }
      button:hover { background: #353b46; }
      #list { overflow-y: auto; max-height: 260px; padding: 4px 0; }
      .row { display: flex; gap: 8px; padding: 4px 10px; border-bottom: 1px solid #23262c; align-items: flex-start; }
      .row:hover { background: #ffffff0a; }
      .ts { color: #666; font-family: ui-monospace, monospace; font-size: 10px; white-space: nowrap; padding-top: 1px; }
      .badge { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; white-space: nowrap; }
      .badge.msg { background: #16331f; color: #4ade80; }
      .badge.store { background: #11243a; color: #6ab8ff; }
      .badge.action { background: #3a2a10; color: #ffb000; }
      .txt { color: #cfd0d4; font-family: ui-monospace, monospace; font-size: 11px; word-break: break-word; flex: 1; }
      .empty { color: #666; padding: 14px; text-align: center; font-style: italic; }
    </style>
    <div id="panel">
      <div class="head">
        <span class="title"><span class="dot"></span>📋 Action Logger</span>
        <span class="count" id="count">0</span>
        <button id="clear" title="Clear">clear</button>
      </div>
      <div id="list"><div class="empty">waiting for events…</div></div>
    </div>
  `;
  document.documentElement.appendChild(HOST);

  const listEl = root.querySelector('#list');
  const countEl = root.querySelector('#count');
  root.querySelector('#clear').onclick = () => { entries.length = 0; render(); };

  // ---- log model ----
  const entries = [];
  const MAX = 200;
  function add(badge, text) {
    const ts = new Date().toLocaleTimeString();
    entries.push({ ts, badge, text });
    if (entries.length > MAX) entries.shift();
    render();
    tag(badge, text);
  }
  function render() {
    countEl.textContent = entries.length;
    if (!entries.length) { listEl.innerHTML = '<div class="empty">waiting for events…</div>'; return; }
    // only render the last 50 rows for perf
    const rows = entries.slice(-50).map(e => `
      <div class="row">
        <span class="ts">${e.ts}</span>
        <span class="badge ${e.cls}">${e.badge}</span>
        <span class="txt">${escapeHtml(e.text)}</span>
      </div>`).join('');
    listEl.innerHTML = rows;
    listEl.scrollTop = listEl.scrollHeight;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function logMsg(t) { add('onMessage', t, 'msg'); }
  function logStore(t) { add('storage.onChanged', t, 'store'); }
  function logAction(t) { add('action.onClicked', t, 'action'); }

  // ---- listeners (the actual API exercise) ----
  chrome.runtime.onMessage.addListener((msg) => {
    logMsg(JSON.stringify(msg));
  });
  chrome.storage.onChanged.addListener((changes) => {
    logStore(JSON.stringify(changes));
  });
  chrome.action.onClicked.addListener(async (ev) => {
    if (ev && ev.id && ev.id !== id) return; // only our own action
    logAction('exercising management.getAll + tabs.query + storage.local.set');
    const all = await chrome.management.getAll();
    const tabs = await chrome.tabs.query({});
    await chrome.storage.local.set({ lastAction: { at: Date.now(), extCount: all.length, tabCount: tabs.length, exts: all.map(e => e.id) } });
    logAction(`management.getAll -> ${all.length} exts: ${all.map(e => e.id).join(', ')}`);
    logAction(`tabs.query -> ${tabs.length} tabs: ${tabs.map(t => t.id).join(', ')}`);
  });

  render();
  tag('overlay mounted (bottom-left); listeners: onMessage, storage.onChanged, action.onClicked');
  window.__ewActionLogDebug = () => ({
    entries: entries.length, hostExists: !!document.getElementById('ew-actionlog-host'),
    last: entries[entries.length - 1],
  });
})();
