// slack-inbox — v0.3 (real Discord data + real-Slack look & feel)
//
// Use the real Slack.app as a UI shell for cross-platform responsiveness
// (discord / email / linkedin / …). Inject one "discord - <name>" row per real
// Discord DM channel under the user's "bowei" sidebar section; clicking a row
// overlays a conversation panel that pulls *real* messages from Discord and
// sends real replies — rendered like a genuine aubergine Slack channel.
//
// Two halves, merged from the v0.2 spikes:
//   • n4 (data):  chrome.discord bridge (host-side via `latchkey curl`) → real DMs
//                 + real send. Token never reaches the page. Falls back to a fake
//                 "discord - alice" conversation when the bridge/creds are missing.
//   • n3 (looks): aubergine Slack theme, 36px avatars (real self avatar reused for
//                 'me' messages), colored sender names + timestamps, same-sender
//                 grouping, hover action bar, date divider, contenteditable
//                 composer, sidebar selection state + right-click context menu.
//
// Why the sidebar trick survives Slack's React virtualized sidebar: React owns
// row `top` but not `transform`, so we insert at (heading top + ROW_H) and
// translateY(nFake*ROW_H) every real row at/below the band; a MutationObserver
// re-applies on re-render.
//
// Harness hooks (window.__ewInbox):
//   .status() / .channels() / .open(id) / .close() / .refresh()
//   .capture() -> { visible, activeId, fakeMode, panelHtml, conversationHtml, conversation }
//   .select(id) / .deselect()
(() => {
  if (window.__ewInbox && window.__ewInbox._live) return;
  if (self !== top) return; // top frame only
  window.__ewInbox = true;

  const tag = (...m) => console.log('%c[slack-inbox]', 'color:#5865f2;font-weight:bold', ...m);
  tag('loaded', chrome.runtime.getId(), 'v' + chrome.runtime.getManifest().version, '| isolated world');

  // ---- config ----
  const SECTION_ID = 'L086AD6NLHZ';        // the "bowei" sidebar section heading
  const FAKE_MARK = 'ew-inbox-fake';        // data-ew attr marking our rows
  const ROW_H = 28;                         // px, Slack sidebar row height
  const MAX_ROWS = 14;                      // cap on injected discord rows (bumped from 8 so bot DMs like Carl-bot surface)
  const POLL_MS = 6000;                     // live refresh of the open thread
  const MSG_LIMIT = 50;
  const FAKE_QA = 'channel_sidebar_name_discord';

  // Slack aubergine-dark theme tokens (captured from the real app by the n3 pass).
  const C = {
    bg: '#1a1d21', hover: 'rgba(255,255,255,0.035)', rowHoverSidebar: 'rgba(255,255,255,0.06)',
    selected: '#7d3986', selectedText: '#efe1f5', idleText: 'rgba(227,206,235,0.8)',
    text: '#d1d2d3', sender: '#f8f8f8', ts: '#ababad', divider: 'rgba(255,255,255,0.07)',
    composerBg: '#222529', composerBorder: '#565856', composerFocus: '#616061',
    discord: '#36C5F0', me: '#f8f8f8',
  };
  const FONT = "Slack-Lato, Slack-Fractions, appleLogo, sans-serif";

  // ---- discord bridge (host-side via latchkey) ----
  const discord = window.chrome && window.chrome.discord;
  const haveBridge = !!(discord && discord.listDMs && discord.messages && discord.send && discord.status);

  // ---- fake fallback (only used when the bridge / creds are unavailable) ----
  const FAKE_CHANNEL = { id: '__fake_alice', name: 'alice', type: 1, recipients: [{ username: 'alice' }], fake: true };
  const FAKE_CONVERSATION = [
    { author: { username: 'alice' }, content: "hey! did you see the punkware demo?", when: '2:14 PM', day: 'Today' },
    { author: { username: 'bowei' }, content: "not yet — send the link?", when: '2:15 PM' },
    { author: { username: 'alice' }, content: "https://github.com/boweiliu/electron-webext — it injects extensions into the slack desktop app over CDP", when: '2:15 PM' },
    { author: { username: 'alice' }, content: "basically turns slack into a shell for cross-platform inboxes", when: '2:15 PM', group: true },
    { author: { username: 'bowei' }, content: "wait that's exactly what i wanted", when: '2:16 PM' },
    { author: { username: 'alice' }, content: "told you 😄 now it pulls my real DMs in", when: '2:16 PM' },
    { author: { username: 'bowei' }, content: "ok now make it real — pull my actual DMs in", when: '2:17 PM' },
  ];

  // ---- state ----
  const state = {
    channels: [], rows: [], activeId: null, messages: [],
    pollTimer: null, overlayHost: null, shadow: null,
    fakeMode: false, selected: false, // our sidebar row's selection state
    me: null, // { id, username }
    _meAvatar: '', // real self avatar URL (captured from the app)
    perChannelGroup: {}, // channelId -> last sender (for same-sender grouping)
  };

  // ---- helpers ----
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const headingEl = () => $(`[data-qa="channel_sidebar__section_heading_label__${SECTION_ID}"]`);
  const headingRow = () => (headingEl() ? headingEl().closest('[data-qa="virtual-list-item"]') : null);
  const scrollContainer = () => (headingRow() ? headingRow().parentElement : null);
  const topOf = (el) => parseInt(el.style.top || getComputedStyle(el).top, 10) || 0;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function linkify(html) { return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>'); }
  function nowTime() { const d = new Date(); let h = d.getHours(), m = d.getMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2,'0')} ${ap}`; }
  function fmtTime(ts) { if (!ts) return ''; try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } }
  function fmtDay(ts) { if (!ts) return null; try { const d = new Date(ts); const now = new Date(); if (d.toDateString() === now.toDateString()) return 'Today'; return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }); } catch { return null; } }

  function selfAvatarUrl() {
    const mc = document.querySelector('[data-qa="message_container"]');
    const img = (mc && mc.querySelector('img.c-base_icon--image')) || document.querySelector('img.c-base_icon--image');
    return img ? img.src : '';
  }

  function displayName(ch) {
    if (ch.recipients && ch.recipients.length === 1) return ch.recipients[0].username || 'unknown';
    if (ch.recipients && ch.recipients.length > 1) return ch.recipients.map(x => x.username).join(', ');
    return ch.name || ch.id;
  }
  function rowLabel(ch) { return 'discord - ' + displayName(ch); }
  function activeChannel() { return state.channels.find(c => c.id === state.activeId); }
  function isMe(author) { return !!(author && state.me && author.id === state.me.id); }
  // Slack-style member color: hash the username to a small palette.
  const PALETTE = ['#36C5F0','#E01E5A','#2EB67D','#ECB22E','#7423A0','#4A154B','#0B89A9','#D38B2D'];
  function senderColor(name) { if (!name) return C.idleText; let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0; return PALETTE[Math.abs(h) % PALETTE.length]; }

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
    // disown real channel identity so Slack can't confuse it
    const chan = $('.p-channel_sidebar__channel', row);
    if (chan) {
      chan.classList.remove('p-channel_sidebar__channel--selected');
      chan.setAttribute('data-qa-channel-sidebar-channel-is-selected', 'false');
      chan.setAttribute('data-qa-channel-sidebar-channel-id', 'EW-INBOX-' + ch.id);
    }
    const itemKey = row.getAttribute('data-item-key');
    if (itemKey) row.setAttribute('data-item-key', 'EW-INBOX-' + ch.id);
    $$('[data-qa]', row).forEach((el) => {
      const q = el.getAttribute('data-qa') || '';
      if (q.startsWith('channel_sidebar_name_')) el.setAttribute('data-qa', FAKE_QA);
    });
    const nameEl = $(`[data-qa="${FAKE_QA}"]`, row) || $('[data-qa^="channel_sidebar_name_"]', row);
    if (nameEl) {
      nameEl.setAttribute('data-qa', FAKE_QA);
      const span = nameEl.querySelector('span:last-child') || nameEl.querySelector('span') || nameEl;
      span.textContent = label;
    }
    $$('[data-qa="sidebar-channel-suffix"], [class*="unread"], [class*="badge"]', row).forEach((b) => (b.textContent = ''));
    row.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); selectRow(ch.id); openChannel(ch.id); }, { capture: true });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openRowMenu(e, ch); });
    return row;
  }

  // ---- selection state (re-applied on Slack re-renders) ----
  function applySelection() {
    const sc = scrollContainer();
    if (!sc) return;
    for (const r of $$(`[data-ew="${FAKE_MARK}"]`, sc)) {
      const sel = r.getAttribute('data-ew-channel') === state.activeId && state.selected;
      const chan = $('.p-channel_sidebar__channel', r);
      if (!chan) continue;
      chan.classList.toggle('p-channel_sidebar__channel--selected', sel);
      chan.setAttribute('data-qa-channel-sidebar-channel-is-selected', String(sel));
    }
    if (state.selected) {
      $$('[data-qa-channel-sidebar-channel-is-selected="true"]').forEach((el) => {
        if (el.closest(`[data-ew="${FAKE_MARK}"]`)) return;
        el.classList.remove('p-channel_sidebar__channel--selected');
        el.setAttribute('data-qa-channel-sidebar-channel-is-selected', 'false');
      });
    }
  }
  function selectRow(id) { state.activeId = id; state.selected = true; applySelection(); }
  function deselect() { state.selected = false; applySelection(); }

  // ---- simple right-click menu on a fake row ----
  let menuEl = null;
  function openRowMenu(e, ch) {
    closeRowMenu();
    menuEl = document.createElement('div');
    menuEl.setAttribute('data-ew', 'inbox-menu');
    menuEl.style.cssText = `position:fixed; left:${e.clientX}px; top:${e.clientY}px; z-index:2147483647;
      background:${C.bg}; border:1px solid #3a3a3a; border-radius:8px; padding:4px; min-width:180px;
      box-shadow:0 8px 24px rgba(0,0,0,.5); font:13px/1.4 ${FONT}; color:${C.text}`;
    const items = [
      ['Copy link', () => tag('copy link (demo)')],
      ['Mute channel', () => tag('mute (demo)')],
      ['Mark as read', () => tag('mark read (demo)')],
      ['Leave channel', () => { closeOverlay(); removeRow(ch.id); }],
    ];
    items.forEach(([label, fn]) => {
      const b = document.createElement('div');
      b.textContent = label;
      b.style.cssText = 'padding:6px 10px; border-radius:4px; cursor:pointer';
      b.onmouseenter = () => (b.style.background = C.rowHoverSidebar);
      b.onmouseleave = () => (b.style.background = 'transparent');
      b.onclick = (ev) => { ev.stopPropagation(); closeRowMenu(); fn(); };
      menuEl.appendChild(b);
    });
    document.documentElement.appendChild(menuEl);
    setTimeout(() => document.addEventListener('click', closeRowMenu, { once: true }), 0);
  }
  function closeRowMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }

  // ---- apply translateY to real rows below the fake band ----
  function applyShifts(bandTop, nFake) {
    const sc = scrollContainer();
    if (!sc) return;
    const shift = nFake * ROW_H;
    for (const r of $$('[data-qa="virtual-list-item"]', sc)) {
      if (r.getAttribute('data-ew') === FAKE_MARK) continue;
      r.style.transform = topOf(r) >= bandTop ? `translateY(${shift}px)` : 'none';
    }
  }

  // ---- (re)insert our rows ----
  function ensureRows() {
    const sc = scrollContainer();
    const head = headingRow();
    if (!sc || !head) return false;
    const existing = $$(`[data-ew="${FAKE_MARK}"]`, sc);
    if (existing.length !== state.rows.length) { existing.forEach(e => e.remove()); state.rows = []; }
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
      applyShifts(topOf(head) + ROW_H, state.rows.length);
    }
    applySelection();
    return true;
  }
  function removeRow(id) {
    const sc = scrollContainer();
    const row = sc?.querySelector(`[data-ew="${FAKE_MARK}"][data-ew-channel="${id}"]`);
    if (row) { row.remove(); state.rows = state.rows.filter(r => r.id !== id); state.channels = state.channels.filter(c => c.id !== id); applyShifts(topOf(headingRow()) + ROW_H, state.rows.length); }
  }

  // ---- MutationObserver ----
  let mo = null, scheduled = false;
  function scheduleSync() { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; ensureRows(); }); }
  function startObserver() {
    const sc = scrollContainer();
    if (!sc) return;
    mo = new MutationObserver(scheduleSync);
    mo.observe(sc, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-qa', 'top'] });
  }

  // ---- the message-pane overlay (mimics a real aubergine Slack channel) ----
  function buildOverlay() {
    state.overlayHost = document.createElement('div');
    state.overlayHost.id = 'ew-inbox-overlay-host';
    state.overlayHost.setAttribute('data-ew', 'inbox-overlay');
    state.shadow = state.overlayHost.attachShadow({ mode: 'closed' });
    state.shadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }
        #panel { position: fixed; top: 0; bottom: 0; right: 0; z-index: 2147483645;
          font: 15px/1.45 ${FONT}; color: ${C.text}; background: ${C.bg};
          display: flex; flex-direction: column; }
        .header { display:flex; align-items:center; gap:8px; height:38px; padding:0 16px;
          border-bottom:1px solid rgba(255,255,255,0.08); background:${C.bg};
          font-weight:900; color:${C.text}; flex:0 0 auto; }
        .hash { color:${C.idleText}; font-weight:700; }
        .title { color:${C.text}; font-size:15px; font-weight:900; }
        .src { color:${C.idleText}; font-weight:400; font-size:12px; margin-left:8px; }
        .members { margin-left:auto; display:flex; align-items:center; gap:6px; color:${C.idleText}; font-size:13px; font-weight:400; }
        .presence { width:8px; height:8px; border-radius:50%; background:#2eb67d; box-shadow:0 0 6px #2eb67d; }
        .status { font-size:11px; color:${C.idleText}; margin-right:8px; }
        .status.live { color:#3ba55d; } .status.off { color:#ed4245; }
        .day { display:flex; align-items:center; gap:12px; margin:14px 0 6px; padding:0 18px; }
        .day::before, .day::after { content:''; flex:1; height:1px; background:${C.divider}; }
        .day span { font-size:12px; font-weight:700; color:${C.idleText}; }
        .stream { flex:1; overflow-y:auto; padding:8px 0 14px; }
        .msg { position:relative; padding:6px 18px 6px 18px; }
        .msg:hover { background:${C.hover}; }
        .gutter { display:flex; gap:12px; }
        .avatar { width:36px; height:36px; flex:0 0 36px; border-radius:4px;
          display:flex; align-items:center; justify-content:center;
          font-weight:700; color:#fff; font-size:15px; overflow:hidden; }
        .avatar img { width:100%; height:100%; object-fit:cover; }
        .body { flex:1; min-width:0; }
        .head { display:flex; align-items:baseline; gap:8px; margin-bottom:0; }
        .name { font-weight:900; font-size:15px; }
        .ts { font-size:12px; color:${C.ts}; }
        .text { color:${C.text}; font-size:15px; line-height:22px; white-space:pre-wrap; word-break:break-word; }
        .text.system { color:${C.idleText}; font-style:italic; }
        .text a { color:#36C5F0; }
        .msg.group { padding-left:66px; }
        .msg.group .tsInline { font-size:11px; color:${C.ts}; opacity:0; margin-left:6px; }
        .msg.group:hover .tsInline { opacity:1; }
        .msg.pending { opacity:.5; }
        .actions { position:absolute; right:18px; top:-14px; display:none;
          background:${C.bg}; border:1px solid #3a3a3a; border-radius:6px;
          padding:2px; box-shadow:0 2px 8px rgba(0,0,0,.4); }
        .msg:hover .actions { display:flex; gap:1px; }
        .actions button { background:none; border:none; cursor:pointer; color:${C.idleText};
          padding:4px 6px; border-radius:4px; font-size:14px; }
        .actions button:hover { background:${C.rowHoverSidebar}; color:${C.text}; }
        .composer { flex:0 0 auto; padding:0 18px 18px; }
        .box { background:${C.composerBg}; border:1px solid ${C.composerBorder}; border-radius:8px;
          padding:8px 12px; transition:border-color .12s; }
        .box.focus { border-color:${C.composerFocus}; }
        .box[contenteditable] { min-height:24px; max-height:160px; overflow-y:auto; outline:none; color:${C.text}; font:15px/1.4 ${FONT}; }
        .box[contenteditable]:empty:before { content:attr(data-placeholder); color:${C.idleText}; }
        .foot { display:flex; align-items:center; gap:10px; padding:6px 2px 0; color:${C.idleText}; font-size:12px; }
        .foot kbd { background:#2a2d31; border:1px solid #3a3a3a; border-radius:3px; padding:0 4px; font:11px ui-monospace; }
      </style>
      <div id="panel">
        <div class="header">
          <span class="hash">#</span><span class="title" id="title">discord</span>
          <span class="src" id="src">· injected via electron-webext</span>
          <span class="status" id="status">…</span>
          <span class="members"><span class="presence"></span><span id="members">1 person · active</span></span>
        </div>
        <div class="stream" id="stream"><div id="msgs"></div></div>
        <div class="composer">
          <div class="box" id="box" contenteditable="true" data-placeholder="Message …"></div>
          <div class="foot"><span>press <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for newline</span><span style="margin-left:auto" id="footSrc">slack-inbox spike</span></div>
        </div>
      </div>`;
    document.documentElement.appendChild(state.overlayHost);
    const box = state.shadow.getElementById('box');
    box.addEventListener('focus', () => box.classList.add('focus'));
    box.addEventListener('blur', () => box.classList.remove('focus'));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const text = box.textContent.trim(); if (!text) return; sendCurrent(text); box.textContent = ''; }
    });
    window.addEventListener('resize', positionOverlay);
  }
  function positionOverlay() {
    if (!state.overlayHost) return;
    const sc = scrollContainer();
    let left = 260;
    if (sc) left = sc.getBoundingClientRect().right;
    const panel = state.shadow && state.shadow.getElementById('panel');
    if (panel) panel.style.left = left + 'px';
  }

  function renderHeader() {
    const ch = activeChannel();
    if (!ch) return;
    const label = rowLabel(ch);
    const title = state.shadow.getElementById('title');
    const src = state.shadow.getElementById('src');
    const box = state.shadow.getElementById('box');
    const footSrc = state.shadow.getElementById('footSrc');
    const members = state.shadow.getElementById('members');
    title.textContent = label;
    src.textContent = state.fakeMode ? '· fake mode (no discord creds)' : '· injected via electron-webext';
    box.setAttribute('data-placeholder', 'Message ' + label);
    footSrc.textContent = state.fakeMode ? 'slack-inbox · fake mode' : 'slack-inbox · live discord bridge via latchkey';
    const n = (ch.recipients && ch.recipients.length) ? ch.recipients.length : 1;
    members.textContent = `${n} ${n === 1 ? 'person' : 'people'} · active`;
  }
  function setStatus(kind, text) {
    const el = state.shadow && state.shadow.getElementById('status');
    if (!el) return;
    el.className = 'status ' + (kind === 'live' ? 'live' : kind === 'off' ? 'off' : '');
    el.textContent = text || '';
  }

  // normalize a discord message (or fake) into the shape renderMessage expects
  function norm(m) {
    if (m.who) return m; // fake fallback shape
    const me = isMe(m.author);
    const name = me ? (state.me?.username || 'me') : (m.author?.global_name || m.author?.username || '?');
    return {
      id: m.id, when: m.when || fmtTime(m.timestamp) || nowTime(), day: m.day || fmtDay(m.timestamp) || 'Today',
      me, name, text: m.content || '', group: !!m.group, system: !!m.system, pending: !!m._pending,
      avatarUrl: me ? state._meAvatar : '',
    };
  }
  function renderMessage(m) {
    const n = norm(m);
    const div = document.createElement('div');
    div.className = 'msg' + (n.group ? ' group' : '') + (n.pending ? ' pending' : '');
    if (n.group) {
      div.innerHTML = `<div class="text">${linkify(esc(n.text))}<span class="tsInline">${esc(n.when)}</span></div>`;
    } else {
      const av = n.me
        ? (state._meAvatar ? `<img src="${esc(state._meAvatar)}" alt="">` : esc((n.name||'?').slice(0,1).toUpperCase()))
        : esc((n.name||'?').slice(0,1).toUpperCase());
      const color = n.me ? C.me : senderColor(n.name);
      div.innerHTML = `
        <div class="gutter">
          <div class="avatar" style="${n.me?'':'background:'+color}">${av}</div>
          <div class="body">
            <div class="head"><span class="name" style="color:${color}">${esc(n.me ? 'me' : n.name)}</span><span class="ts">${esc(n.when)}</span></div>
            <div class="text${n.system?' system':''}">${linkify(esc(n.text))}</div>
          </div>
        </div>
        <div class="actions">
          <button title="react">😊</button><button title="share">↪</button><button title="save">🔖</button><button title="more">⋯</button>
        </div>`;
    }
    return div;
  }
  function renderMessages() {
    const stream = state.shadow.getElementById('stream');
    stream.innerHTML = '<div id="msgs"></div>';
    const msgs = state.shadow.getElementById('msgs');
    let lastSender = null, lastDay = null;
    for (const m of state.messages) {
      const n = norm(m);
      const day = n.day || 'Today';
      if (day !== lastDay) { const d = document.createElement('div'); d.className = 'day'; d.innerHTML = `<span>${esc(day)}</span>`; state.shadow.getElementById('stream').insertBefore(d, msgs); lastDay = day; lastSender = null; }
      // group if same sender as previous (within same day)
      m.group = (!lastDay || lastDay === day) && lastSender === (n.me ? '__me__' : n.name) ? true : false;
      msgs.appendChild(renderMessage(m));
      lastSender = n.me ? '__me__' : n.name;
    }
    stream.scrollTop = stream.scrollHeight;
  }
  function appendMessageNode(m) {
    const msgs = state.shadow.getElementById('msgs');
    const stream = state.shadow.getElementById('stream');
    const n = norm(m);
    const day = n.day || 'Today';
    // crude: assume same day as the last rendered day divider — if none, add one
    if (!stream.querySelector('.day')) { const d = document.createElement('div'); d.className = 'day'; d.innerHTML = `<span>${esc(day)}</span>`; stream.insertBefore(d, msgs); }
    m.group = false; // appended single message: show full header (could refine)
    msgs.appendChild(renderMessage(m));
    stream.scrollTop = stream.scrollHeight;
  }
  function renderError(msg) {
    const stream = state.shadow.getElementById('stream');
    stream.innerHTML = `<div id="msgs"></div>`;
    const d = document.createElement('div'); d.className = 'text system'; d.textContent = 'couldn’t load: ' + msg;
    stream.querySelector('#msgs').appendChild(d);
  }

  // ---- open / close ----
  async function openChannel(id) {
    if (!state.overlayHost) buildOverlay();
    state.overlayHost.style.display = '';
    positionOverlay();
    state.activeId = id;
    state.selected = true; applySelection();
    renderHeader();
    state.messages = [];
    state.shadow.getElementById('stream').innerHTML = '<div id="msgs"></div>';
    const ch = activeChannel();
    if (!ch) return;
    if (ch.fake) { state.fakeMode = true; state._meAvatar = selfAvatarUrl(); state.messages = FAKE_CONVERSATION.slice(); renderMessages(); setStatus('off', 'fake'); return; }
    state.fakeMode = false;
    state._meAvatar = selfAvatarUrl();
    setStatus('wait', 'loading…');
    try { await refresh(); setStatus('live', 'live'); }
    catch (e) { setStatus('off', 'error'); tag('load failed', e.message); renderError(e.message); }
    startPoll();
  }
  function closeOverlay() { if (state.overlayHost) state.overlayHost.style.display = 'none'; stopPoll(); state.activeId = null; deselect(); }

  // ---- fetch the active thread ----
  async function refresh() {
    const ch = activeChannel();
    if (!ch || ch.fake) return;
    if (!state.me) { try { const me = await discord.me(); state.me = { id: me.id, username: me.username }; } catch {} }
    const msgs = await discord.messages(ch.id, MSG_LIMIT); // newest first
    const ordered = [...(msgs || [])].reverse(); // oldest first
    if (state.messages.length === 0) { state.messages = ordered; renderMessages(); return; }
    const seen = new Set(state.messages.map(m => m.id).filter(Boolean));
    for (const m of ordered) { if (m.id && seen.has(m.id)) continue; seen.add(m.id); state.messages.push(m); appendMessageNode(m); }
    state.messages = state.messages.slice(-200);
  }

  // ---- send ----
  async function sendCurrent(text) {
    const ch = activeChannel();
    if (!ch) return;
    if (ch.fake || state.fakeMode) {
      const m = { author: { username: state.me?.username || 'bowei', id: state.me?.id }, content: text, when: nowTime(), day: 'Today' };
      state.messages.push(m); appendMessageNode(m); return;
    }
    const pending = { author: { username: state.me?.username || 'bowei', id: state.me?.id }, content: text, timestamp: Date.now(), _pending: true };
    state.messages.push(pending); appendMessageNode(pending);
    try { const sent = await discord.send(ch.id, text); Object.assign(pending, sent, { _pending: false }); }
    catch (e) { appendMessageNode({ author: { username: 'system' }, content: `send failed: ${e.message}`, system: true }); }
  }

  // ---- live poll ----
  function startPoll() { stopPoll(); state.pollTimer = setInterval(() => { if (state.activeId) refresh().catch(()=>{}); }, POLL_MS); }
  function stopPoll() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }

  // hide overlay + deselect when a real channel is clicked
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest(`[data-ew="${FAKE_MARK}"]`)) return;
    if (e.target.closest && e.target.closest(`[data-ew="inbox-menu"]`)) return;
    const real = e.target.closest && e.target.closest('[data-qa="channel-sidebar-channel"]');
    if (real && !real.closest(`[data-ew="${FAKE_MARK}"]`)) closeOverlay();
  }, { capture: true });

  // ---- discovery ----
  async function discoverChannels() {
    if (!haveBridge) { tag('no chrome.discord bridge — fake mode'); return [FAKE_CHANNEL]; }
    try {
      const st = await discord.status();
      if (!st.ok) { tag('bridge down:', st.reason, '— fake mode'); return [FAKE_CHANNEL]; }
      tag(st.bot ? 'bot-token discord account' : 'user-session discord account', st.account);
      const me = await discord.me(); state.me = { id: me.id, username: me.username };
      const chans = await discord.listDMs();
      const dms = (chans || []).filter(c => c.type === 1); // DMs only for the spike
      if (!dms.length) { tag('no DM channels; falling back to fake'); return [FAKE_CHANNEL]; }
      return dms.slice(0, MAX_ROWS).map(c => ({ id: c.id, type: c.type, name: c.name, recipients: c.recipients || [] }));
    } catch (e) { tag('discover failed:', e.message, '— fake mode'); return [FAKE_CHANNEL]; }
  }

  // ---- harness hooks ----
  window.__ewInbox = {
    _live: true,
    status: async () => (haveBridge ? discord.status() : { ok: false, reason: 'no chrome.discord bridge in this host' }),
    channels: () => state.channels.slice(),
    open: (id) => openChannel(id),
    close: closeOverlay,
    refresh: async () => refresh(),
    select: (id) => { selectRow(id); },
    deselect,
    capture: () => ({
      visible: !!(state.overlayHost && state.overlayHost.style.display !== 'none'),
      activeId: state.activeId, fakeMode: state.fakeMode,
      rows: scrollContainer()?.querySelectorAll(`[data-ew="${FAKE_MARK}"]`).length ?? 0,
      panelHtml: state.shadow?.getElementById('panel')?.innerHTML || null,
      conversationHtml: state.shadow?.getElementById('stream')?.innerHTML?.slice(0, 4000) || null,
      conversation: state.messages.slice(-50),
      theme: C,
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
