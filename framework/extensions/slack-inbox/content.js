// slack-inbox — v0.2 (channel-realism pass)
//
// Inject a fake "discord - alice" channel under the user's "bowei" sidebar
// section that looks and behaves almost exactly like a real Slack channel:
//   - sidebar row: clone of a real channel row (inherits Slack's styling),
//     idle/selected state toggled on click, hover highlight.
//   - message pane: an aubergine-themed overlay mimicking Slack's message kit
//     (36px avatars, colored sender names + timestamp, grouped messages, hover
//     row highlight + action buttons, date divider) and a Slack-style composer
//     (rounded, focus ring, send on Enter).
//
// Why this survives Slack's React virtualized sidebar: React owns row `top`
// but not `transform`, so we insert at the heading top+28 and translateY(28px)
// every real row at/below that top; a MutationObserver re-applies on re-render.
//
// Harness hooks (window.__ewInbox, in this isolated world):
//   capture() -> { visible, fakeRowHtml, conversationHtml, conversation }
//   show() / hide() / toggle()
(() => {
  if (window.__ewInbox) return;
  if (self !== top) return; // top frame only
  window.__ewInbox = true;

  const tag = (...m) => console.log('%c[slack-inbox]', 'color:#5865f2;font-weight:bold', ...m);
  tag('loaded', chrome.runtime.getId(), 'v' + chrome.runtime.getManifest().version, '| isolated world');

  // ---- config ----
  const SECTION_ID = 'L086AD6NLHZ';
  const FAKE_NAME = 'discord - alice';
  const FAKE_QA = 'channel_sidebar_name_discord-alice';
  const FAKE_MARK = 'ew-inbox-fake';
  const ROW_H = 28;
  let selected = false; // our fake row's selection state (re-applied on Slack re-renders)

  // Slack aubergine-dark theme tokens (captured from the real app).
  const C = {
    bg: '#1a1d21',           // primary view / header bg
    panel: '#1a1d21',
    hover: 'rgba(255,255,255,0.035)', // message row hover
    rowHoverSidebar: 'rgba(255,255,255,0.06)',
    selected: '#7d3986',     // selected channel bg
    selectedText: '#efe1f5',
    idleText: 'rgba(227,206,235,0.8)',
    text: '#d1d2d3',         // message text
    sender: '#f8f8f8',       // "me" sender name (matches real app)
    ts: '#ababad',           // timestamp
    tsHover: '#d1d2d3',
    divider: 'rgba(255,255,255,0.07)',
    composerBg: '#222529',
    composerBorder: '#565856',
    composerFocus: '#616061', // slack focus border (aubergine-ish)
    alice: '#36C5F0',        // alice's member color (slack palette)
    me: '#f8f8f8',
  };
  const FONT = "Slack-Lato, Slack-Fractions, appleLogo, sans-serif";

  // ---- the conversation (grouped where same sender in a row) ----
  // `me` = Bowei, `alice` = Alice. `group: true` => same-sender continuation.
  const CONVERSATION = [
    { who: 'alice', name: 'Alice', when: '2:14 PM', day: 'Today', text: "hey! did you see the punkware demo?" },
    { who: 'me',    name: 'Bowei', when: '2:15 PM', text: "not yet — send the link?" },
    { who: 'alice', name: 'Alice', when: '2:15 PM', text: "https://github.com/boweiliu/electron-webext — it injects extensions into the slack desktop app over CDP" },
    { who: 'alice', name: 'Alice', when: '2:15 PM', group: true, text: "basically turns slack into a shell for cross-platform inboxes" },
    { who: 'me',    name: 'Bowei', when: '2:16 PM', text: "wait that's exactly what i wanted" },
    { who: 'alice', name: 'Alice', when: '2:16 PM', text: "told you 😄 first spike is a fake discord channel under your bowei section" },
    { who: 'me',    name: 'Bowei', when: '2:17 PM', text: "ok now make it real — pull my actual DMs in" },
  ];

  // ---- helpers ----
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const headingEl = () => $(`[data-qa="channel_sidebar__section_heading_label__${SECTION_ID}"]`);
  const headingRow = () => (headingEl() ? headingEl().closest('[data-qa="virtual-list-item"]') : null);
  const scrollContainer = () => {
    const h = headingRow();
    return h ? h.parentElement : null;
  };
  const topOf = (el) => parseInt(el.style.top || getComputedStyle(el).top, 10) || 0;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Grab the real self avatar URL (so "me" messages look exactly real).
  function selfAvatarUrl() {
    const mc = document.querySelector('[data-qa="message_container"]');
    const img = (mc && mc.querySelector('img.c-base_icon--image')) || document.querySelector('img.c-base_icon--image');
    return img ? img.src : '';
  }

  // ---- build the fake channel row by cloning a real one under the section ----
  function buildFakeRow(insertionTop) {
    const tmpl =
      $('[data-qa="channel_sidebar_name_chat-bowei"]')?.closest('[data-qa="virtual-list-item"]') ||
      $('[data-qa="channel_sidebar_name___private_bowei_draft"]')?.closest('[data-qa="virtual-list-item"]') ||
      $$('[data-qa="channel-sidebar-channel"]')[0]?.closest('[data-qa="virtual-list-item"]');
    if (!tmpl) return null;
    const row = tmpl.cloneNode(true);
    row.removeAttribute('id');
    row.setAttribute('data-ew', FAKE_MARK);
    row.setAttribute('aria-selected', 'false');
    row.style.top = insertionTop + 'px';
    row.style.transform = 'none';
    row.setAttribute('aria-label', FAKE_NAME);

    // disown the real channel identity so Slack can't confuse it
    const chan = $('.p-channel_sidebar__channel', row);
    if (chan) {
      chan.classList.remove('p-channel_sidebar__channel--selected');
      chan.setAttribute('data-qa-channel-sidebar-channel-is-selected', 'false');
      // stamp a fake channel id so nothing tries to load the real one
      chan.setAttribute('data-qa-channel-sidebar-channel-id', 'EW-INBOX-DISCORD-ALICE');
    }
    const itemKey = row.getAttribute('data-item-key');
    if (itemKey) row.setAttribute('data-item-key', 'EW-INBOX-DISCORD-ALICE');

    // rename every stamped data-qa inside
    $$('[data-qa]', row).forEach((el) => {
      const q = el.getAttribute('data-qa') || '';
      if (q.startsWith('channel_sidebar_name_')) el.setAttribute('data-qa', FAKE_QA);
    });
    const nameEl = $(`[data-qa="${FAKE_QA}"]`, row) || $('[data-qa^="channel_sidebar_name_"]', row);
    if (nameEl) {
      nameEl.setAttribute('data-qa', FAKE_QA);
      const span = nameEl.querySelector('span:last-child') || nameEl.querySelector('span') || nameEl;
      span.textContent = FAKE_NAME;
    }
    // clear any unread/mention badges copied from the source row
    $$('[data-qa="sidebar-channel-suffix"], [class*="unread"], [class*="badge"]', row).forEach((b) => (b.textContent = ''));

    row.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); selectFakeRow(); showOverlay(); }, { capture: true });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openRowMenu(e); });
    return row;
  }

  // ---- selection state (re-applied on Slack re-renders) ----
  function applySelection() {
    const row = scrollContainer()?.querySelector(`[data-ew="${FAKE_MARK}"]`);
    if (!row) return;
    const chan = $('.p-channel_sidebar__channel', row);
    if (!chan) return;
    chan.classList.toggle('p-channel_sidebar__channel--selected', selected);
    if (selected) {
      // deselect the currently-selected real channel so only ours is highlighted
      $$('[data-qa-channel-sidebar-channel-is-selected="true"]').forEach((el) => {
        if (el.closest(`[data-ew="${FAKE_MARK}"]`)) return;
        el.classList.remove('p-channel_sidebar__channel--selected');
        el.setAttribute('data-qa-channel-sidebar-channel-is-selected', 'false');
      });
    }
  }
  function selectFakeRow() { selected = true; applySelection(); }
  function deselectFakeRow() { selected = false; applySelection(); }

  // ---- simple right-click menu on the fake row ----
  let menuEl = null;
  function openRowMenu(e) {
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
      ['Leave channel', () => { hideOverlay(); removeFakeRow(); }],
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

  // ---- apply the translateY shift to every real row at/below the insertion ----
  function applyShifts(insertionTop) {
    const sc = scrollContainer();
    if (!sc) return;
    for (const r of $$('[data-qa="virtual-list-item"]', sc)) {
      if (r.getAttribute('data-ew') === FAKE_MARK) continue;
      r.style.transform = topOf(r) >= insertionTop ? `translateY(${ROW_H}px)` : 'none';
    }
  }

  // ---- insert (or re-insert) the fake row ----
  function ensureFakeRow() {
    const sc = scrollContainer();
    const head = headingRow();
    if (!sc || !head) return false;
    const existing = sc.querySelector(`[data-ew="${FAKE_MARK}"]`);
    if (existing) { applyShifts(topOf(existing)); applySelection(); return true; }
    const insertionTop = topOf(head) + ROW_H;
    const row = buildFakeRow(insertionTop);
    if (!row) return false;
    sc.appendChild(row);
    applyShifts(insertionTop);
    applySelection();
    tag('injected fake row at top', insertionTop);
    return true;
  }
  function removeFakeRow() {
    const sc = scrollContainer();
    const row = sc?.querySelector(`[data-ew="${FAKE_MARK}"]`);
    if (row) { row.remove(); applyShifts(topOf(headingRow()) + ROW_H); }
  }

  // ---- MutationObserver ----
  let mo = null, scheduled = false;
  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; ensureFakeRow(); });
  }
  function startObserver() {
    const sc = scrollContainer();
    if (!sc) return;
    mo = new MutationObserver(scheduleSync);
    mo.observe(sc, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-qa', 'top'] });
  }

  // ---- the message-pane overlay (mimics Slack aubergine channel view) ----
  let overlayHost = null, shadow = null;
  function buildOverlay() {
    overlayHost = document.createElement('div');
    overlayHost.id = 'ew-inbox-overlay-host';
    overlayHost.setAttribute('data-ew', 'inbox-overlay');
    shadow = overlayHost.attachShadow({ mode: 'closed' });
    const meAvatar = selfAvatarUrl();
    const aliceAvatar = ''; // initial avatar (drawn as colored circle below)
    shadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }
        #panel { position: fixed; top: 0; bottom: 0; right: 0; z-index: 2147483645;
          font: 15px/1.45 ${FONT}; color: ${C.text}; background: ${C.bg};
          display: flex; flex-direction: column; }
        /* header */
        .header { display:flex; align-items:center; gap:8px; height:38px; padding:0 16px;
          border-bottom:1px solid rgba(255,255,255,0.08); background:${C.bg};
          font-weight:900; color:${C.text}; flex:0 0 auto; }
        .hash { color:${C.idleText}; font-weight:700; }
        .title { color:${C.text}; font-size:15px; font-weight:900; }
        .src { color:${C.idleText}; font-weight:400; font-size:12px; margin-left:8px; }
        .members { margin-left:auto; display:flex; align-items:center; gap:6px; color:${C.idleText}; font-size:13px; font-weight:400; }
        .presence { width:8px; height:8px; border-radius:50%; background:#2eb67d; box-shadow:0 0 6px #2eb67d; }
        /* date divider */
        .day { display:flex; align-items:center; gap:12px; margin:14px 0 6px; padding:0 18px; }
        .day::before, .day::after { content:''; flex:1; height:1px; background:${C.divider}; }
        .day span { font-size:12px; font-weight:700; color:${C.idleText}; }
        /* message list */
        .stream { flex:1; overflow-y:auto; padding:8px 0 14px; }
        .msg { position:relative; padding:6px 18px 6px 18px; }
        .msg:hover { background:${C.hover}; }
        .gutter { display:flex; gap:12px; }
        .avatar { width:36px; height:36px; flex:0 0 36px; border-radius:4px;
          display:flex; align-items:center; justify-content:center;
          font-weight:700; color:#fff; font-size:15px; overflow:hidden; }
        .avatar img { width:100%; height:100%; object-fit:cover; }
        .avatar.alice { background:${C.alice}; }
        .avatar.me { background:${C.me}; color:#1a1d21; }
        .body { flex:1; min-width:0; }
        .head { display:flex; align-items:baseline; gap:8px; margin-bottom:0; }
        .name { font-weight:900; font-size:15px; }
        .name.alice { color:${C.alice}; }
        .name.me { color:${C.me}; }
        .ts { font-size:12px; color:${C.ts}; }
        .text { color:${C.text}; font-size:15px; line-height:22px; white-space:pre-wrap; word-break:break-word; }
        .text a { color:#36C5F0; }
        /* grouped (continuation) message */
        .msg.group { padding-left:66px; }
        .msg.group .text { color:${C.text}; }
        .msg.group .tsInline { font-size:11px; color:${C.ts}; opacity:0; margin-left:6px; }
        .msg.group:hover .tsInline { opacity:1; }
        /* hover action bar (slack-like) */
        .actions { position:absolute; right:18px; top:-14px; display:none;
          background:${C.bg}; border:1px solid #3a3a3a; border-radius:6px;
          padding:2px; box-shadow:0 2px 8px rgba(0,0,0,.4); }
        .msg:hover .actions { display:flex; gap:1px; }
        .actions button { background:none; border:none; cursor:pointer; color:${C.idleText};
          padding:4px 6px; border-radius:4px; font-size:14px; }
        .actions button:hover { background:${C.rowHoverSidebar}; color:${C.text}; }
        /* composer */
        .composer { flex:0 0 auto; padding:0 18px 18px; }
        .box { background:${C.composerBg}; border:1px solid ${C.composerBorder}; border-radius:8px;
          padding:8px 12px; transition:border-color .12s; }
        .box.focus { border-color:${C.composerFocus}; }
        .box[contenteditable] { min-height:24px; outline:none; color:${C.text}; font:15px/1.4 ${FONT}; }
        .box[contenteditable]:empty:before { content:attr(data-placeholder); color:${C.idleText}; }
        .foot { display:flex; align-items:center; gap:10px; padding:6px 2px 0; color:${C.idleText}; font-size:12px; }
        .foot kbd { background:#2a2d31; border:1px solid #3a3a3a; border-radius:3px; padding:0 4px; font:11px ui-monospace; }
      </style>
      <div id="panel">
        <div class="header">
          <span class="hash">#</span><span class="title">${esc(FAKE_NAME)}</span>
          <span class="src">· injected via electron-webext</span>
          <span class="members"><span class="presence"></span>1 person · active</span>
        </div>
        <div class="stream" id="stream">
          <div class="day"><span>Today</span></div>
          <div id="msgs"></div>
        </div>
        <div class="composer">
          <div class="box" id="box" contenteditable="true" data-placeholder="Message ${esc(FAKE_NAME)}"></div>
          <div class="foot"><span>press <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for newline</span><span style="margin-left:auto">slack-inbox spike</span></div>
        </div>
      </div>`;
    document.documentElement.appendChild(overlayHost);

    const msgsEl = shadow.getElementById('msgs');
    CONVERSATION.forEach((m) => msgsEl.appendChild(renderMessage(m, meAvatar)));

    const box = shadow.getElementById('box');
    box.addEventListener('focus', () => box.classList.add('focus'));
    box.addEventListener('blur', () => box.classList.remove('focus'));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = box.textContent.trim();
        if (!text) return;
        const m = { who: 'me', name: 'Bowei', when: nowTime(), text };
        CONVERSATION.push(m);
        msgsEl.appendChild(renderMessage(m, meAvatar));
        box.textContent = '';
        const stream = shadow.getElementById('stream');
        stream.scrollTop = stream.scrollHeight;
      }
    });

    positionOverlay();
  }

  function nowTime() {
    const d = new Date(); let h = d.getHours(), m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, '0')} ${ap}`;
  }

  function renderMessage(m, meAvatar) {
    const me = m.who === 'me';
    const div = document.createElement('div');
    div.className = 'msg' + (m.group ? ' group' : '');
    if (m.group) {
      div.innerHTML = `<div class="text">${linkify(esc(m.text))}<span class="tsInline">${esc(m.when)}</span></div>`;
    } else {
      const av = me
        ? (meAvatar ? `<img src="${esc(meAvatar)}" alt="">` : 'B')
        : 'A';
      div.innerHTML = `
        <div class="gutter">
          <div class="avatar ${me ? 'me' : 'alice'}">${av}</div>
          <div class="body">
            <div class="head"><span class="name ${me ? 'me' : 'alice'}">${esc(m.name)}</span><span class="ts">${esc(m.when)}</span></div>
            <div class="text">${linkify(esc(m.text))}</div>
          </div>
        </div>
        <div class="actions">
          <button title="react">😊</button>
          <button title="share">↪</button>
          <button title="save">🔖</button>
          <button title="more">⋯</button>
        </div>`;
    }
    return div;
  }

  // turn bare URLs into links
  function linkify(html) {
    return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  }

  function positionOverlay() {
    if (!overlayHost) return;
    const sc = scrollContainer();
    let left = 260;
    if (sc) left = sc.getBoundingClientRect().right;
    const panel = shadow && shadow.getElementById('panel');
    if (panel) panel.style.left = left + 'px';
  }
  window.addEventListener('resize', positionOverlay);

  function showOverlay() {
    if (!overlayHost) buildOverlay();
    overlayHost.style.display = '';
    positionOverlay();
    const stream = shadow && shadow.getElementById('stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
    tag('overlay shown');
  }
  function hideOverlay() { if (overlayHost) overlayHost.style.display = 'none'; }

  // hide overlay + deselect when a real channel is clicked
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest(`[data-ew="${FAKE_MARK}"]`)) return; // fake row handled above
    if (e.target.closest && e.target.closest(`[data-ew="inbox-menu"]`)) return;
    const real = e.target.closest && e.target.closest('[data-qa="channel-sidebar-channel"]');
    if (real && !real.closest(`[data-ew="${FAKE_MARK}"]`)) { hideOverlay(); deselectFakeRow(); }
  }, { capture: true });

  // ---- harness hooks ----
  window.__ewInbox = {
    capture: () => ({
      visible: !!(overlayHost && overlayHost.style.display !== 'none'),
      fakeRowHtml: scrollContainer()?.querySelector(`[data-ew="${FAKE_MARK}"]`)?.outerHTML || null,
      panelHtml: shadow?.getElementById('panel')?.innerHTML || null,
      conversationHtml: shadow?.getElementById('stream')?.innerHTML || null,
      conversation: CONVERSATION,
      theme: C,
    }),
    show: showOverlay,
    hide: hideOverlay,
    toggle: () => (overlayHost && overlayHost.style.display !== 'none' ? hideOverlay() : showOverlay()),
    select: selectFakeRow,
    deselect: deselectFakeRow,
  };

  // ---- boot ----
  let tries = 0;
  const boot = setInterval(() => {
    tries++;
    if (ensureFakeRow()) {
      if (!mo) startObserver();
      tag('fake channel ready');
      clearInterval(boot);
    } else if (tries > 60) {
      tag('gave up waiting for sidebar after 60 tries');
      clearInterval(boot);
    }
  }, 500);
  tag('booting; waiting for bowei sidebar section…');
})();
