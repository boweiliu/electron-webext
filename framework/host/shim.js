// shim.js — injected into each target's main world BEFORE content scripts.
// Defines window.chrome / window.browser backed by the electron-webext host over
// the Runtime.addBinding bridge. The host calls window.__ewResolve(callId, json, isError)
// to return results, and window.__ewEmit(name, payload) to fire events.
(() => {
  if (window.__ewShim__) return;
  window.__ewShim__ = true;
  console.log('%c[ew] shim init build=' + (window.__ewBuild || 'unknown'), 'color:#6ad;font-weight:bold');

  const pending = new Map();
  let callId = 0;
  window.__ewResolve = (id, result, isError) => {
    const e = pending.get(id);
    if (!e) { console.warn('[ew] resolve no pending', id); return; }
    pending.delete(id);
    if (isError) e.reject(new Error(typeof result === 'string' ? result : JSON.stringify(result)));
    else e.resolve(result);
  };

  function call(api, method, args) {
    return new Promise((resolve, reject) => {
      const id = ++callId;
      pending.set(id, { resolve, reject });
      try {
        window.__ewSend(JSON.stringify({ callId: id, extId: window.__ewSelfId || '_management', api, method, args: args || [] }));
      } catch (e) {
        pending.delete(id);
        reject(new Error('bridge unavailable: ' + e.message));
      }
    });
  }

  // ---- events ----
  const listeners = {};
  window.__ewEmit = (name, payload) => {
    const set = listeners[name];
    if (!set) return;
    for (const f of [...set]) { try { f(payload); } catch (e) { console.error('[ew event]', name, e); } }
  };
  function makeEvent(name) {
    const set = (listeners[name] = listeners[name] || new Set());
    return {
      addListener: (f) => { set.add(f); console.log('[ew] listen', name); },
      removeListener: (f) => set.delete(f),
      hasListener: (f) => set.has(f),
    };
  }
  function ns(api, methods) {
    const o = {};
    for (const m of methods) o[m] = (...args) => call(api, m, args);
    return o;
  }

  window.chrome = window.chrome || {};
  const c = window.chrome;

  c.management = Object.assign(
    ns('management', ['getAll', 'get', 'getSelf', 'setEnabled', 'setEnabledAll', 'uninstall', 'loadUnpacked', 'reload', 'getPermissionWarnings']),
    {
      onInstalled: makeEvent('management.onInstalled'),
      onUninstalled: makeEvent('management.onUninstalled'),
      onEnabled: makeEvent('management.onEnabled'),
      onDisabled: makeEvent('management.onDisabled'),
      onErrors: makeEvent('management.onErrors'),
    }
  );
  c.runtime = Object.assign(
    ns('runtime', ['sendMessage', 'connect', 'reload', 'getInfo', 'getSelf']),
    {
      // synchronous in real Chrome — backed by injected __ewSelfInfo, not the bridge
      getId: () => window.__ewSelfInfo?.id,
      getManifest: () => window.__ewSelfInfo?.manifest,
      getURL: (p) => 'chrome-extension://' + (window.__ewSelfInfo?.id) + '/' + String(p || '').replace(/^\/+/, ''),
      onMessage: makeEvent('runtime.onMessage'),
      onConnect: makeEvent('runtime.onConnect'),
      onInstalled: makeEvent('runtime.onInstalled'),
    }
  );
  c.storage = {
    local: ns('storage.local', ['get', 'set', 'remove', 'clear', 'getBytes']),
    session: ns('storage.session', ['get', 'set', 'remove', 'clear']),
    sync: ns('storage.sync', ['get', 'set', 'remove', 'clear']),
    onChanged: makeEvent('storage.onChanged'),
  };
  c.action = {
    onClicked: makeEvent('action.onClicked'),
    setTitle: (...a) => call('action', 'setTitle', a),
    getTitle: (...a) => call('action', 'getTitle', a),
    setIcon: (...a) => call('action', 'setIcon', a),
    setPopup: (...a) => call('action', 'setPopup', a),
    getPopup: (...a) => call('action', 'getPopup', a),
    openPopup: (...a) => call('action', 'openPopup', a),
  };
  c.tabs = ns('tabs', ['query', 'get', 'getCurrent', 'sendMessage', 'executeScript', 'insertCSS', 'reload', 'create', 'update', 'remove']);
  c.commands = { onCommand: makeEvent('commands.onCommand'), getAll: (...a) => call('commands', 'getAll', a) };
  c.i18n = { getMessage: (n) => n }; // synchronous
  c.windows = ns('windows', ['getCurrent', 'getAll', 'create', 'update', 'remove']);

  // host hooks used by toolbar/panel
  window.__ewHost = {
    getPopupURL: (extId, p) => call('runtime', 'getURL', [extId, p]),
    fireAction: (extId) => call('action', 'onClicked', [extId]),
  };

  if (!window.browser) window.browser = c;
  console.log('[ew] shim ready: chrome.* =', Object.keys(c).join(', '));
})();
