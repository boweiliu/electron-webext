// POC #2 — action-logger
// Runs in an ISOLATED world. Demonstrates RECEIVING host->page events:
// chrome.action.onClicked, chrome.runtime.onMessage, chrome.storage.onChanged.
// (In real Chrome, action.onClicked fires in the background, not the content
// script; electron-webext has no background yet, so we deliver it to the
// extension's own world — noted as a known deviation in the README roadmap.)
(() => {
  const tag = (...m) => console.log('%c[action-logger]', 'color:#e01e5a;font-weight:bold', ...m);
  const id = chrome.runtime.getId();
  tag('loaded ext', id, 'v' + chrome.runtime.getManifest().version, '| isolated world');

  // receive a message broadcast by another extension (e.g. slack-channel-info)
  chrome.runtime.onMessage.addListener((msg) => {
    tag('onMessage:', JSON.stringify(msg));
  });

  // receive storage change notifications (fired by the host when any set() runs)
  chrome.storage.onChanged.addListener((changes) => {
    tag('storage.onChanged:', JSON.stringify(changes));
  });

  // our toolbar action was clicked -> exercise the management/tabs/storage APIs
  chrome.action.onClicked.addListener(async (ev) => {
    if (ev && ev.id && ev.id !== id) return; // only respond to our own action
    tag('action.onClicked — exercising API surface');
    const all = await chrome.management.getAll();
    const tabs = await chrome.tabs.query({});
    await chrome.storage.local.set({
      lastAction: { at: Date.now(), extCount: all.length, tabCount: tabs.length, exts: all.map(e => e.id) },
    });
    tag('management.getAll ->', all.length, 'exts:', all.map(e => e.id).join(', '));
    tag('tabs.query ->', tabs.length, 'tabs:', tabs.map(t => t.id).join(', '));
  });

  tag('listeners registered: onMessage, storage.onChanged, action.onClicked');
})();
