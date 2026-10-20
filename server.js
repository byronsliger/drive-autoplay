// Home server for Drive Autoplay: serves the app and proxies audio/video from Google Drive.
//
// Why a proxy: browsers always send `Sec-Fetch-Site: cross-site` on requests from another site, and
// Drive's public download endpoint answers those with 403. The Drive API endpoint used as fallback is
// throttled per network ("automated queries"). Requests made from this server carry no browser fetch
// metadata, and the browser sees the media as same-origin, so pausing, seeking and resuming just work.
//
// Usage: DRIVE_API_KEY=... node server.js   (PORT=8080, HOST=0.0.0.0 by default; no dependencies)
// The key is handed to the page at runtime through /config.js, so it never lives in the repo or image.
//
// Hardening: only private-network clients are served (ALLOW_PUBLIC=1 disables this), only an explicit
// list of files is public, every response carries security headers and media can never run as a page.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const API_KEY = process.env.DRIVE_API_KEY || "";
const ALLOW_PUBLIC = process.env.ALLOW_PUBLIC === "1";
const UPSTREAM_TIMEOUT_MS = 20000;
const MAX_UPSTREAM = 16; // concurrent media downloads; one player uses one or two

const PUBLIC_FILES = [
  "index.html", "app.js", "app.css", "theme.js", "fonts.css", "sw.js", "manifest.webmanifest",
  "favicon.svg", "apple-touch-icon.png", "icon-192.png", "icon-512.png",
  "icon-maskable-192.png", "icon-maskable-512.png", "screenshot-narrow.png", "screenshot-wide.png",
  "figtree-latin.woff2", "fraunces-latin.woff2"
];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2"
};
// Code and config are revalidated on every load so installed apps pick up updates; assets are cached.
const REVALIDATE = new Set([".html", ".js", ".css", ".webmanifest"]);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin", // the API key restriction checks the origin
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
};
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' https://www.googleapis.com",
  "connect-src 'self' https://www.googleapis.com",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join("; ");
// Media bytes come from arbitrary public Drive files: never let them render or run as a document.
const MEDIA_CSP = "default-src 'none'; sandbox";

function asset(name, body) {
  const ext = path.extname(name);
  return {
    body,
    etag: '"' + crypto.createHash("sha256").update(body).digest("base64url").slice(0, 27) + '"',
    headers: {
      "Content-Type": TYPES[ext],
      "Cache-Control": REVALIDATE.has(ext) ? "no-cache" : "public, max-age=86400",
      ...(ext === ".html" ? { "Content-Security-Policy": PAGE_CSP } : {})
    }
  };
}

// Loaded once at startup: request paths are only looked up in this map and never touch the filesystem.
const ASSETS = new Map(PUBLIC_FILES.map(f => ["/" + f, asset(f, fs.readFileSync(path.join(__dirname, f)))]));
ASSETS.set("/", ASSETS.get("/index.html"));
// Runtime config: the environment wins; otherwise a local, gitignored config.js if present.
const configFile = path.join(__dirname, "config.js");
if (API_KEY) ASSETS.set("/config.js", asset("config.js", Buffer.from(`window.DRIVE_API_KEY = ${JSON.stringify(API_KEY)};\n`)));
else if (fs.existsSync(configFile)) ASSETS.set("/config.js", asset("config.js", fs.readFileSync(configFile)));

function isPrivateAddress(addr = "") {
  addr = addr.replace(/^::ffff:/i, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const [a, b] = addr.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); // 100.64/10: CGNAT, Tailscale
  }
  const v6 = addr.toLowerCase();
  return v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6); // loopback, ULA, link-local
}

function send(res, status, text, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(text);
}

function serveAsset(req, res, file) {
  if (req.headers["if-none-match"] === file.etag) {
    res.writeHead(304, { ...SECURITY_HEADERS, ETag: file.etag, "Cache-Control": file.headers["Cache-Control"] });
    return res.end();
  }
  res.writeHead(200, { ...SECURITY_HEADERS, ...file.headers, ETag: file.etag, "Content-Length": file.body.length });
  res.end(req.method === "HEAD" ? undefined : file.body);
}

let activeUpstream = 0;

function proxyMedia(req, res, id) {
  if (activeUpstream >= MAX_UPSTREAM) return send(res, 503, "Too many downloads", { "Retry-After": "5" });
  const url = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  const headers = { "User-Agent": "DriveAutoplay/1.0" };
  const range = req.headers.range;
  if (range && /^bytes=(\d{1,15}-\d{0,15}|-\d{1,15})$/.test(range)) headers.Range = range;

  activeUpstream++;
  let released = false;
  const release = () => { if (!released) { released = true; activeUpstream--; } };

  const upstream = https.get(url, { headers, timeout: UPSTREAM_TIMEOUT_MS }, up => {
    const type = (up.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    // Drive answers errors (missing, private, quota, virus-scan page) with HTML instead of media.
    if (up.statusCode >= 400 || type === "text/html") {
      up.resume();
      return send(res, up.statusCode >= 400 ? up.statusCode : 502, `Drive responded ${up.statusCode}`);
    }
    const out = {
      ...SECURITY_HEADERS,
      // Only audio/video types pass through; anything else is opaque bytes that browsers will not render.
      "Content-Type": /^(audio|video)\/[\w.+-]+$/.test(type) ? type : "application/octet-stream",
      "Content-Security-Policy": MEDIA_CSP,
      "Content-Disposition": "attachment",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600"
    };
    for (const h of ["content-length", "content-range"]) if (up.headers[h]) out[h] = up.headers[h];
    res.writeHead(up.statusCode, out);
    if (req.method === "HEAD") { up.destroy(); return res.end(); }
    up.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) send(res, 504, "Drive did not respond");
    else res.destroy();
  });
  upstream.on("close", release);
  // Stop downloading from Drive when the player drops the connection (pause, seek, next file).
  res.on("close", () => { upstream.destroy(); release(); });
}

function handle(req, res) {
  if (!ALLOW_PUBLIC && !isPrivateAddress(req.socket.remoteAddress)) return send(res, 403, "Forbidden");
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
  if (req.url.length > 512) return send(res, 414, "URI too long");

  const pathname = req.url.split("?")[0];
  if (pathname === "/media/health") return send(res, 200, "ok");
  const m = pathname.match(/^\/media\/([\w-]{10,128})$/);
  if (m) return proxyMedia(req, res, m[1]);
  const file = ASSETS.get(pathname);
  if (file) return serveAsset(req, res, file);
  send(res, 404, "Not found");
}

const server = http.createServer((req, res) => {
  try { handle(req, res); }
  catch { if (!res.headersSent) send(res, 500, "Internal error"); else res.destroy(); }
});
// Slow clients cannot hold connections open while sending headers.
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.listen(PORT, HOST, () => console.log(`Drive Autoplay on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`));
