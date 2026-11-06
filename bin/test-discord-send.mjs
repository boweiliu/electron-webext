#!/usr/bin/env node
// test-discord-send.mjs — exercise the discord bridge's SEND path end-to-end
// (host-side via `latchkey curl`), against a DM channel with a bot so we never
// message a real person. Default target: Carl-bot.
//
// Usage:
//   node bin/test-discord-send.mjs                       # send to Carl-bot, read back
//   node bin/test-discord-send.mjs <channelId> "hello"   # custom channel + message
//
// Credentials come from latchkey's stored `discord` service (user-session or
// bot token) — see docs/SPIKE-SLACK-INBOX.md.

import { execFile } from 'child_process';
import { promisify } from 'util';

const LATCHKEY_BIN = process.env.LATCHKEY_BIN || 'latchkey';
const DISCORD_API = process.env.DISCORD_API || 'https://discord.com/api/v10';
const run = promisify(execFile);

async function latchkeyCurl(args, { method, body } = {}) {
  const full = ['curl', ...(method ? ['-X', method] : []), ...args];
  if (body !== undefined) full.push('-H', 'Content-Type: application/json', '-d', typeof body === 'string' ? body : JSON.stringify(body));
  const { stdout } = await run(LATCHKEY_BIN, full, { maxBuffer: 1 << 24 });
  return stdout;
}
function parse(raw, p) {
  const s = raw.toString();
  let d; try { d = JSON.parse(s); } catch { throw new Error('non-JSON for ' + p + ': ' + s.slice(0, 200)); }
  if (d && typeof d === 'object' && !Array.isArray(d) && d.code != null && d.message) throw new Error('discord error (' + d.code + '): ' + d.message);
  return d;
}
const get = async (p) => parse(await latchkeyCurl([DISCORD_API + p]), p);
const post = async (p, body) => parse(await latchkeyCurl([DISCORD_API + p], { method: 'POST', body }), p);

function fmt(m) { return `  ${m.author?.username || '?'}${m.author?.bot ? ' (bot)' : ''}: ${m.content}`; }

async function main() {
  const channelId = process.argv[2] || '594347900801253378'; // Carl-bot DM
  const message = process.argv[3] || 'ping from slack-inbox spike (electron-webext) — please ignore';

  console.log('# channel', channelId);
  console.log('\n## before (last 5)');
  let before = await get(`/channels/${channelId}/messages?limit=5`);
  for (const m of [...before].reverse()) console.log(fmt(m));

  console.log('\n## sending…');
  const sent = await post(`/channels/${channelId}/messages`, { content: message });
  console.log('  sent id:', sent.id, '→', JSON.stringify(sent.content));

  // poll for a reply (bots often echo/ack within a second or two)
  let got = null;
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 1200));
    const after = await get(`/channels/${channelId}/messages?limit=6`);
    // a reply = a message newer than ours, not authored by us
    const reply = after.find(m => m.id !== sent.id && BigInt(m.id) > BigInt(sent.id));
    if (reply) { got = reply; break; }
  }

  console.log('\n## after (last 5)');
  let after = await get(`/channels/${channelId}/messages?limit=5`);
  for (const m of [...after].reverse()) console.log(fmt(m));
  console.log('\n# reply received:', got ? `${got.author.username}${got.author.bot ? ' (bot)' : ''}: ${got.content}` : '(none within 7s)');
}
main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
