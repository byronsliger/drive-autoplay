// Home server for Drive Autoplay: serves the app and proxies audio/video from Google Drive.
//
// Why a proxy: browsers always send `Sec-Fetch-Site: cross-site` on requests from another site, and
// Drive's public download endpoint answers those with 403. The Drive API endpoint used as fallback is
// throttled per network ("automated queries"). Requests made from this server carry no browser fetch
// metadata, and the browser sees the media as same-origin, so pausing, seeking and resuming just work.
//
// Usage: DRIVE_API_KEY=... node server.js   (PORT=8080, HOST=0.0.0.0 by default; no dependencies)
// The key is handed to the page at runtime through /config.js, so it never lives in the repo or image.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const UPSTREAM_TIMEOUT_MS = 20000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};
// Files that must be revalidated on every load so installed apps pick up updates.
const NO_CACHE = new Set(["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/config.js"]);
const API_KEY = process.env.DRIVE_API_KEY || "";

function serveStatic(req, res, pathname) {
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(ROOT, path.normalize(pathname));
  const type = TYPES[path.extname(file)];
  // Only known asset types directly inside the app folder; nothing outside ROOT.
  if (!type || path.dirname(file) !== ROOT || file === __filename || !fs.existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": NO_CACHE.has(pathname) ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff"
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

function proxyMedia(req, res, id) {
  const url = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  const headers = { "User-Agent": "DriveAutoplay/1.0" };
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = https.get(url, { headers, timeout: UPSTREAM_TIMEOUT_MS }, up => {
    const type = up.headers["content-type"] || "";
    // Drive answers errors (missing, private, quota, virus-scan page) with HTML instead of media.
    if (up.statusCode >= 400 || type.startsWith("text/html")) {
      up.resume();
      const status = up.statusCode >= 400 ? up.statusCode : 502;
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(`Drive responded ${up.statusCode}`);
    }
    const out = {
      "Content-Type": type || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600"
    };
    for (const h of ["content-length", "content-range"]) if (up.headers[h]) out[h] = up.headers[h];
    res.writeHead(up.statusCode, out);
    up.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) { res.writeHead(504, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Drive did not respond"); }
    else res.destroy();
  });
  // Stop downloading from Drive when the player drops the connection (pause, seek, next file).
  res.on("close", () => upstream.destroy());
}

http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400); return res.end(); }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }

  // Runtime config from the environment; without DRIVE_API_KEY a local config.js file is served instead.
  if (pathname === "/config.js" && API_KEY) {
    res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-cache" });
    return res.end(`window.DRIVE_API_KEY = ${JSON.stringify(API_KEY)};
`);
  }
  if (pathname === "/media/health") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
  const m = pathname.match(/^\/media\/([\w-]{10,})$/);
  if (m) return proxyMedia(req, res, m[1]);
  serveStatic(req, res, pathname);
}).listen(PORT, HOST, () => console.log(`Drive Autoplay on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`));
