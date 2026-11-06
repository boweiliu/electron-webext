#!/usr/bin/env node
// test-discord.mjs — verify the latchkey→Discord data path the host backend uses.
// Runs the exact `latchkey curl` calls the discord backend would make, so you
// can confirm credentials + API + parsing work before (or without) the Slack UI.
//
// Usage:
//   node bin/test-discord.mjs            # status + list DMs + dump one thread
//   node bin/test-discord.mjs <channelId> [limit]
//
// Credentials are whatever latchkey has stored for `discord`:
//   latchkey auth browser discord            # user-session (reads your real DMs)
//   latchkey auth set discord -H "Authorization: Bot <token>"   # bot token

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
  let d; try { d = JSON.parse(raw.toString()); } catch { throw new Error('non-JSON for ' + p + ': ' + raw.toString().slice(0, 200)); }
  if (d && typeof d === 'object' && !Array.isArray(d) && d.code != null && d.message) throw new Error('discord error (' + d.code + '): ' + d.message);
  return d;
}
const get = async (p) => parse(await latchkeyCurl([DISCORD_API + p]), p);
const fmt = (o) => JSON.stringify(o, null, 2);

async function main() {
  console.log('# latchkey binary:', LATCHKEY_BIN);
  const ver = await run(LATCHKEY_BIN, ['--version']).then(r => r.stdout.trim()).catch(() => null);
  if (!ver) { console.error('latchkey not found on PATH (set LATCHKEY_BIN)'); process.exit(2); }
  console.log('# latchkey version:', ver);

  console.log('\n## GET /users/@me');
  let me;
  try { me = await get('/users/@me'); console.log(fmt(me)); }
  catch (e) { console.error('me failed:', e.message); console.error('→ set creds: `latchkey auth browser discord` or `latchkey auth set discord -H \"Authorization: Bot <token>\"`'); process.exit(1); }

  const channelId = process.argv[2];
  if (channelId) {
    const limit = process.argv[3] || 20;
    console.log(`\n## GET /channels/${channelId}/messages?limit=${limit}`);
    const msgs = await get(`/channels/${channelId}/messages?limit=${limit}`);
    // newest first → flip for reading
    for (const m of [...msgs].reverse()) console.log(`  ${m.author?.username || '?'}: ${m.content}`);
    return;
  }

  console.log('\n## GET /users/@me/channels  (DM list)');
  let chans;
  try { chans = await get('/users/@me/channels'); }
  catch (e) { console.error('listDMs failed:', e.message); return; }
  const rows = (chans || []).map(c => ({
    id: c.id,
    type: c.type,                         // 1 = DM, 3 = group DM
    name: c.name || (c.recipients || []).map(r => r.username).join(', '),
  }));
  console.log(fmt(rows));
  if (!rows.length) { console.log('no DM channels visible to this token'); return; }

  // dump the first DM thread
  const first = rows.find(r => r.type === 1) || rows[0];
  console.log(`\n## first thread: ${first.name} (${first.id})`);
  const msgs = await get(`/channels/${first.id}/messages?limit=15`);
  for (const m of [...msgs].reverse()) console.log(`  ${m.author?.username || '?'}: ${m.content}`);
}
main().catch(e => { console.error('fatal:', e); process.exit(1); });
