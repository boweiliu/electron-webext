// slack-inbox — cross-platform inbox spike, now wired to real Discord.
//
// Goal: use the real Slack.app as a UI shell for cross-platform responsiveness
// (discord / email / linkedin / …). This extension injects one "discord - <name>"
// row per Discord DM channel under the user's "bowei" sidebar section; clicking a
// row overlays a conversation panel that pulls *real* messages from Discord and
// sends real replies. All over CDP injection — no iframe, no cookie theft, no app
// repackaging.
//
// Where the Discord data comes from:
//   The content script runs in slack.com's renderer and can't reach discord.com
//   (cross-origin + CSP) and must never see the token. So the host exposes a
//   `chrome.discord` bridge (see bin/ew-host.mjs, backends.discord) that makes the
//   calls host-side via `latchkey curl`, where latchkey injects the stored
//   Authorization header. Credentials are configured out of band:
//     latchkey auth browser discord                         # user-session (real DMs)
//     latchkey auth set discord -H "Authorization: Bot ..."  # bot token
//
// If the bridge isn't present (e.g. the running host predates this change) or the
// creds are invalid, we fall back to the original fake "discord - alice" demo
// conversation so the spike still renders something useful.
//
// Why the sidebar trick works against Slack's React virtualized sidebar:
//   - The sidebar list is a `c-virtual_list__scroll_container`; every row is a
//     [data-qa="virtual-list-item"] positioned with an absolute `top` (px),
//     height 28, computed by Slack from the item's index.
//   - React owns `top` but does NOT touch `transform`. So we insert our fake rows
//     starting at (section heading top + ROW_H) and shift every real row at/below
//     the insertion band down by (nFake * ROW_H) via transform: translateY. React
//     can rewrite `top` all it wants; our transform persists. A MutationObserver
//     re-inserts + re-shifts whenever Slack re-renders.
//
// Harness hooks (window.__ewInbox):
//   .status()              -> bridge status (ok/reason)
//   .channels()            -> discovered Discord DM channels (or [] in fake mode)
//   .open(channelId)        -> open the overlay on a channel
//   .close()               -> hide the overlay
//   .capture()             -> { visible, rowsHtml, conversationHtml, conversation }
//   .refresh()             -> force refetch the active thread

(() => {
  if (window.__ewInbox && window.__ewInbox._live) return;
  if (self !== top) return; // top frame only
  const prev = window.__ewInbox;
  window.__ewInbox = true;

  const tag = (...m) => console.log('%c[slack-inbox]', 'color:#5865f2;font-weight:bold', ...m);
  tag('loaded', chrome.runtime.getId(), 'v' + chrome.runtime.getManifest().version, '| isolated world');

  // ---- config ----
  const SECTION_ID = 'L086AD6NLHZ';            // the "bowei" sidebar section heading
  const FAKE_MARK = 'ew-inbox-fake';           // data-ew attr marking our rows
  const OVERLAY_MARK = 'inbox-overlay';
  const ROW_H = 28;                            // px, Slack sidebar row height
  const MAX_ROWS = 8;                          // cap on injected discord rows
  const POLL_MS = 6000;                        // live refresh of the open thread
  const MSG_LIMIT = 50;

  // ---- discord bridge (host-side via latchkey) ----
  const discord = window.chrome && window.chrome.discord;
  const haveBridge = !!(discord && discord.listDMs && discord.messages && discord.send && discord.status);

  // ---- fake fallback (only used when the bridge / creds are unavailable) ----
  const FAKE_CHANNEL = {
    id: '__fake_alice',
    name: 'discord - alice',
    type: 1,
    recipients: [{ username: 'alice' }],
    fake: true,
  };
  const FAKE_CONVERSATION = [
    { author: { username: 'alice' }, content: "hey! did you see the punkware demo?", when: '2:14 PM' },
    { author: { username: 'bowei' }, content: "not yet — send the link?", when: '2:15 PM' },
    { author: { username: 'alice' }, content: "https://github.com/boweiliu/electron-webext — it injects extensions into the slack desktop app over CDP", when: '2:15 PM' },
    { author: { username: 'alice' }, content: "basically turns slack into a shell for cross-platform inboxes", when: '2:15 PM' },
    { author: { username: 'bowei' }, content: "wait that's exactly what i wanted", when: '2:16 PM' },
    { author: { username: 'alice' }, content: "told you 😄 now it pulls my real DMs in", when: '2:16 PM' },
  ];

  // ---- state ----
  const state = {
    channels: [],        // [{id,name,type,recipients:[{username}],fake?}]
    rows: [],            // [{id, el}]
    activeId: null,      // active channel id (overlay)
    messages: [],        // active channel messages (newest last)
    pollTimer: null,
    overlayHost: null, shadow: null,
    fakeMode: false,
  };

  // ---- helpers ----
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const headingEl = () => $(`[data-qa="channel_sidebar__section_heading_label__${SECTION_ID}"]`);
  const headingRow = () => (headingEl() ? headingEl().closest('[data-qa="virtual-list-item"]') : null);
  const scrollContainer = () => (headingRow() ? headingRow().parentElement : null);
  const topOf = (el) => parseInt(el.style.top || getComputedStyle(el).top, 10) || 0;
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // ---- name a discord channel for the sidebar row ----
  function displayName(ch) {
    if (ch.name) return ch.name;
    const r = ch.recipients || [];
    if (r.length === 1) return r[0].username || 'unknown';
    if (r.length > 1) return r.map(x => x.username).join(', ');
    return ch.id;
  }
  function rowLabel(ch) { return 'discord - ' + displayName(ch); }

  // ---- build one fake sidebar row by cloning a real channel row ----
  function buildRow(ch, insertionTop) {
    const tmpl = $('[data-qa="channel_sidebar_name_chat-bowei"]')?.closest('[data-qa="virtual-list-item"]')
              || $('[data-qa="channel_sidebar_name___private_bowei_draft"]')?.closest('[data-qa="virtual-list-item"]')
              || $$('[data-qa="channel-sidebar-channel"]')[0]?.closest('[data-qa="virtual-list-item"]');
    if (!tmpl) return null;
    const row = tmpl.cloneNode(true);
    row.removeAttribute('id');
    row.setAttribute('data-ew', FAKE_MARK);
    row.setAttribute('data-ew-channel', ch.id);
    row.setAttribute('aria-selected', 'false');
    row.style.top = insertionTop + 'px';
    row.style.transform = 'none';
    const label = rowLabel(ch);
    row.setAttribute('aria-label', label);
    const FAKE_QA = 'channel_sidebar_name_discord';
    $$('[data-qa]', row).forEach((el) => {
      const q = el.getAttribute('data-qa') || '';
      if (q.startsWith('channel_sidebar_name_')) el.setAttribute('data-qa', FAKE_QA);
    });
    const nameEl = $(`[data-qa="${FAKE_QA}"]`, row) || $('[data-qa^="channel_sidebar_name_"]', row);
    if (nameEl) {
      const span = nameEl.querySelector('span:not(:has(*))') || nameEl;
      span.textContent = label;
      nameEl.setAttribute('data-qa', FAKE_QA);
    }
    row.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openChannel(ch.id); }, { capture: true });
    return row;
  }

  // ---- apply translateY to real rows below the fake band ----
  function applyShifts(bandTop, nFake) {
    const sc = scrollContainer();
    if (!sc) return;
    const shift = nFake * ROW_H;
    for (const r of $$('[data-qa="virtual-list-item"]', sc)) {
      if (r.getAttribute('data-ew') === FAKE_MARK) continue;
      const t = topOf(r);
      r.style.transform = (t >= bandTop) ? `translateY(${shift}px)` : 'none';
    }
  }

  // ---- (re)insert our rows ----
  function ensureRows() {
    const sc = scrollContainer();
    const head = headingRow();
    if (!sc || !head) return false;
    const existing = $$(`[data-ew="${FAKE_MARK}"]`, sc);
    if (existing.length !== state.rows.length) {
      // (re)build: remove stale, rebuild
      existing.forEach(e => e.remove());
      state.rows = [];
    }
    if (state.rows.length === 0 && state.channels.length) {
      const bandTop = topOf(head) + ROW_H;
      let top = bandTop;
      for (const ch of state.channels.slice(0, MAX_ROWS)) {
        const row = buildRow(ch, top);
        if (!row) return false;
        sc.appendChild(row);
        state.rows.push({ id: ch.id, el: row });
        top += ROW_H;
      }
      applyShifts(bandTop, state.rows.length);
      tag('injected', state.rows.length, 'row(s) at band', bandTop);
    } else {
      // keep shifts fresh after Slack re-renders
      const bandTop = topOf(head) + ROW_H;
      applyShifts(bandTop, state.rows.length);
    }
    return true;
  }

  // ---- MutationObserver: re-inject + re-shift on Slack re-renders ----
  let mo = null, scheduled = false;
  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; ensureRows(); });
  }
  function startObserver() {
    const sc = scrollContainer();
    if (!sc) return;
    mo = new MutationObserver(scheduleSync);
    mo.observe(sc, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-qa', 'top'] });
  }

  // ---- conversation rendering (closed shadow DOM overlay) ----
  function nowTime() {
    const d = new Date(); let h = d.getHours(), m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${h}:${String(m).padStart(2,'0')} ${ap}`;
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function activeChannel() { return state.channels.find(c => c.id === state.activeId); }

  function buildOverlay() {
    state.overlayHost = document.createElement('div');
    state.overlayHost.id = 'ew-inbox-overlay-host';
    state.overlayHost.setAttribute('data-ew', OVERLAY_MARK);
    state.shadow = state.overlayHost.attachShadow({ mode: 'closed' });
    state.shadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }
        #panel { position: fixed; top: 0; bottom: 0; right: 0; z-index: 2147483645;
          font: 15px/1.45 'Slack Lato', -apple-system, system-ui, sans-serif;
          color: #d1d2d3; background: #1a1d21; display: flex; flex-direction: column;
          box-shadow: -20px 0 60px rgba(0,0,0,.5); }
        .header { display: flex; align-items: center; gap: 10px; padding: 12px 18px;
          border-bottom: 1px solid #2a2d31; background: #1a1d21; }
        .badge { width: 26px; height: 26px; border-radius: 50%; display:flex; align-items:center;
          justify-content:center; color:#fff; font-weight:700; font-size:13px;
          background: linear-gradient(135deg,#5865f2,#7c84fa); }
        .title { font-weight: 700; color: #f2f3f5; flex: 1; }
        .title .src { color:#74767d; font-weight:400; font-size:12px; margin-left:8px; }
        .status { font-size:11px; color:#74767d; margin-right:8px; }
        .status.live { color:#3ba55d; }
        .status.off { color:#ed4245; }
        .close { cursor:pointer; color:#9c9ba1; border:none; background:none; font-size:20px; padding:4px 8px; }
        .close:hover { color:#f2f3f5; }
        .stream { flex:1; overflow-y:auto; padding: 18px 18px 8px; }
        .day { text-align:center; color:#74767d; font-size:11px; margin: 10px 0 14px; text-transform:uppercase; letter-spacing:.5px; }
        .msg { display:flex; gap:12px; margin-bottom:14px; align-items:flex-start; }
        .avatar { width:36px; height:36px; border-radius:50%; flex:0 0 36px; display:flex;
          align-items:center; justify-content:center; font-weight:700; color:#fff; font-size:15px;
          background:#5865f2; }
        .bubble { max-width: 78%; }
        .meta { font-size:13px; margin-bottom:3px; }
        .name { font-weight:700; color:#f2f3f5; }
        .when { color:#74767d; margin-left:8px; }
        .text { color:#dbdee1; white-space:pre-wrap; word-break:break-word; }
        .text.system { color:#74767d; font-style:italic; }
        .pending { opacity:.5; }
        .composer { border-top:1px solid #2a2d31; padding:12px 18px; }
        .composer input { width:100%; background:#383a40; border:1px solid #4a4d52; border-radius:4px;
          color:#f2f3f5; padding:10px 12px; font:inherit; outline:none; }
        .composer input::placeholder { color:#74767d; }
        .foot { padding:6px 18px 10px; font-size:11px; color:#74767d; }
        .foot a { color:#5865f2; }
      </style>
      <div id="panel">
        <div class="header">
          <div class="badge" id="badge">D</div>
          <div class="title" id="title">discord<span class="src" id="src">· injected via electron-webext</span></div>
          <span class="status" id="status">…</span>
          <button class="close" id="close" title="close">×</button>
        </div>
        <div class="stream" id="stream"></div>
        <div class="composer"><input id="box" placeholder="Message …" /></div>
        <div class="foot" id="foot">slack-inbox · discord bridge via latchkey</div>
      </div>`;
    document.documentElement.appendChild(state.overlayHost);
    state.shadow.getElementById('close').onclick = closeOverlay;
    state.shadow.getElementById('box').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.value.trim()) { sendCurrent(e.target.value.trim()); e.target.value = ''; }
    });
    window.addEventListener('resize', positionOverlay);
  }
  function positionOverlay() {
    if (!state.overlayHost) return;
    const sc = scrollContainer();
    let left = 260;
    if (sc) left = sc.getBoundingClientRect().right;
    const panel = state.shadow.getElementById('panel');
    if (panel) panel.style.left = left + 'px';
  }

  function renderHeader() {
    const ch = activeChannel();
    const t = state.shadow.getElementById('title');
    const badge = state.shadow.getElementById('badge');
    const box = state.shadow.getElementById('box');
    const foot = state.shadow.getElementById('foot');
    if (!ch) return;
    const name = rowLabel(ch);
    t.firstChild.textContent = name;
    badge.textContent = displayName(ch).slice(0, 1).toUpperCase();
    box.placeholder = `Message ${name}`;
    foot.innerHTML = state.fakeMode
      ? 'slack-inbox · <b>fake mode</b> (no discord creds) — <a>latchkey auth browser discord</a>'
      : 'slack-inbox · live discord bridge via latchkey';
  }

  function setStatus(kind /* 'live'|'off'|'wait' */, text) {
    const el = state.shadow && state.shadow.getElementById('status');
    if (!el) return;
    el.className = 'status ' + (kind === 'live' ? 'live' : kind === 'off' ? 'off' : '');
    el.textContent = text || '';
  }

  function renderMessages() {
    const stream = state.shadow.getElementById('stream');
    stream.innerHTML = '';
    // group by day, newest last
    let lastDay = null;
    for (const m of state.messages) {
      const day = m.timestamp ? new Date(m.timestamp).toDateString() : null;
      if (day && day !== lastDay) {
        const d = document.createElement('div'); d.className = 'day'; d.textContent = day; stream.appendChild(d); lastDay = day;
      }
      stream.appendChild(messageNode(m));
    }
    stream.scrollTop = stream.scrollHeight;
  }
  function messageNode(m) {
    const me = isMe(m.author);
    const div = document.createElement('div');
    div.className = 'msg';
    if (m._pending) div.classList.add('pending');
    const name = m.author?.username || (m.author?.global_name) || '?';
    const av = (name || '?').slice(0, 1).toUpperCase();
    const text = m.content || '';
    div.innerHTML = `<div class="avatar">${escapeHtml(av)}</div>
      <div class="bubble"><div class="meta"><span class="name">${escapeHtml(me ? 'me' : name)}</span><span class="when">${escapeHtml(fmtTime(m.timestamp) || m.when || '')}</span></div>
      <div class="text${m.system ? ' system' : ''}">${escapeHtml(text)}</div></div>`;
    return div;
  }
  function appendMessageNode(m) {
    const stream = state.shadow.getElementById('stream');
    stream.appendChild(messageNode(m));
    stream.scrollTop = stream.scrollHeight;
  }
  // "me" heuristic: the discord bridge exposes who we are via __ewInbox.me()
  let _meId = null;
  function isMe(author) { return !!(author && _meId && author.id === _meId); }

  // ---- open / close ----
  async function openChannel(id) {
    if (!state.overlayHost) buildOverlay();
    state.overlayHost.style.display = '';
    positionOverlay();
    state.activeId = id;
    renderHeader();
    state.messages = [];
    state.shadow.getElementById('stream').innerHTML = '';
    const ch = activeChannel();
    if (!ch) return;
    if (ch.fake) { state.fakeMode = true; state.messages = FAKE_CONVERSATION.map(m => ({ author: m.author, content: m.content, when: m.when })); renderMessages(); setStatus('off', 'fake'); return; }
    state.fakeMode = false;
    setStatus('wait', 'loading…');
    try { await refresh(); setStatus('live', 'live'); }
    catch (e) { setStatus('off', 'error'); tag('load failed', e.message); renderError(e.message); }
    startPoll();
  }
  function closeOverlay() {
    if (state.overlayHost) state.overlayHost.style.display = 'none';
    stopPoll();
    state.activeId = null;
  }
  function renderError(msg) {
    const stream = state.shadow.getElementById('stream');
    stream.innerHTML = `<div class="text system">couldn’t load: ${escapeHtml(msg)}</div>`;
  }

  // ---- fetch the active thread ----
  async function refresh() {
    const ch = activeChannel();
    if (!ch || ch.fake) return;
    const msgs = await discord.messages(ch.id, MSG_LIMIT); // newest first
    const ordered = [...(msgs || [])].reverse(); // oldest first
    if (!_meId) { try { const me = await discord.me(); _meId = me.id; } catch {} }
    if (state.messages.length === 0) {
      state.messages = ordered;
      renderMessages();
      return;
    }
    const seen = new Set(state.messages.map(m => m.id).filter(Boolean));
    for (const m of ordered) {
      if (m.id && seen.has(m.id)) continue;
      seen.add(m.id);
      state.messages.push(m);
      appendMessageNode(m);
    }
    state.messages = state.messages.slice(-200);
  }

  // ---- send ----
  async function sendCurrent(text) {
    const ch = activeChannel();
    if (!ch) return;
    if (ch.fake || state.fakeMode) {
      const m = { author: { username: 'bowei', id: _meId }, content: text, when: nowTime(), _pending: false };
      state.messages.push(m); appendMessageNode(m); return;
    }
    const pending = { author: { username: 'bowei', id: _meId || 'me' }, content: text, timestamp: Date.now(), _pending: true };
    state.messages.push(pending); appendMessageNode(pending);
    try {
      const sent = await discord.send(ch.id, text);
      Object.assign(pending, sent, { _pending: false });
      // re-render that node? simplest: leave as-is, content matches
    } catch (e) {
      pending.content = `${text}  (failed: ${e.message})`;
      appendMessageNode({ author: { username: 'system' }, content: `send failed: ${e.message}`, system: true });
    }
  }

  // ---- live poll ----
  function startPoll() { stopPoll(); state.pollTimer = setInterval(() => { if (state.activeId) refresh().catch(()=>{}); }, POLL_MS); }
  function stopPoll() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }

  // hide overlay when a real channel is clicked
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest(`[data-ew="${FAKE_MARK}"]`)) return;
    const real = e.target.closest && e.target.closest('[data-qa="channel-sidebar-channel"], [data-qa^="channel_sidebar_name_"]');
    if (real && !real.closest(`[data-ew="${FAKE_MARK}"]`)) closeOverlay();
  }, { capture: true });

  // ---- discovery ----
  async function discoverChannels() {
    if (!haveBridge) { tag('no chrome.discord bridge — fake mode'); return [FAKE_CHANNEL]; }
    try {
      const st = await discord.status();
      if (!st.ok) { tag('bridge down:', st.reason, '— fake mode'); return [FAKE_CHANNEL]; }
      if (st.bot) tag('using bot-token discord account', st.account);
      else tag('using user-session discord account', st.account);
      const me = await discord.me(); _meId = me.id;
      const chans = await discord.listDMs();
      const dms = (chans || []).filter(c => c.type === 1); // DMs only for the spike
      if (!dms.length) { tag('no DM channels; falling back to fake'); return [FAKE_CHANNEL]; }
      return dms.slice(0, MAX_ROWS).map(c => ({ id: c.id, type: c.type, name: c.name, recipients: c.recipients || [] }));
    } catch (e) {
      tag('discover failed:', e.message, '— fake mode'); return [FAKE_CHANNEL];
    }
  }

  // ---- harness hooks ----
  window.__ewInbox = {
    _live: true,
    status: async () => (haveBridge ? discord.status() : { ok: false, reason: 'no chrome.discord bridge in this host' }),
    channels: () => state.channels.slice(),
    open: (id) => openChannel(id),
    close: closeOverlay,
    refresh: async () => refresh(),
    capture: () => ({
      visible: !!(state.overlayHost && state.overlayHost.style.display !== 'none'),
      activeId: state.activeId,
      fakeMode: state.fakeMode,
      rowsHtml: scrollContainer()?.querySelectorAll(`[data-ew="${FAKE_MARK}"]`).length + ' row(s)',
      conversationHtml: state.shadow?.getElementById('stream')?.innerHTML?.slice(0, 4000) || null,
      conversation: state.messages.slice(-50),
    }),
  };

  // ---- boot ----
  let tries = 0;
  const boot = setInterval(async () => {
    tries++;
    if (!state.channels.length) state.channels = await discoverChannels();
    if (state.channels.length && ensureRows()) {
      if (!mo) startObserver();
      tag('ready; channels:', state.channels.length, 'fake:', state.fakeMode);
      clearInterval(boot);
      return;
    }
    if (tries > 60) { tag('gave up waiting for sidebar after 60 tries'); clearInterval(boot); }
  }, 500);
  tag(haveBridge ? 'booting with discord bridge…' : 'booting (no bridge → fake mode)…');
})();
