// slack-inbox — spike extension
//
// Goal: prove we can use the real Slack.app as a UI shell for cross-platform
// responsiveness (email / linkedin / discord) by injecting fake channels into
// the sidebar and rendering fake conversations in the message pane, all over CDP.
//
// This spike: a fake "discord - alice" channel under the user's "bowei" sidebar
// section, with a fake conversation shown in an overlay over the message pane.
//
// Why this works against Slack's React virtualized sidebar:
//   - The sidebar list is a `c-virtual_list__scroll_container`; every row is a
//     [data-qa="virtual-list-item"] positioned with an absolute `top` (px),
//     height 28, computed by Slack from the item's index.
//   - React owns `top` but does NOT touch `transform`. So we insert our fake row
//     at the insertion `top` and shift every real row at/ below that `top` down
//     by one row-height via `transform: translateY(28px)`. React can rewrite
//     `top` all it wants; our transform persists. A MutationObserver re-applies
//     the shift + re-inserts the fake row whenever Slack re-renders.
//
// Harness hooks (window.__ewInbox):
//   - capture()  -> { visible, fakeRowHtml, conversationHtml, sidebarSectionHtml }
//   - show() / hide() / toggle()
(() => {
  if (window.__ewInbox) return;
  if (self !== top) return; // top frame only
  window.__ewInbox = true;

  const tag = (...m) => console.log('%c[slack-inbox]', 'color:#5865f2;font-weight:bold', ...m);
  tag('loaded', chrome.runtime.getId(), 'v' + chrome.runtime.getManifest().version, '| isolated world');

  // ---- config ----
  const SECTION_ID = 'L086AD6NLHZ';                       // the "bowei" section heading
  const FAKE_NAME = 'discord - alice';                    // display name
  const FAKE_QA = 'channel_sidebar_name_discord-alice';   // data-qa we stamp on the row
  const FAKE_MARK = 'ew-inbox-fake';                     // data-ew attr to find our row
  const ROW_H = 28;                                      // px, matches Slack's sidebar row height

  // ---- the fake conversation ----
  const CONVERSATION = [
    { who: 'alice',  name: 'Alice',   when: '2:14 PM', text: "hey! did you see the punkware demo?" },
    { who: 'me',     name: 'Bowei',   when: '2:15 PM', text: "not yet — send the link?" },
    { who: 'alice',  name: 'Alice',   when: '2:15 PM', text: "https://github.com/boweiliu/electron-webext — it injects extensions into the slack desktop app over CDP" },
    { who: 'alice',  name: 'Alice',   when: '2:15 PM', text: "basically turns slack into a shell for cross-platform inboxes" },
    { who: 'me',     name: 'Bowei',   when: '2:16 PM', text: "wait that's exactly what i wanted" },
    { who: 'alice',  name: 'Alice',   when: '2:16 PM', text: "told you 😄 first spike is a fake discord channel under your bowei section" },
    { who: 'me',     name: 'Bowei',   when: '2:17 PM', text: "ok now make it real — pull my actual DMs in" },
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
  const topOf = (el) => {
    const t = el.style.top || getComputedStyle(el).top;
    return parseInt(t, 10) || 0;
  };

  // ---- build the fake channel row by cloning a real one under the section ----
  function buildFakeRow(insertionTop) {
    const tmpl = $('[data-qa="channel_sidebar_name_chat-bowei"]')?.closest('[data-qa="virtual-list-item"]')
              || $('[data-qa="channel_sidebar_name___private_bowei_draft"]')?.closest('[data-qa="virtual-list-item"]')
              || $$('[data-qa="channel-sidebar-channel"]')[0]?.closest('[data-qa="virtual-list-item"]');
    if (!tmpl) return null;
    const row = tmpl.cloneNode(true);
    // disown identity so React doesn't confuse it with the real row
    row.removeAttribute('id');
    row.setAttribute('data-ew', FAKE_MARK);
    row.setAttribute('aria-selected', 'false');
    // shift it into place
    row.style.top = insertionTop + 'px';
    row.style.transform = 'none';
    row.setAttribute('aria-label', FAKE_NAME);
    // rename every stamped data-qa inside so it's clearly ours
    $$('[data-qa]', row).forEach((el) => {
      const q = el.getAttribute('data-qa') || '';
      if (q.startsWith('channel_sidebar_name_')) el.setAttribute('data-qa', FAKE_QA);
      if (q === 'channel-sidebar-channel') el.setAttribute('data-qa', 'channel-sidebar-channel');
    });
    // set the visible name (the span inside channel_sidebar_name_*)
    const nameEl = $(`[data-qa="${FAKE_QA}"]`, row) || $('[data-qa^="channel_sidebar_name_"]', row);
    if (nameEl) {
      // name spans can nest; set text on the deepest text-bearing span
      const span = nameEl.querySelector('span:not(:has(*))') || nameEl;
      span.textContent = FAKE_NAME;
      nameEl.setAttribute('data-qa', FAKE_QA);
    }
    // swap the leading "#" glyph for a discord-ish badge so it reads as not-slack
    const icon = row.querySelector('[data-qa="channel_sidebar_name_discord-alice"], .c-icon--hash, [class*="hash"]', );
    // (best-effort; if the icon swap misses, the name still reads fine)
    row.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showOverlay(); }, { capture: true });
    return row;
  }

  // ---- apply the translateY shift to every real row at/below the insertion ----
  function applyShifts(insertionTop) {
    const sc = scrollContainer();
    if (!sc) return;
    const rows = $$('[data-qa="virtual-list-item"]', sc);
    for (const r of rows) {
      if (r.getAttribute('data-ew') === FAKE_MARK) continue; // never shift our own row
      const t = topOf(r);
      if (t >= insertionTop) r.style.transform = 'translateY(' + ROW_H + 'px)';
      else r.style.transform = 'none';
    }
  }

  // ---- insert (or re-insert) the fake row ----
  function ensureFakeRow() {
    const sc = scrollContainer();
    const head = headingRow();
    if (!sc || !head) return false;
    if (sc.querySelector(`[data-ew="${FAKE_MARK}"]`)) { // already there; just keep shifts fresh
      const fr = sc.querySelector(`[data-ew="${FAKE_MARK}"]`);
      applyShifts(topOf(fr));
      return true;
    }
    const insertionTop = topOf(head) + ROW_H;
    const row = buildFakeRow(insertionTop);
    if (!row) return false;
    // insert as the first child of the scroll container at this top; DOM order
    // doesn't matter (positioning is absolute), so just append.
    sc.appendChild(row);
    applyShifts(insertionTop);
    tag('injected fake row at top', insertionTop);
    return true;
  }

  // ---- MutationObserver: re-inject + re-shift on Slack re-renders ----
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

  // ---- the message-pane overlay (closed shadow DOM) ----
  let overlayHost = null, shadow = null;
  function buildOverlay() {
    overlayHost = document.createElement('div');
    overlayHost.id = 'ew-inbox-overlay-host';
    overlayHost.setAttribute('data-ew', 'inbox-overlay');
    shadow = overlayHost.attachShadow({ mode: 'closed' });
    const msgs = CONVERSATION.map((m, i) => {
      const me = m.who === 'me';
      return `
        <div class="msg ${me ? 'me' : 'them'}">
          <div class="avatar">${me ? 'B' : 'A'}</div>
          <div class="bubble">
            <div class="meta"><span class="name">${m.name}</span><span class="when">${m.when}</span></div>
            <div class="text">${escapeHtml(m.text)}</div>
          </div>
        </div>`;
    }).join('');
    shadow.innerHTML = `
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
        .close { cursor:pointer; color:#9c9ba1; border:none; background:none; font-size:20px; padding:4px 8px; }
        .close:hover { color:#f2f3f5; }
        .stream { flex:1; overflow-y:auto; padding: 18px 18px 8px; }
        .msg { display:flex; gap:12px; margin-bottom:18px; }
        .msg.me { flex-direction: row-reverse; }
        .avatar { width:36px; height:36px; border-radius:4px; flex:0 0 36px; display:flex;
          align-items:center; justify-content:center; font-weight:700; color:#fff; font-size:15px; }
        .msg.them .avatar { background:#5865f2; }
        .msg.me .avatar { background:#e01e5a; }
        .bubble { max-width: 70%; }
        .msg.me .bubble { text-align:right; }
        .meta { font-size:13px; margin-bottom:3px; }
        .name { font-weight:700; color:#f2f3f5; }
        .when { color:#74767d; margin-left:8px; }
        .text { color:#dbdee1; white-space:pre-wrap; word-break:break-word; }
        .composer { border-top:1px solid #2a2d31; padding:12px 18px; }
        .composer input { width:100%; background:#383a40; border:1px solid #4a4d52; border-radius:4px;
          color:#f2f3f5; padding:10px 12px; font:inherit; outline:none; }
        .composer input::placeholder { color:#74767d; }
        .foot { padding:6px 18px 10px; font-size:11px; color:#5865f2; }
      </style>
      <div id="panel">
        <div class="header">
          <div class="badge">A</div>
          <div class="title">discord - alice<span class="src">· injected via electron-webext</span></div>
          <button class="close" id="close" title="close">×</button>
        </div>
        <div class="stream" id="stream">${msgs}</div>
        <div class="composer"><input id="box" placeholder="Message discord - alice (demo, not wired)" /></div>
        <div class="foot">slack-inbox spike · fake conversation · window.__ewInbox.capture() for harness</div>
      </div>`;
    document.documentElement.appendChild(overlayHost);
    shadow.getElementById('close').onclick = hideOverlay;
    shadow.getElementById('box').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.value.trim()) {
        appendMessage({ who: 'me', name: 'Bowei', when: nowTime(), text: e.target.value.trim() });
        e.target.value = '';
      }
    });
    positionOverlay();
  }
  function nowTime() {
    const d = new Date();
    let h = d.getHours(), m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${h}:${String(m).padStart(2,'0')} ${ap}`;
  }
  function appendMessage(m) {
    CONVERSATION.push(m);
    const stream = shadow.getElementById('stream');
    const me = m.who === 'me';
    const div = document.createElement('div');
    div.className = 'msg ' + (me ? 'me' : 'them');
    div.innerHTML = `<div class="avatar">${me?'B':'A'}</div><div class="bubble"><div class="meta"><span class="name">${escapeHtml(m.name)}</span><span class="when">${escapeHtml(m.when)}</span></div><div class="text">${escapeHtml(m.text)}</div></div>`;
    stream.appendChild(div);
    stream.scrollTop = stream.scrollHeight;
  }
  function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function positionOverlay() {
    if (!overlayHost) return;
    const sc = scrollContainer();
    // left boundary = right edge of the sidebar (scroll container's nearest
    // positioned ancestor is the sidebar; its rect.right is the divider)
    let left = 260;
    if (sc) {
      const r = sc.getBoundingClientRect();
      left = r.right;
    }
    const panel = shadow.getElementById('panel');
    if (panel) panel.style.left = left + 'px';
  }
  window.addEventListener('resize', positionOverlay);

  function showOverlay() {
    if (!overlayHost) buildOverlay();
    overlayHost.style.display = '';
    positionOverlay();
    tag('overlay shown');
  }
  function hideOverlay() {
    if (overlayHost) overlayHost.style.display = 'none';
  }

  // hide overlay when a real channel is clicked (so leaving feels natural)
  document.addEventListener('click', (e) => {
    const fake = e.target.closest && e.target.closest(`[data-ew="${FAKE_MARK}"]`);
    if (fake) return; // fake row's own listener handles it
    const real = e.target.closest && e.target.closest('[data-qa="channel-sidebar-channel"], [data-qa^="channel_sidebar_name_"]');
    if (real && !real.closest(`[data-ew="${FAKE_MARK}"]`)) hideOverlay();
  }, { capture: true });

  // ---- harness hooks ----
  window.__ewInbox = {
    capture: () => ({
      visible: !!(overlayHost && overlayHost.style.display !== 'none'),
      fakeRowHtml: scrollContainer()?.querySelector(`[data-ew="${FAKE_MARK}"]`)?.outerHTML || null,
      conversationHtml: shadow?.getElementById('stream')?.innerHTML || null,
      sidebarSectionHtml: headingRow()?.closest('[data-qa="slack_kit_list"]')?.outerHTML?.slice(0, 4000) || null,
      conversation: CONVERSATION,
    }),
    show: showOverlay,
    hide: hideOverlay,
    toggle: () => (overlayHost && overlayHost.style.display !== 'none' ? hideOverlay() : showOverlay()),
  };

  // ---- boot (retry until the sidebar is present) ----
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
