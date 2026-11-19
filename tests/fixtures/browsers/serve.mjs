// Serves the browsers walk's fixture pages on 127.0.0.1, to prove the walk on pages that render
// the same everywhere (same.html) and on one that differs between engines on purpose
// (differs.html). /limited answers 429, as Shopify does when it limits a computer.
//   node tests/fixtures/browsers/serve.mjs        prints the address, then:
//   PREVIEW_URL=http://127.0.0.1:<port>/ BROWSERS_PAGES=/same.html,/differs.html,/limited npm run browsers
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../../../scripts/platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function serve(port = 0) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/limited") { res.writeHead(429, { "content-type": "text/plain" }); return res.end("Too many requests"); }
    const file = normalize(join(HERE, path === "/" ? "same.html" : path));
    if (!file.startsWith(HERE) || !file.endsWith(".html") || !existsSync(file)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (isMain(import.meta.url)) {
  const s = await serve(+(process.env.PORT || 0));
  console.log(`http://127.0.0.1:${s.address().port}/`);
}
