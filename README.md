# Drive Autoplay

Web app (single `index.html`, installable PWA, plus an optional dependency-free `server.js`) that plays the audio and video files of a public Google Drive folder one after another.

## Features

- Autoplay through the folder, sorted by name (natural order: 2 before 10).
- Playback speed, theme and audio background image are remembered.
- **Per-chapter progress**: every chapter resumes where you left it, even after closing the browser.
- **Watched chapters**: marked automatically when finished (less than 5% or 30 s left), or manually with the check button. The double-check button marks every chapter up to that one as watched, with an undo link.
- **Survives re-uploads**: progress is keyed by file content (Drive `md5Checksum`), so if the folder is deleted and uploaded again (new folder and file ids), watched marks and positions are kept. Files without a checksum fall back to name + size.
- **−10 s / +10 s** buttons, also wired to lock-screen and headset controls (Media Session).
- `?folder=<id or URL>` makes a shareable link.

## Install as an app (Android)

The app is a PWA: open it in Chrome on Android and use the **Install** button in the header (or Chrome menu → *Install app*). It gets its own launcher icon (adaptive/maskable), opens in a standalone window without the browser UI, and keeps playing with the screen off through the Media Session controls. Chrome requires HTTPS for this, which Vercel provides.

`vercel.json` serves `sw.js` and the manifest with `no-cache`, so updates reach installed apps on the next launch. Bump `CACHE` in `sw.js` when shell files change.

## Setup

The Drive API rejects keyless requests even for public folders (`403 "Method doesn't allow unregistered callers"`), so the app needs one API key. It is configured once by whoever deploys the app; visitors never log in or enter anything.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **Google Drive API**.
2. Create an **API key** under *APIs & Services → Credentials*. Restrict it to *Google Drive API* and, under *Website restrictions*, to your domain (for example `https://your-app.vercel.app/*` and `http://localhost:*/*` for local testing).
3. Give the key to the app at runtime, never in the repo:
   - with `server.js` / Docker: set the `DRIVE_API_KEY` environment variable;
   - static hosting or local runs without the variable: copy `config.example.js` to `config.js` (gitignored) and put the key there.

The key is a browser key: anyone who can open the app can see it, so keep the website restrictions on.

The folder must be shared as *Anyone with the link → Viewer*.

## Docker / Portainer

Every push to `main` builds `ghcr.io/byronsliger/drive-autoplay:latest` (linux/amd64 and linux/arm64) with GitHub Actions; `v*` tags also publish a version tag. The image contains no API key.

In Portainer: *Stacks → Add stack*, paste `docker-compose.yml`, add the environment variable `DRIVE_API_KEY`, and deploy. Only publish the port on your LAN/VPN; do not forward it on the router. If the pull is denied, make the package public in GitHub (*Packages → drive-autoplay → Package settings → Change visibility*) or add `ghcr.io` as a registry in Portainer with a token that has `read:packages`.

## Run on a home server without Docker

```sh
DRIVE_API_KEY=... node server.js   # PORT=8080 HOST=0.0.0.0 by default
```

`server.js` serves the app and proxies media at `/media/<fileId>` (with HTTP Range, so pause, seek and resume work). This avoids two Google-side blocks seen in practice:

- The Drive API media endpoint (`alt=media` with an API key) is throttled per network: Google answers `403` with an HTML "We're sorry... automated queries" page, often on the new range request made when resuming after a pause. It also happens on other apps using the same approach.
- Drive's public download endpoint (`drive.usercontent.google.com`) answers `403` to any request carrying `Sec-Fetch-Site: cross-site`, which browsers always send from another site, so it cannot be used directly as an `<audio>` source.

The folder listing still goes from the browser to the Drive API, so add every address you open the app from (for example `http://192.168.1.50:8080/*`) to the key's website restrictions. Without `server.js` (any static host, such as Vercel) the app detects that `/media/health` is missing and streams from the Drive API directly.

On Windows, allow Node through the firewall for private networks so other devices on the Wi-Fi/VPN can reach it. Installing as a standalone app on Android requires HTTPS (for example `tailscale serve` if the VPN is Tailscale); over plain `http://<lan-ip>` the player works but Chrome only creates a browser shortcut.

## Deploy (static)

Push the folder to a Git repo and import it in Vercel (no build step, framework preset *Other*), or run `npx vercel` in this folder.

## Storage

Everything is stored in the browser's `localStorage` (`progress`, `last`, `folder`, `rate`, `theme`, `bg`). It is per browser and device; clearing site data resets it.
