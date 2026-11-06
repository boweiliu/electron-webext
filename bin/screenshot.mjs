// Capture a screenshot of the first page target on localhost:9222.
// Usage: node bin/screenshot.mjs [out.png]
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const out = process.argv[2] || "screenshot.png";
const list = await CDP.List({ port: 9222 });
const target = list.find((t) => t.type === "page");
if (!target) { console.error("no page target"); process.exit(1); }
const client = await CDP({ target });
const { Page } = client;
await Page.enable();
const { data } = await Page.captureScreenshot({ format: "png" });
fs.writeFileSync(out, Buffer.from(data, "base64"));
console.log("wrote", out, (Buffer.from(data, "base64").length / 1024).toFixed(1) + "KB");
await client.close();
