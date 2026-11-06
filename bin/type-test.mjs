#!/usr/bin/env node
// type-test.mjs — verify real keyboard typing into the slack-inbox composer
// actually sends to Discord. Uses CDP Input.dispatchKeyEvent (real input path),
// NOT synthetic DOM events, so it exercises the same code path as a human typing.
//
// Usage: node bin/type-test.mjs [message]
// Assumes the slack-inbox overlay is already open on a channel (run open first).

import CDP from 'chrome-remote-interface';

const PORT = 9222;
const WORLD = process.env.WORLD || 'ew:ew1n9skyv';
const MSG = process.argv[2] || 'typed for real from the slack composer (cdp input test)';

const list = await CDP.List({ port: PORT });
const target = list.find((t) => t.type === 'page');
const client = await CDP({ target });
const { Runtime, Input } = client;
const all = [];
Runtime.executionContextCreated((c) => all.push(c));
await Runtime.enable();
await new Promise((r) => setTimeout(r, 250));
const ctx = all.find((c) => (c.context.name || '') === WORLD);
if (!ctx) { console.error('no world', WORLD, 'have:', all.map(c => c.context.name)); process.exit(1); }
const ev = (expr) => Runtime.evaluate({ expression: `(${expr})()`, returnByValue: true, awaitPromise: true, contextId: ctx.context.id });

async function inBox() { const r = await ev('() => window.__ewInbox && window.__ewInbox.boxText ? window.__ewInbox.boxText() : null'); return r.result.value; }

// focus the composer through the extension (it's in a closed shadow)
const fr = await ev('() => !!(window.__ewInbox && window.__ewInbox.focusComposer && window.__ewInbox.focusComposer())');
console.log('composer focused:', fr.result.value);

await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 }); // prime focus

let inserted = '';
for (const ch of MSG) {
  if (ch === ' ') {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await Input.dispatchKeyEvent({ type: 'char', text: ' ', unmodifiedText: ' ' });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  } else {
    const code = ch.toUpperCase() >= 'A' && ch.toUpperCase() <= 'Z' ? 'Key' + ch.toUpperCase() : 'Digit' + ch;
    const kc = ch.toUpperCase().charCodeAt(0);
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: ch, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, text: ch, unmodifiedText: ch });
    await Input.dispatchKeyEvent({ type: 'char', text: ch, unmodifiedText: ch });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: ch, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  }
  inserted += ch;
  await new Promise((r) => setTimeout(r, 15));
}
await new Promise((r) => setTimeout(r, 200));
const boxNow = await inBox();
console.log('box contains:', JSON.stringify(boxNow));
console.log('expected     :', JSON.stringify(inserted));

// hit Enter to send
await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await new Promise((r) => setTimeout(r, 400));
const after = await inBox();
console.log('box after Enter (should be empty):', JSON.stringify(after));
await client.close();
