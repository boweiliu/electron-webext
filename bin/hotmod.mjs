#!/usr/bin/env node
// hotmod.mjs — web-ext-style hot reload, but for an installed Electron desktop app.
//
// Usage:
//   1. Launch the app with a debug port, e.g.:
//        open -a Slack --args --remote-debugging-port=9222
//   2. node bin/hotmod.mjs --port 9222 --src ext-src --match slack.com
//
// What it does:
//   - Connects to the CDP endpoint at localhost:PORT.
//   - Finds renderer targets whose URL/title matches --match.
//   - Injects every *.js in --src as a "content script":
//       * Page.addScriptToEvaluateOnNewDocument  (persists across reloads)
//       * Runtime.evaluate                        (immediate, for already-loaded page)
//   - Watches --src; on any change it re-injects into all matched targets and
//     optionally reloads (--reload). This is the hot-reload loop.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import CDP from 'chrome-remote-interface';

const args = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = a[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else { args[key] = true; }
    }
  }
}

const PORT = Number(args.port || 9222);
const SRC = args.src || 'ext-src';
const MATCH = args.match || '';
const RELOAD = !!args.reload;
const VERBOSE = !!args.verbose;

function log(...m){ console.log('[hotmod]', ...m); }

function loadSources() {
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.js')).sort();
  return files.map(f => {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    return { name: f, code: `// >>> hotmod: ${f}\n${code}\n// <<< hotmod: ${f}\n` };
  });
}

function combinedCode() {
  return loadSources().map(s => s.code).join('\n');
}

async function listTargets() {
  const res = await fetch(`http://localhost:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list -> ${res.status}`);
  return res.json();
}

async function attachAndInject(target, code) {
  const client = await CDP({ target: target.webSocketDebuggerUrl });
  const { Page, Runtime } = client;
  await Page.enable();
  await Runtime.enable();
  // Persist across navigations/reloads — the content-script analog.
  await Page.addScriptToEvaluateOnNewDocument({ source: code });
  // Also fire immediately on the already-loaded document.
  const { exceptionDetails } = await Runtime.evaluate({
    expression: code,
    allowUnsafeEvalBlock: true,
    awaitPromise: false,
  });
  if (exceptionDetails) log('inject error in', target.url, exceptionDetails);
  return client;
}

async function main() {
  log(`CDP port ${PORT}, src=${SRC}, match="${MATCH}", reload=${RELOAD}`);
  const code = combinedCode();
  if (!code.trim()) { log('no .js files in', SRC); process.exit(1); }
  log(`loaded ${loadSources().length} script(s), ${code.length} bytes`);

  const targets = await listTargets();
  const matched = MATCH
    ? targets.filter(t => (t.url || '').includes(MATCH) || (t.title || '').includes(MATCH))
    : targets;
  log(`targets: ${targets.length} total, ${matched.length} matched`);
  for (const t of matched) log('  -', t.type, t.title, t.url);

  const clients = [];
  for (const t of matched) {
    if (t.type !== 'page') continue;
    try {
      const c = await attachAndInject(t, code);
      clients.push({ target: t, client: c });
      log('injected ->', t.url);
      if (RELOAD) {
        const { Page } = c;
        await Page.reload();
        log('reloaded ->', t.url);
      }
    } catch (e) { log('attach failed', t.url, e.message); }
  }

  // Hot reload: watch src, re-inject on change.
  let timer = null;
  fs.watch(SRC, { recursive: true }, (_evt, file) => {
    if (!file || !file.endsWith('.js')) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const newCode = combinedCode();
      log(`change detected (${file}) — re-injecting ${newCode.length} bytes`);
      for (const { target, client } of clients) {
        try {
          const { Page, Runtime } = client;
          await Page.addScriptToEvaluateOnNewDocument({ source: newCode });
          await Runtime.evaluate({ expression: newCode, allowUnsafeEvalBlock: true });
          log('  re-injected ->', target.url);
          if (RELOAD) { await Page.reload(); log('  reloaded ->', target.url); }
        } catch (e) { log('  re-inject failed', target.url, e.message); }
      }
    }, 150);
  });

  log('watching for changes… Ctrl-C to exit.');
  process.on('SIGINT', async () => {
    log('detaching…');
    for (const { client } of clients) { try { await client.close(); } catch {} }
    process.exit(0);
  });
}

main().catch(e => { console.error('fatal', e); process.exit(1); });
