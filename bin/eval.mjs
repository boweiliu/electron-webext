// One-off CDP eval against the first page target on localhost:9222.
// Usage: node bin/eval.mjs '<js>' | <file.js>   [--world <name>]
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const args = process.argv.slice(2);
const worldIdx = args.indexOf("--world");
let worldName = null;
if (worldIdx !== -1) { worldName = args[worldIdx + 1]; args.splice(worldIdx, 2); }
const arg = args[0];
if (!arg) { console.error("usage: node bin/eval.mjs '<js>' | <file.js>   [--world <name>]"); process.exit(2); }
const expr = (fs.existsSync(arg) ? fs.readFileSync(arg, "utf8") : arg).replace(/[;\s]+$/, "");

const list = await CDP.List({ port: 9222 });
const target = list.find((t) => t.type === "page");
if (!target) { console.error("no page target"); process.exit(1); }
const client = await CDP({ target });
const { Runtime } = client;
// attach context listener BEFORE enable so existing contexts are reported
const all = [];
Runtime.executionContextCreated((c) => all.push(c));
await Runtime.enable();
await new Promise((r) => setTimeout(r, 250));

let contextId = undefined;
if (worldName) {
  const match = all.find((c) => (c.context.name || "") === worldName);
  if (!match) { console.error("no context matching world", JSON.stringify(worldName), "(have:", all.map((c) => c.context.name), ")"); process.exit(1); }
  contextId = match.context.id;
}

// Auto-invoke a top-level arrow expression: `() => x` -> `(() => x)()`.
// An arrow is treated as already-invoked only if it ends with a call `()` (e.g.
// `(() => ...)()` or `(() => ({...}))()`), so an arrow returning an object
// literal like `() => ({a:1})` (ends with `})`) still gets invoked.
const hasArrow = /=>/.test(expr);
const endsWithCall = /\)\s*\(\s*\)\s*$/.test(expr.trim());
const invoke = hasArrow && !endsWithCall;
const expression = invoke ? `(${expr})()` : `(${expr})`;
const { result, exceptionDetails } = await Runtime.evaluate({
  expression,
  returnByValue: true,
  awaitPromise: true,
  contextId,
});
if (exceptionDetails) {
  console.error("EXCEPTION:", JSON.stringify(exceptionDetails.exception?.description || exceptionDetails, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result.value, null, 2));
await client.close();
