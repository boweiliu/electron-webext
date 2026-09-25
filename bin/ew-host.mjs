#!/usr/bin/env node
// ew-host.mjs — electron-webext host runtime.
// Connects to an Electron app's CDP port, injects the chrome.* shim + each loaded
// extension's content scripts into matching renderer targets, and bridges
// chrome.* calls (via Runtime.addBinding) to in-process backends.
//
// Usage:
//   open -a Slack --args --remote-debugging-port=9222
//   node bin/ew-host.mjs --port 9222 --match slack.com

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import CDP from 'chrome-remote-interface';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = {};
{ const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); const n = a[i + 1];
      if (n && !n.startsWith('--')) { args[k] = n; i++; } else args[k] = true; } } }
const PORT = Number(args.port || 9222);
const MATCH = args.match || '';
const AUTORELOAD = args.autoreload !== false && args['no-autoreload'] !== true; // default ON (web-ext-style)
const EXT_DIR = path.join(ROOT, 'framework', 'extensions');
const SHIM = fs.readFileSync(path.join(ROOT, 'framework', 'host', 'shim.js'), 'utf8');
const VERBOSE = args.verbose !== false; // on by default

function dbg(...m) { if (VERBOSE) console.log('[ew-host]', ...m); }
function err(...m) { console.error('[ew-host ERROR]', ...m); }

// write generated source to disk and node --check it, so we never ship a broken script
let lastCheckedHash = null;
function checkSource(source, hash) {
  try {
    const file = path.join(ROOT, 'debug-build.js');
    fs.writeFileSync(file, source);
    execFileSync('node', ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (lastCheckedHash !== hash) { dbg('node --check OK for build=' + hash, '(' + source.length + 'B) ->', file); lastCheckedHash = hash; }
    return true;
  } catch (e) {
    err('node --check FAILED for build=' + hash + ':', (e.stderr ? e.stderr.toString().trim() : e.message));
    return false;
  }
}

// ---------- Extension registry ----------
const registry = new Map(); // id -> ext
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return 'ew' + (h >>> 0).toString(36); }
function shortHash(s) { let h = 0x811c9dc5; for (let i=0;i<s.length;i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8,'0'); }
function loadExtension(dir, builtin = false) {
  const mpath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mpath)) { err('no manifest in', dir); return null; }
  const manifest = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  const id = manifest.id || (builtin ? '_management' : hash(path.resolve(dir)));
  const ext = {
    id, name: manifest.name, version: manifest.version, description: manifest.description,
    manifest, path: dir, enabled: true, builtin,
    permissionWarnings: [],
  };
  registry.set(id, ext);
  dbg('loaded extension', id, '=', ext.name, 'v' + ext.version, builtin ? '(builtin)' : '');
  return ext;
}
function info(e) {
  if (!e) return undefined;
  return {
    id: e.id, name: e.name, version: e.version, description: e.description,
    enabled: e.enabled, installType: e.builtin ? 'admin' : 'development',
    type: 'extension', manifest: e.manifest,
    permissions: e.manifest.permissions || [],
    hostPermissions: e.manifest.host_permissions || [],
    icons: e.manifest.icons || {},
    mayDisable: !e.builtin,
    permissionWarnings: e.permissionWarnings || [],
  };
}

// ---------- storage (in-memory per extension) ----------
const storage = {}; // extId -> { local:{}, session:{}, sync:{} }
function store(extId, area) { return (storage[extId] = storage[extId] || {})[area] || ((storage[extId][area] = {})); }

// ---------- targets ----------
const attached = new Map(); // targetId -> { client, extIds:Set }
const targets = new Map(); // targetId -> { id, url, title } (for chrome.tabs)

function matchPattern(url, matches) {
  // minimal: support <all_urls> and glob like https://*/* and prefix
  for (const m of matches) {
    if (m === '<all_urls>') return true;
    if (m === '*') return true;
    const re = new RegExp('^' + m.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
    if (re.test(url)) return true;
  }
  return false;
}

function contentScriptsFor(ext) {
  return (ext.manifest.content_scripts || []).filter(cs => matchPattern('https://example.com/', cs.matches) || true);
  // we inject into all matched targets regardless of per-cs match for now; refine later
}

function buildSource(ext) {
  // content scripts only (shim + self-id are prepended per-world by buildAll)
  const parts = [];
  // css first
  for (const cs of (ext.manifest.content_scripts || [])) {
    for (const cssf of (cs.css || [])) {
      const css = fs.readFileSync(path.join(ext.path, cssf), 'utf8');
      parts.push(`(function(){var s=document.createElement('style');s.id='ew-css-${cssf.replace(/[^a-z0-9]/gi,'_')}';s.textContent=${JSON.stringify(css)};var root=document.head||document.documentElement;if(root)root.appendChild(s);else document.addEventListener('DOMContentLoaded',function(){(document.head||document.documentElement).appendChild(s);},{once:true});})();`);
    }
  }
  // js, respecting run_at
  for (const cs of (ext.manifest.content_scripts || [])) {
    const runAt = cs.run_at || 'document_idle';
    for (const jsf of (cs.js || [])) {
      const code = fs.readFileSync(path.join(ext.path, jsf), 'utf8');
      const wrapped = `// >>> ${ext.id}/${jsf} (run_at=${runAt})\n${code}\n// <<< ${ext.id}/${jsf}`;
      if (runAt === 'document_start') {
        parts.push(wrapped);
      } else {
        // document_idle / document_end: defer until DOMContentLoaded (or run now if already loaded)
        parts.push(`(function(){var __f=function(){\n${wrapped}\n};if(document.readyState==='complete'||document.readyState==='interactive'){__f();}else{document.addEventListener('DOMContentLoaded',__f,{once:true});}})();`);
      }
    }
  }
  return parts.join('\n');
}

// world for an extension: undefined = main world; otherwise an isolated world name
function extensionWorld(ext) {
  const css = ext.manifest.content_scripts || [];
  return css.some(cs => cs.world === 'main') ? undefined : `ew:${ext.id}`;
}

// build per-extension injection entries (self-id + shim + that extension's content scripts)
function buildAll() {
  const entries = [];
  for (const ext of registry.values()) {
    if (!ext.enabled) continue;
    const worldName = extensionWorld(ext);
    const body = `window.__ewSelfId=${JSON.stringify(ext.id)};window.__ewSelfInfo=${JSON.stringify({ id: ext.id, manifest: ext.manifest })};\n` + SHIM + '\n' + buildSource(ext);
    entries.push({ ext, worldName, body });
  }
  const hash = shortHash(entries.map(e => e.body).join('\n'));
  for (const e of entries) e.source = `window.__ewBuild=${JSON.stringify(hash)};\n` + e.body; // stamp build
  return { entries, hash };
}

async function attachTarget(t) {
  if (attached.has(t.id)) return;
  dbg('attach target', t.id, t.type, t.url);
  let client;
  try { client = await CDP({ target: t.webSocketDebuggerUrl }); }
  catch (e) { err('attach failed', t.id, e.message); return; }
  const { Page, Runtime, Network } = client;
  await Runtime.enable();
  await Page.enable();
  // track every execution context (main + isolated worlds) so emit() can reach all of them
  const contexts = new Map(); // ctxId -> {name}
  Runtime.executionContextCreated(({ context }) => { contexts.set(context.id, { name: context.name }); });
  Runtime.executionContextDestroyed(({ executionContextId }) => contexts.delete(executionContextId));
  Runtime.executionContextsCleared(() => contexts.clear());
  // bridge binding
  await Runtime.addBinding({ name: '__ewSend' });
  Runtime.bindingCalled(({ name, payload, executionContextId }) => {
    if (name !== '__ewSend') return;
    handleCall(payload, t.id, executionContextId).catch(e => err('call handler', e.message));
  });
  Runtime.exceptionThrown(({ exceptionDetails }) => {
    err('page exception:', exceptionDetails?.text, exceptionDetails?.exception?.description?.slice(0, 300));
  });
  // inject each enabled extension into its own world (main world if manifest says world:main)
  const { entries, hash } = buildAll();
  const scriptIds = new Set();
  for (const e of entries) {
    checkSource(e.source, hash + ':' + e.ext.id);
    const { identifier } = await Page.addScriptToEvaluateOnNewDocument({ source: e.source, worldName: e.worldName, runImmediately: true });
    scriptIds.add(identifier);
    dbg('inject build=' + hash, e.ext.id, '-> world', e.worldName || 'main', e.source.length + 'B', 'scriptId', identifier);
  }
  attached.set(t.id, { client, scriptIds, buildHash: hash, contexts });
  targets.set(t.id, { id: t.id, url: t.url, title: t.title });
}

async function handleCall(payload, targetId, executionContextId) {
  let req;
  try { req = JSON.parse(payload); } catch (e) { err('bad payload', payload); return; }
  const { callId, extId, api, method, args } = req;
  const ctx = { extId: extId || '_management', targetId, executionContextId };
  dbg('call', api + '.' + method, 'from', ctx.extId, '@target', targetId, 'ctx', executionContextId, 'callId', callId);
  let result, isError = false;
  try {
    const fn = backends[api] && backends[api][method];
    if (!fn) throw new Error('not implemented: ' + api + '.' + method);
    result = await fn(ctx, args || []);
  } catch (e) { result = e.message; isError = true; err('backend', api + '.' + method, e.message); }
  const client = attached.get(targetId)?.client;
  if (!client) return;
  const json = JSON.stringify(result);
  const expr = `window.__ewResolve && window.__ewResolve(${callId}, ${json || 'null'}, ${isError});`;
  try { await client.Runtime.evaluate({ expression: expr, contextId: executionContextId }); }
  catch (e) { err('resolve failed', e.message, '(retrying default context)'); try { await client.Runtime.evaluate({ expression: expr }); } catch {} }
}

// broadcast an event to every execution context of every attached target (main + all isolated worlds)
async function emit(name, payload) {
  const expr = `window.__ewEmit && window.__ewEmit(${JSON.stringify(name)}, ${JSON.stringify(payload)});`;
  for (const [tid, a] of attached) {
    for (const ctxId of [...(a.contexts?.keys() || [])]) {
      try { await a.client.Runtime.evaluate({ expression: expr, contextId: ctxId }); } catch {}
    }
  }
}

// ---------- backends ----------
const backends = {
  management: {
    getAll: () => [...registry.values()].map(info),
    get: (_ctx, [id]) => info(registry.get(id)),
    getSelf: (ctx) => info(registry.get(ctx.extId)),
    setEnabled: async (_ctx, [id, en]) => {
      const e = registry.get(id); if (!e) throw new Error('no such extension');
      if (e.builtin && !en) throw new Error('cannot disable built-in extension: ' + id);
      e.enabled = en;
      emit(en ? 'management.onEnabled' : 'management.onDisabled', { id, enabled: en });
      await reinjectAll();
    },
    // batch toggle: set every non-builtin extension, then a single reinject (one reload)
    setEnabledAll: async (_ctx, [en]) => {
      for (const e of registry.values()) if (!e.builtin) e.enabled = en;
      emit(en ? 'management.onEnabled' : 'management.onDisabled', { all: true, enabled: en });
      await reinjectAll();
      return [...registry.values()].map(x => ({ id: x.id, enabled: x.enabled }));
    },
    uninstall: async (_ctx, [id]) => {
      const e = registry.get(id);
      if (e?.builtin) throw new Error('cannot uninstall built-in extension: ' + id);
      registry.delete(id);
      emit('management.onUninstalled', { id });
      await reinjectAll();
    },
    loadUnpacked: async (_ctx, [p]) => {
      // folder picker not wired in this slice; require a path arg
      if (!p) throw new Error('loadUnpacked needs a path (folder picker not wired yet)');
      const e = loadExtension(p, false);
      if (!e) throw new Error('invalid extension');
      emit('management.onInstalled', { id: e.id });
      await reinjectAll();
      return e.id;
    },
    reload: async (_ctx, [id]) => { await reinjectAll(); },
    getPermissionWarnings: () => [],
  },
  runtime: {
    getURL: (_ctx, [id, p]) => `chrome-extension://${id}/${p}`,
    getManifest: (ctx) => registry.get(ctx.extId)?.manifest,
    getId: (ctx) => ctx.extId,
    getInfo: (ctx) => { const e = registry.get(ctx.extId); return e ? { id: e.id, name: e.name, version: e.version } : null; },
    getSelf: (ctx) => info(registry.get(ctx.extId)),
    sendMessage: async (ctx, [targetId, msg]) => { emit('runtime.onMessage', { from: ctx.extId, message: msg }); return true; },
    reload: async (ctx) => { await reinjectAll(); },
  },
  'storage.local': {
    get: (ctx, [keys]) => { const s = store(ctx.extId, 'local'); if (!keys) return { ...s }; if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, s[k]])); if (typeof keys === 'object') return Object.fromEntries(Object.keys(keys).map(k => [k, s[k] ?? keys[k]])); return { [keys]: s[keys] }; },
    set: (ctx, [obj]) => { Object.assign(store(ctx.extId, 'local'), obj); emit('storage.onChanged', { area: 'local', changes: obj }); return true; },
    remove: (ctx, [keys]) => { const s = store(ctx.extId, 'local'); (Array.isArray(keys) ? keys : [keys]).forEach(k => delete s[k]); return true; },
    clear: (ctx) => { storage[ctx.extId] && (storage[ctx.extId].local = {}); return true; },
    getBytes: (ctx) => JSON.stringify(store(ctx.extId, 'local')).length,
  },
  'storage.session': { get: (c,[k])=>({}), set: ()=>true, remove: ()=>true, clear: ()=>true },
  'storage.sync':   { get: (c,[k])=>({}), set: ()=>true, remove: ()=>true, clear: ()=>true },
  action: {
    onClicked: async (_ctx, [extId]) => { emit('action.onClicked', { id: extId }); return true; },
    setTitle: () => true, getTitle: async (ctx) => 'electron-webext', setIcon: () => true, setPopup: () => true, getPopup: async () => 'management.html', openPopup: () => true,
  },
  tabs: {
    query: async (_ctx, [q]) => [...targets.values()].filter(t => !q || !q.url || (t.url || '').includes(q.url)),
    get: async (_ctx, [id]) => targets.get(id),
    getCurrent: async (ctx) => targets.get(ctx.targetId),
    sendMessage: async (ctx, [id, msg]) => { emit('runtime.onMessage', { from: ctx.extId, message: msg, tabId: id }); return true; },
    reload: async (_ctx, [id]) => { const a = attached.get(id); if (a) await a.client.Page.reload(); return true; },
    executeScript: async (_ctx, [id, details]) => { const a = attached.get(id); if (!a) throw new Error('no tab'); const r = await a.client.Runtime.evaluate({ expression: details.code || (details.files||[])[0] || '' }); return [r.result?.value]; },
    insertCSS: () => true, create: () => null, update: () => true, remove: () => true,
  },
  commands: { getAll: async (ctx) => registry.get(ctx.extId)?.manifest?.commands ? Object.entries(registry.get(ctx.extId).manifest.commands).map(([k,v])=>({name:k,description:v.description,suggested_key:v.suggested_key})) : [] },
  i18n: { getMessage: (_ctx, [n]) => n },
  windows: { getCurrent: async (ctx) => ({ id: ctx.targetId }), getAll: async () => [], create: () => null, update: () => true, remove: () => true },
};

// ---------- reinject (hot reload / enable-disable) ----------
async function reinjectAll() {
  const { entries, hash } = buildAll();
  for (const [tid, a] of attached) {
    for (const id of a.scriptIds) {
      try { await a.client.Page.removeScriptToEvaluateOnNewDocument({ identifier: id }); } catch {}
    }
    a.scriptIds.clear();
    for (const e of entries) {
      checkSource(e.source, hash + ':' + e.ext.id);
      const { identifier } = await a.client.Page.addScriptToEvaluateOnNewDocument({ source: e.source, worldName: e.worldName, runImmediately: true });
      a.scriptIds.add(identifier);
      dbg('reinject build=' + hash, e.ext.id, '-> world', e.worldName || 'main', 'scriptId', identifier);
    }
    a.buildHash = hash;
    if (AUTORELOAD) { try { await a.client.Page.reload(); dbg('autoreload ->', tid); } catch (e) { err('autoreload failed', tid, e.message); } }
  }
}

// ---------- target discovery (poll /json/list) ----------
async function discover() {
  let list;
  try { list = await (await fetch(`http://localhost:${PORT}/json/list`)).json(); }
  catch { return; }
  for (const t of list) {
    if (t.type !== 'page') continue;
    if (MATCH && !(t.url || '').includes(MATCH) && !(t.title || '').includes(MATCH)) continue;
    targets.set(t.id, { id: t.id, url: t.url, title: t.title });
    if (!attached.has(t.id)) await attachTarget(t);
  }
  // prune detached
  for (const id of [...attached.keys()]) {
    if (!list.find(t => t.id === id)) { try { await attached.get(id).client.close(); } catch {} attached.delete(id); dbg('detached', id); targets.delete(id); }
  }
}

// ---------- hot reload ----------
function watch() {
  let t;
  const onChange = (_e, f) => { if (!f) return; clearTimeout(t); t = setTimeout(async () => { dbg('change:', f, '-> reinject'); await reinjectAll(); }, 200); };
  // watch every extension dir + the shim
  for (const ext of registry.values()) {
    fs.watch(ext.path, { recursive: true }, onChange);
  }
  fs.watch(path.join(ROOT, 'framework', 'host', 'shim.js'), onChange);
}

// ---------- main ----------
async function main() {
  // auto-load every extension under framework/extensions/ (builtin = _management)
  for (const name of fs.readdirSync(EXT_DIR).sort()) {
    const dir = path.join(EXT_DIR, name);
    if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'manifest.json'))) {
      loadExtension(dir, name === '_management');
    }
  }
  dbg('host starting; CDP port', PORT, 'match', MATCH || '(all)', 'autoreload', AUTORELOAD);
  // initial discover
  for (let i = 0; i < 30; i++) {
    try { await discover(); if (attached.size) break; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  dbg('initial attach:', attached.size, 'target(s)');
  setInterval(discover, 1000);
  watch();
  dbg('watching for changes… Ctrl-C to exit');
  process.on('SIGINT', async () => {
    for (const [, a] of attached) { try { await a.client.close(); } catch {} }
    process.exit(0);
  });
}

main().catch(e => { err('fatal', e); process.exit(1); });
