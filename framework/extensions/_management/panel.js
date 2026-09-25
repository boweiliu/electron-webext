// panel.js — injected (main world) by the electron-webext host.
// Renders a closed shadow-DOM overlay listing all loaded extensions and lets the
// user enable/disable/reload/uninstall/load-unpacked. All actions go through the
// standard chrome.management API (provided by the host's chrome.* shim).

(() => {
  if (window.__ewManagePanel__) return; // idempotent
  if (self !== top) return; // only render the panel in the top frame
  window.__ewManagePanel__ = true;

  const host = document.createElement("div");
  host.id = "ew-management-host";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host, #ew-panel { all: initial; }
      #ew-panel { position: fixed; top: 60px; right: 16px; width: 380px; max-height: 70vh;
        overflow: auto; z-index: 2147483647; background: #1f2228; color: #e6e6e6;
        font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; border-radius: 10px;
        box-shadow: 0 10px 40px rgba(0,0,0,.45); border: 1px solid #333;
        padding: 12px; display: none; }
      #ew-panel.open { display: block; }
      h2 { font-size: 14px; margin: 0 0 8px; display: flex; justify-content: space-between; }
      .ext { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 1px solid #2c2f36; }
      .ext .name { flex: 1; }
      .ext .ver { color: #888; font-size: 11px; }
      button { background: #2a2f38; color: #e6e6e6; border: 1px solid #444; border-radius: 6px;
        padding: 3px 7px; font-size: 11px; cursor: pointer; }
      button:hover { background: #353b46; }
      button.danger { color: #ff8b8b; border-color: #5a2a2a; }
      .err { color: #ff8b8b; font-size: 11px; white-space: pre-wrap; }
      .toolbar { display: flex; gap: 6px; margin: 8px 0; }
    </style>
    <div id="ew-panel">
      <h2>electron-webext <span style="font-size:11px;color:#888" id="ew-count"></span></h2>
      <div class="toolbar">
        <button id="ew-load">Load unpacked…</button>
        <button id="ew-reload-all">Reload all</button>
        <button id="ew-open-page">Open full page</button>
      </div>
      <div id="ew-list"></div>
      <div id="ew-errors"></div>
    </div>
  `;
  document.documentElement.appendChild(host);

  const panel = root.querySelector("#ew-panel");
  const list = root.querySelector("#ew-list");
  const count = root.querySelector("#ew-count");
  const errs = root.querySelector("#ew-errors");

  function toggle(open) {
    panel.classList.toggle("open", open ?? !panel.classList.contains("open"));
    if (panel.classList.contains("open")) refresh();
  }
  // The host routes the `_toggle_panel` command to a global we expose.
  window.__ewToggleManagementPanel = () => toggle();

  async function refresh() {
    const exts = await chrome.management.getAll();
    count.textContent = `(${exts.length})`;
    list.innerHTML = "";
    for (const e of exts) {
      const row = document.createElement("div");
      row.className = "ext";
      row.innerHTML = `<span class="name">${e.name}</span><span class="ver">${e.version}</span>`;
      const t = document.createElement("button");
      t.textContent = e.enabled ? "on" : "off";
      t.onclick = async () => { await chrome.management.setEnabled(e.id, !e.enabled); refresh(); };
      const r = document.createElement("button");
      r.textContent = "reload";
      r.onclick = async () => { await chrome.management.reload(e.id); refresh(); };
      const u = document.createElement("button");
      u.className = "danger";
      u.textContent = "uninstall";
      u.onclick = async () => { await chrome.management.uninstall(e.id); refresh(); };
      row.append(t, r, u);
      list.appendChild(row);
    }
  }

  root.querySelector("#ew-load").onclick = async () => {
    // Host intercepts the file chooser (Page.setInterceptFileChooserDialog) and
    // resolves a folder path; management.install(path) loads it.
    const path = await chrome.management.loadUnpacked();
    if (path) refresh();
  };
  root.querySelector("#ew-reload-all").onclick = async () => {
    const exts = await chrome.management.getAll();
    await Promise.all(exts.map(e => e.id !== "_management" && chrome.management.reload(e.id)));
    refresh();
  };
  root.querySelector("#ew-open-page").onclick = () =>
    chrome.runtime.getURL("management.html").then(u => window.open(u, "_blank"));

  // Live error stream from the host (Runtime.exceptionThrown per target).
  chrome.management.onErrors?.addListener((id, messages) => {
    errs.textContent += `[${id}] ${messages.join("\n")}\n`;
  });

  // tiny floating gear to open the panel if the hotkey isn't bound
  const gear = document.createElement("div");
  const gsr = gear.attachShadow({ mode: "closed" });
  gsr.innerHTML = `<style>
    :host{all:initial} #g{position:fixed;right:10px;bottom:10px;z-index:2147483647;
      width:26px;height:26px;border-radius:50%;background:#e01e5a;color:#fff;
      display:flex;align-items:center;justify-content:center;cursor:pointer;
      font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.4)}</style>
    <div id="g">⚙</div>`;
  gsr.querySelector("#g").onclick = () => toggle(true);
  // (Only appended if there's no toolbar to host the ⚙ button — the toolbar
  // calls window.__ewToggleManagementPanel() directly.)
  if (!window.__ewToolbar__) document.documentElement.appendChild(gear);

  // Hooks called by the toolbar when an extension action is clicked.
  window.__ewFireAction = (extId) => {
    // host routes to the extension's background chrome.action.onClicked
    chrome.runtime.sendMessage("_management", { __ew: true, type: "actionClicked", extId });
  };
  window.__ewOpenPopup = (extId, popupPath) => {
    // Open the extension's default_popup in a small shadow-DOM popover iframe.
    // chrome.runtime.getURL is self-only in the standard API, so the host exposes
    // a helper that returns the full chrome-extension://<extId>/<path> URL.
    const getURL = window.__ewHost?.getPopupURL
      ? window.__ewHost.getPopupURL(extId, popupPath)
      : Promise.resolve(`chrome-extension://${extId}/${popupPath}`);
    Promise.resolve(getURL).then((url) => {
      const pop = document.createElement("div");
      pop.attachShadow({ mode: "closed" }).innerHTML = `<style>
        :host{all:initial}#f{position:fixed;top:34px;width:360px;height:480px;
          z-index:2147483647;border-radius:10px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.5);
          border:1px solid #333;background:#fff}</style>
        <iframe id="f" src="${url}"></iframe>`;
      const f = pop.shadowRoot.querySelector("#f");
      f.style.left = "50%"; f.style.transform = "translateX(-50%)";
      document.documentElement.appendChild(pop);
      const close = (ev) => { if (!pop.shadowRoot.contains(ev.target)) { document.removeEventListener("mousedown", close); pop.remove(); } };
      setTimeout(() => document.addEventListener("mousedown", close), 0);
    });
  };
  console.log('%c[ew-panel] rendered', 'color:#e01e5a;font-weight:bold', 'host=#ew-management-host panel=', !!root.querySelector('#ew-panel'));
})();
