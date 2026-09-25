// toolbar.js — injected (main world) by electron-webext into each renderer target.
// Renders a slim, draggable, collapsible "extension toolbar" over the app (Slack),
// showing one action button per loaded extension + a management (⚙) button that
// opens the management panel. This is our substitute for Chrome's browser toolbar,
// since we have no browser chrome to host it in.

(() => {
  if (window.__ewToolbar__) return; // idempotent
  if (self !== top) return; // only render the toolbar in the top frame
  window.__ewToolbar__ = true;

  const HOST = document.createElement("div");
  HOST.id = "ew-toolbar-host";
  const root = HOST.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }
      #bar { position: fixed; top: 0; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; display: flex; align-items: center; gap: 8px;
        height: 60px; padding: 0 12px; border-radius: 0 0 20px 20px;
        background: rgba(28,30,36,.92); color: #e6e6e6; font: 24px/1 ui-sans-serif,system-ui,sans-serif;
        box-shadow: 0 8px 32px rgba(0,0,0,.45); border: 1px solid #333; border-top: none;
        backdrop-filter: blur(8px); user-select: none; cursor: default;
        pointer-events: none; } /* bar background is click-through; only buttons capture */
      #bar.minimized { left: auto; right: 16px; transform: none; border-radius: 16px; }
      #bar.minimized .ext-btn, #bar.minimized .brand, #bar.minimized .sep { display: none; }
      #bar .ext-btn, #bar .icon-btn, #bar .brand { pointer-events: auto; } /* buttons capture clicks */
      .brand { font-weight: 600; color: #6ad; padding: 0 8px 0 4px; cursor: default; font-size: 28px; }
      .ext-btn { width: 44px; height: 44px; border: none; border-radius: 10px; background: transparent;
        color: #e6e6e6; cursor: pointer; display: flex; align-items: center; justify-content: center;
        padding: 0; overflow: hidden; }
      .ext-btn:hover { background: #ffffff22; }
      .ext-btn img { width: 32px; height: 32px; }
      .ext-btn[disabled] { opacity: .35; cursor: default; }
      .sep { width: 2px; height: 32px; background: #444; margin: 0 4px; }
      .icon-btn { width: 44px; height: 44px; border: none; border-radius: 10px; background: transparent;
        color: #e6e6e6; cursor: pointer; font-size: 26px; display: flex; align-items: center; justify-content: center; }
      .icon-btn:hover { background: #ffffff22; }
      .icon-btn.mgmt { color: #6ad; }
      .tip { position: absolute; top: 64px; background: #1f2228; color: #ddd; padding: 6px 12px;
        border-radius: 8px; white-space: nowrap; font-size: 22px; pointer-events: none; display: none; }
      #pin-pop { position: absolute; top: 64px; right: 0; background: #1f2228; border: 1px solid #333;
        border-radius: 12px; padding: 10px; z-index: 2147483647; box-shadow: 0 8px 32px rgba(0,0,0,.5);
        pointer-events: auto; display: none; }
      #pin-pop.open { display: grid; grid-template-columns: repeat(3, 56px); grid-gap: 8px; }
      #pin-pop .pos { width: 56px; height: 40px; border: 1px solid #444; border-radius: 8px;
        background: #2a2f38; color: #e6e6e6; cursor: pointer; font-size: 14px; display: flex;
        align-items: center; justify-content: center; position: relative; }
      #pin-pop .pos:hover { background: #353b46; }
      #pin-pop .pos.active { border-color: #6ad; color: #6ad; }
      #pin-pop .pos .dot { position: absolute; width: 10px; height: 10px; border-radius: 50%;
        background: currentColor; }
      #pin-pop .pos.tl .dot { top: 4px; left: 4px; } #pin-pop .pos.tc .dot { top: 4px; left: 50%; transform: translateX(-50%); }
      #pin-pop .pos.tr .dot { top: 4px; right: 4px; } #pin-pop .pos.bl .dot { bottom: 4px; left: 4px; }
      #pin-pop .pos.bc .dot { bottom: 4px; left: 50%; transform: translateX(-50%); } #pin-pop .pos.br .dot { bottom: 4px; right: 4px; }
    </style>
    <div id="bar">
      <span class="brand" title="electron-webext">⚡</span>
      <span class="sep"></span>
      <div id="exts" style="display:flex;align-items:center;gap:2px"></div>
      <span class="sep"></span>
      <button class="icon-btn mgmt" title="Extensions (Cmd/Ctrl+Shift+E)">⚙</button>
      <button class="icon-btn" title="Pin position">📌</button>
      <button class="icon-btn" title="Minimize toolbar">–</button>
      <div id="pin-pop">
        <div class="pos tl" data-pos="TL"><span class="dot"></span></div>
        <div class="pos tc" data-pos="TC"><span class="dot"></span></div>
        <div class="pos tr" data-pos="TR"><span class="dot"></span></div>
        <div class="pos bl" data-pos="BL"><span class="dot"></span></div>
        <div class="pos bc" data-pos="BC"><span class="dot"></span></div>
        <div class="pos br" data-pos="BR"><span class="dot"></span></div>
      </div>
    </div>
    <div class="tip" id="tip"></div>
  `;
  document.documentElement.appendChild(HOST);

  const bar = root.querySelector("#bar");
  const extsEl = root.querySelector("#exts");
  const tip = root.querySelector("#tip");
  const mgmt = root.querySelector(".icon-btn.mgmt");
  const minBtn = root.querySelector(".icon-btn[title^='Minimize']");

  // --- minimize / restore, persisted in chrome.storage.local ---
  let minimized = false;
  async function loadState() {
    try { const s = await chrome.storage.local.get("ew-toolbar"); minimized = !!s["ew-toolbar"]?.min; if (s["ew-toolbar"]?.pin) pin = s["ew-toolbar"].pin; }
    catch { /* shim not ready yet */ }
    applyMin();
    applyPin();
  }
  function applyMin() { bar.classList.toggle("minimized", minimized); minBtn.textContent = minimized ? "+" : "–"; if (!minimized) applyPin(); }
  minBtn.onclick = async () => {
    minimized = !minimized; applyMin();
    try { await chrome.storage.local.set({ "ew-toolbar": { min: minimized, pin } }); } catch {}
  };

  // --- stable pins (replaces free drag, which was jumpy) ---
  const POS = {
    TL: { top: "0px", left: "0px", right: "auto", bottom: "auto", transform: "none", br: "0 0 16px 16px" },
    TC: { top: "0px", left: "50%", right: "auto", bottom: "auto", transform: "translateX(-50%)", br: "0 0 20px 20px" },
    TR: { top: "0px", left: "auto", right: "0px", bottom: "auto", transform: "none", br: "0 0 16px 16px" },
    BL: { top: "auto", left: "0px", right: "auto", bottom: "0px", transform: "none", br: "16px 16px 0 0" },
    BC: { top: "auto", left: "50%", right: "auto", bottom: "0px", transform: "translateX(-50%)", br: "20px 20px 0 0" },
    BR: { top: "auto", left: "auto", right: "0px", bottom: "0px", transform: "none", br: "16px 16px 0 0" },
  };
  let pin = "TC";
  const pinPop = root.querySelector("#pin-pop");
  const pinBtn = root.querySelector(".icon-btn[title='Pin position']");
  function applyPin() {
    if (minimized) return; // minimized mode uses its own fixed pos
    const p = POS[pin];
    bar.style.top = p.top; bar.style.left = p.left; bar.style.right = p.right;
    bar.style.bottom = p.bottom; bar.style.transform = p.transform;
    bar.style.borderRadius = p.br;
    for (const el of pinPop.querySelectorAll(".pos")) el.classList.toggle("active", el.dataset.pos === pin);
    // popover opens away from the screen edge: above the bar for bottom pins, below for top pins
    if (pin.startsWith("B")) { pinPop.style.top = "auto"; pinPop.style.bottom = "64px"; }
    else { pinPop.style.top = "64px"; pinPop.style.bottom = "auto"; }
  }
  pinBtn.onclick = (e) => { e.stopPropagation(); pinPop.classList.toggle("open"); };
  for (const el of pinPop.querySelectorAll(".pos")) {
    el.onclick = (e) => { e.stopPropagation(); pin = el.dataset.pos; applyPin(); pinPop.classList.remove("open");
      try { chrome.storage.local.set({ "ew-toolbar": { min: minimized, pin } }); } catch {} };
  }
  // click outside closes the popover
  document.addEventListener("click", () => pinPop.classList.remove("open"));
  pinPop.addEventListener("click", (e) => e.stopPropagation());

  // --- management panel toggle ---
  mgmt.onclick = () => window.__ewToggleManagementPanel?.();
  // hotkey: Cmd/Ctrl+Shift+E toggles the whole chrome (toolbar + panel)
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      HOST.style.display = HOST.style.display === "none" ? "" : "none";
      window.__ewToggleManagementPanel?.();
    }
  });

  // --- render one button per loaded extension's `action` ---
  function iconURL(e) {
    const a = e.manifest?.action || e.manifest?.browser_action || {};
    const icons = a.default_icon || e.icons || {};
    const pick = icons["16"] || icons["32"] || icons["48"] || (typeof icons === "string" ? icons : null);
    if (!pick) return null;
    return e.icons?.[pick] || (typeof pick === "object" ? (pick["16"] || pick["32"] || Object.values(pick)[0]) : pick);
  }
  async function refresh() {
    let all = [];
    try { all = await chrome.management.getAll(); } catch { return; }
    extsEl.innerHTML = "";
    for (const e of all) {
      if (e.id === "_management") continue; // management is the ⚙ button, not a slot
      const a = e.manifest?.action || e.manifest?.browser_action;
      if (!a && !e.manifest?.action) { /* still show if it has icons? skip if no action */ }
      const b = document.createElement("button");
      b.className = "ext-btn";
      b.dataset.id = e.id;
      b.title = e.name;
      const u = iconURL(e);
      if (u) { const img = document.createElement("img"); img.src = u; b.appendChild(img); }
      else b.textContent = (e.name || e.id).slice(0, 1).toUpperCase();
      if (!e.enabled) b.disabled = true;
      b.onmouseenter = (ev) => { tip.textContent = e.name; tip.style.left = ev.clientX + "px"; tip.style.display = "block"; };
      b.onmouseleave = () => tip.style.display = "none";
      b.onclick = () => {
        // MV3: open default_popup if present, else fire chrome.action.onClicked.
        const popup = a?.default_popup;
        if (popup) window.__ewOpenPopup?.(e.id, popup);
        else window.__ewFireAction?.(e.id);
      };
      extsEl.appendChild(b);
    }
  }

  // keep the toolbar in sync as extensions come/go/change
  try {
    chrome.management.onInstalled?.addListener(refresh);
    chrome.management.onUninstalled?.addListener(refresh);
    chrome.management.onEnabled?.addListener(refresh);
  } catch {}
  window.__ewRefreshToolbar = refresh;

  loadState();
  refresh();
  // re-render shortly after in case the chrome.* shim wasn't ready on first pass
  setTimeout(refresh, 500);
  console.log('%c[ew-toolbar] rendered', 'color:#6ad;font-weight:bold', 'host=#ew-toolbar-host bar=', !!root.querySelector('#bar'));
  window.__ewToolbarDebug = () => ({
    pin, minimized, popOpen: pinPop.classList.contains('open'),
    barRect: bar.getBoundingClientRect(),
    barStyle: { left: bar.style.left, right: bar.style.right, top: bar.style.top, bottom: bar.style.bottom, transform: bar.style.transform, display: getComputedStyle(bar).display, width: getComputedStyle(bar).width },
    popRect: pinPop.getBoundingClientRect(),
    popDisplay: getComputedStyle(pinPop).display,
    popPos: { top: pinPop.style.top, bottom: pinPop.style.bottom },
    pinBtnRect: pinBtn.getBoundingClientRect(),
  });
  window.__ewToolbarTest = () => { pinBtn.click(); return window.__ewToolbarDebug(); };
})();

