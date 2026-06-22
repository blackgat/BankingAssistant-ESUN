// Tiny dependency-free static server for the demo harness. ES modules need to be
// served over http (file:// blocks module imports), so: `npm run demo` then open
// http://localhost:8123/demo/harness.html
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const port = Number(process.env.PORT) || 8123;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    // Redirect root to the harness so the browser's base URL is /demo/, which
    // makes the harness's relative module imports and fetches resolve correctly.
    if (urlPath === "/" || urlPath === "/demo" || urlPath === "/demo/") {
      res.writeHead(302, { location: "/demo/harness.html" });
      res.end();
      return;
    }
    const filePath = normalize(join(root, urlPath));
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, () => {
  console.log(`Demo server running:  http://localhost:${port}/demo/harness.html`);
  console.log("Press Ctrl+C to stop.");
});
