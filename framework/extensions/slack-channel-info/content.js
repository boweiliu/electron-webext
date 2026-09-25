// POC #1 — slack-channel-info
// Runs in an ISOLATED world (the default for content scripts). Isolated worlds
// share the page DOM but NOT its JS globals — so we can read document.title but
// can't see Slack's internal JS. This is exactly how real Chrome content scripts work.
(() => {
  const tag = (...m) => console.log('%c[channel-info]', 'color:#6ad;font-weight:bold', ...m);
  const id = chrome.runtime.getId();
  const mf = chrome.runtime.getManifest();
  tag('loaded ext', id, 'v' + mf.version, '| isolated world');

  async function tick() {
    // DOM access from the isolated world (shared DOM):
    const title = document.title || '';
    // Slack titles look like: "channel-name (Channel) - workspace - ... - Slack"
    const channel = title.split(' - ')[0] || title;
    // chrome.storage.local (page -> host -> in-memory store)
    await chrome.storage.local.set({ channel, fullTitle: title, ts: Date.now() });
    // chrome.tabs.query (page -> host -> target registry)
    const tabs = await chrome.tabs.query({});
    // chrome.runtime.sendMessage (page -> host -> broadcast onMessage to all worlds)
    chrome.runtime.sendMessage('_management', { from: id, kind: 'channel', channel, tabCount: tabs.length });
    tag('channel =', JSON.stringify(channel), '| tabs =', tabs.length, '| stored + sent');
  }
  tick();
  setInterval(tick, 5000);
})();
