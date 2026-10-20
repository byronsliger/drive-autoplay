// Browser key for the Google Drive API, provided at runtime by /config.js (never committed).
// Restrict it to "Google Drive API" and to the addresses you open the app from in Google Cloud.
const API_KEY = window.DRIVE_API_KEY || "";
const SEEK_STEP = 10; // seconds for the back/forward buttons

const $ = id => document.getElementById(id);
const video = $("player"), audio = $("audio"), listEl = $("list"), msg = $("msg"), rateSel = $("rate");
// Audio files play in <audio>: browsers restrict a hidden page's <video> elements more in the background.
let player = audio;
// Listeners go on both elements but only react to the one in use.
const onMedia = (type, fn) => { for (const el of [video, audio]) el.addEventListener(type, e => { if (e.target === player) fn(e); }); };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

// Theme: manual choice (saved) or, if none, the system preference.
const root = document.documentElement, themeBtn = $("theme"), sysDark = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : sysDark.matches;
function syncTheme() {
  const d = isDark();
  themeBtn.dataset.mode = d ? "dark" : "light";
  const text = d ? "Cambiar a modo claro" : "Cambiar a modo oscuro";
  themeBtn.setAttribute("aria-label", text); themeBtn.title = text;
  // Status bar / app window color follows the effective theme, including a manual choice.
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = d ? "#131A2C" : "#425992";
}
themeBtn.onclick = () => { const t = isDark() ? "light" : "dark"; root.dataset.theme = t; store.set("theme", t); syncTheme(); };
sysDark.addEventListener("change", syncTheme);
syncTheme();

// Background image for audio files: downscaled and stored only in this browser.
const cover = $("cover"), bgClear = $("bgClear"), bgFile = $("bgFile");
let bgUrl = null;
const syncCover = () => { cover.hidden = !bgUrl || player !== audio; };
function applyBg(url) {
  bgUrl = url;
  if (url) cover.src = url; else cover.removeAttribute("src");
  syncCover();
  bgClear.hidden = !url;
}
applyBg(store.get("bg", null));
$("bg").onclick = () => bgFile.click();
bgClear.onclick = () => { try { localStorage.removeItem("bg"); } catch {} applyBg(null); };
bgFile.onchange = async () => {
  const file = bgFile.files[0]; bgFile.value = "";
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1280 / bmp.width);
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.85);
    localStorage.setItem("bg", JSON.stringify(url));
    applyBg(url);
    say("Imagen de fondo aplicada. Se verá con los audios.");
  } catch { say("No se pudo usar esa imagen. Prueba con otra (JPG, PNG o WebP).", true); }
};

let files = [], idx = -1, rate = store.get("rate", 1), folderId = null;
// Progress for every file ever played, in any folder: { t: seconds, d: duration, done: bool }.
let progress = store.get("progress", {}), rows = [];

for (const r of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]) rateSel.add(new Option(r + "x", r));
rateSel.value = rate;
video.defaultPlaybackRate = audio.defaultPlaybackRate = rate;

function say(text, err) { msg.textContent = text; msg.className = err ? "err" : ""; }

function parseFolderId(s) {
  s = s.trim();
  const m = s.match(/\/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(s) ? s : null;
}

const fmt = n => n ? (n / 1048576 >= 1 ? (n / 1048576).toFixed(0) + " MB" : (n / 1024).toFixed(0) + " KB") : "";
const label = name => name.replace(/\.[A-Za-z0-9]{2,5}$/, "");

// A chapter counts as watched once less than 5% (at most 30 s) remains, e.g. credits or outro.
const nearEnd = (t, d) => d > 0 && d - t <= Math.min(30, d * 0.05);
// Files are identified by content (Drive's md5Checksum), not by Drive id, so progress survives a folder
// being deleted and uploaded again. Without a checksum, name + size is the fallback.
const fileKey = f => f.md5Checksum ? "md5:" + f.md5Checksum : "ns:" + f.name + "|" + (f.size || "");
const saveProgress = () => store.set("progress", progress);
const apiUrl = f => `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&key=${API_KEY}`;
// Same-origin media proxy provided by server.js (home server). Browsers cannot use Drive's public
// download endpoint directly (it rejects cross-site requests), and the API endpoint gets throttled.
const proxyUrl = f => `/media/${encodeURIComponent(f.id)}`;
let useProxy = true; // turned off when the app is served without server.js (static hosting)
const stateOf = f => progress[fileKey(f)];
const entry = f => progress[fileKey(f)] ||= { t: 0, d: 0, done: false };

async function listFolder(id) {
  const out = []; let token = "";
  do {
    const p = new URLSearchParams({
      q: `'${id}' in parents and trashed=false and (mimeType contains 'audio/' or mimeType contains 'video/')`,
      fields: "nextPageToken,files(id,name,size,mimeType,md5Checksum)",
      pageSize: "1000", key: API_KEY, supportsAllDrives: "true", includeItemsFromAllDrives: "true"
    });
    if (token) p.set("pageToken", token);
    const res = await fetch("https://www.googleapis.com/drive/v3/files?" + p);
    if (!res.ok) throw new Error(res.status === 404 ? "Carpeta no encontrada o no es pública." : "Error de Drive (" + res.status + "). Revisa la clave y que la carpeta sea pública.");
    const j = await res.json();
    out.push(...j.files); token = j.nextPageToken || "";
  } while (token);
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

const checkIcon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16 9.8"/></svg>';

function render() {
  listEl.innerHTML = "";
  rows = files.map((f, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button"; b.className = "track";
    b.innerHTML = '<span class="num"></span><span class="info"><span class="name"></span><span class="bar"><i></i></span></span><span class="size"></span>';
    b.querySelector(".num").textContent = i + 1;
    b.querySelector(".name").textContent = label(f.name);
    b.querySelector(".size").textContent = fmt(+f.size);
    b.onclick = () => { if (suppressClick) { suppressClick = false; return; } play(i); };
    b.oncontextmenu = e => { e.preventDefault(); openRowMenu(i); };
    b.addEventListener("pointerdown", e => holdStart(e, i));
    const mark = document.createElement("button");
    mark.type = "button"; mark.className = "mark"; mark.innerHTML = checkIcon;
    mark.onclick = () => toggleDone(i);
    li.append(b, mark); listEl.append(li);
    const row = { li, track: b, bar: b.querySelector(".bar"), fill: b.querySelector(".bar i"), mark };
    updateRow(i, row);
    return row;
  });
  updateCount();
}

function updateRow(i, row = rows[i]) {
  if (!row) return;
  const p = stateOf(files[i]), done = !!p?.done, cur = i === idx;
  const pct = done ? 100 : p?.d ? Math.min(100, p.t / p.d * 100) : 0;
  row.li.classList.toggle("done", done);
  row.li.classList.toggle("current", cur);
  if (cur) row.track.setAttribute("aria-current", "true"); else row.track.removeAttribute("aria-current");
  row.bar.hidden = pct <= 0;
  row.fill.style.width = pct.toFixed(1) + "%";
  const text = done ? "Marcar como no visto" : "Marcar como visto";
  row.mark.setAttribute("aria-label", text + ": " + label(files[i].name));
  row.mark.setAttribute("aria-pressed", done);
  row.mark.title = text;
}

function updateCount() {
  if (idx < 0) return;
  const seen = files.filter(f => stateOf(f)?.done).length;
  $("count").textContent = `${idx + 1} de ${files.length} · ${seen} ${seen === 1 ? "visto" : "vistos"}`;
}

function toggleDone(i) {
  const e = entry(files[i]);
  e.done = !e.done;
  // Unmarking restarts the chapter; marking keeps the position so playback is not interrupted.
  if (!e.done) e.t = 0;
  saveProgress(); updateRow(i); updateCount();
}

// Scrolls only the list (not the page) so the row is visible; atTop puts it first, with the next ones below.
function revealRow(li, atTop = false) {
  const box = listEl.getBoundingClientRect(), r = li.getBoundingClientRect();
  if (atTop || r.top < box.top) listEl.scrollTop += r.top - box.top - 4;
  else if (r.bottom > box.bottom) listEl.scrollTop += r.bottom - box.bottom + 4;
}

const refreshAll = () => { rows.forEach((_, j) => updateRow(j)); updateCount(); };

// Row menu: long-press a chapter (right-click or the menu key on a computer) to mark it and all the
// previous ones as watched.
const rowMenu = $("rowMenu"), menuUpTo = $("menuUpTo"), HOLD_MS = 500;
let hold = null, menuRow = -1, suppressClick = false;
function openRowMenu(i) {
  cancelHold();
  if (menuRow >= 0 && menuRow !== i) closeRowMenu();
  menuRow = i;
  menuUpTo.querySelector("span").textContent = i === 0 ? "Marcar como visto" : `Marcar como vistos del 1 al ${i + 1}`;
  rowMenu.hidden = false;
  const r = rows[i].li.getBoundingClientRect(), w = rowMenu.offsetWidth, h = rowMenu.offsetHeight;
  const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + 16));
  const y = r.bottom + h + 8 <= innerHeight ? r.bottom + 4 : Math.max(8, r.top - h - 4);
  Object.assign(rowMenu.style, { left: x + "px", top: y + "px" });
  rows[i].li.classList.add("menu-open");
  menuUpTo.focus({ preventScroll: true });
}
function closeRowMenu(refocus = false) {
  if (menuRow < 0) return;
  rowMenu.hidden = true;
  const row = rows[menuRow];
  menuRow = -1;
  if (row) { row.li.classList.remove("menu-open"); if (refocus) row.track.focus({ preventScroll: true }); }
}
const cancelHold = () => { if (hold) { clearTimeout(hold.timer); hold = null; } };
function holdStart(e, i) {
  suppressClick = false; // a long-press that never produced a click must not swallow the next tap
  if (e.pointerType === "mouse") return; // mice use right-click
  cancelHold();
  hold = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
    hold = null; suppressClick = true;
    try { navigator.vibrate?.(15); } catch {}
    openRowMenu(i);
  }, HOLD_MS) };
}
// Scrolling or lifting the finger before the delay is a normal tap or swipe, not a long-press.
listEl.addEventListener("pointermove", e => {
  if (hold && e.pointerId === hold.id && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10) cancelHold();
});
for (const ev of ["pointerup", "pointercancel"]) listEl.addEventListener(ev, cancelHold);
listEl.addEventListener("scroll", () => closeRowMenu());
addEventListener("resize", () => closeRowMenu());
document.addEventListener("pointerdown", e => { if (!rowMenu.contains(e.target)) closeRowMenu(); }, true);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeRowMenu(true); });
menuUpTo.onclick = () => { const i = menuRow; closeRowMenu(true); markUpTo(i); };

// Marks chapters 1..i (inclusive) as watched, with an undo link in the status line.
function markUpTo(i) {
  const scope = files.slice(0, i + 1);
  const before = scope.map(f => [fileKey(f), stateOf(f) ? { ...stateOf(f) } : null]);
  const changed = before.filter(([, p]) => !p?.done).length;
  if (!changed) return say("Esos capítulos ya estaban marcados como vistos.");
  for (const f of scope) entry(f).done = true;
  saveProgress(); refreshAll();
  say(`${changed} ${changed === 1 ? "capítulo marcado" : "capítulos marcados"} como ${changed === 1 ? "visto" : "vistos"}.`);
  const undo = document.createElement("button");
  undo.type = "button"; undo.className = "link"; undo.textContent = "Deshacer";
  undo.onclick = () => {
    for (const [k, p] of before) { if (p) progress[k] = p; else delete progress[k]; }
    saveProgress(); refreshAll(); say("Cambios deshechos.");
  };
  msg.append(" ", undo);
}

// Switches between the <audio> and <video> elements; the idle one is emptied so it stops downloading.
function useElement(el) {
  if (el !== player) { player.pause(); player.removeAttribute("src"); player.load(); player = el; }
  video.hidden = player !== video; audio.hidden = player !== audio;
  syncCover(); syncFab();
}

// Loads file i at its saved position. Only plays when autoplay=true (list click, prev/next or end of file);
// on page or folder load it is left ready and paused.
function play(i, autoplay = true) {
  if (i < 0 || i >= files.length) return;
  if (idx >= 0) savePos();
  const prev = idx;
  idx = i;
  const f = files[i], p = stateOf(f);
  useElement(f.mimeType.startsWith("video/") ? video : audio);
  player.src = (useProxy ? proxyUrl : apiUrl)(f);
  player.dataset.retried = 0; lastTime = 0; finished = false;
  // A watched chapter that was left at the end starts over; otherwise resume where it was left.
  player.dataset.resume = p && !nearEnd(p.t, p.d) ? p.t : 0;
  if (autoplay) player.play().catch(() => {});
  $("now").textContent = label(f.name);
  $("prev").disabled = i === 0;
  $("next").disabled = i === files.length - 1;
  store.set("last", { folder: folderId, key: fileKey(f) });
  updateRow(prev); updateRow(i); updateCount();
  if (rows[i]) revealRow(rows[i].li);
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: label(f.name) });
}

// playbackRate resets when src changes, so it is always reapplied.
onMedia("loadedmetadata", () => {
  player.playbackRate = rate;
  const t = +player.dataset.resume;
  if (t > 0 && t < player.duration - 2) player.currentTime = t;
  player.dataset.resume = 0;
});
onMedia("ratechange", () => {
  // Adopt speed changes made through the native controls.
  if (player.playbackRate !== rate && player.readyState > 0) setRate(player.playbackRate);
});
// Moves on about a second before the end, while still playing: with the screen off, phones freeze a page
// that went silent, so waiting for "ended" can stall until the screen is turned back on.
const EARLY_NEXT_S = 1;
let finished = false;
function finishChapter() {
  if (idx < 0 || finished) return;
  finished = true;
  const e = entry(files[idx]);
  e.done = true; e.t = 0;
  saveProgress(); updateRow(idx); updateCount();
  if (idx + 1 < files.length) play(idx + 1);
}
onMedia("ended", finishChapter);
onMedia("timeupdate", () => {
  if (player.paused || !(player.duration > 5) || +player.dataset.resume > 0) return;
  if ((player.duration - player.currentTime) / player.playbackRate <= EARLY_NEXT_S) finishChapter();
});
// Remembered so a failed request can be retried at the same second and in the same play/pause state.
let lastTime = 0, wantPlay = false;
const trackTime = () => { if (!(+player.dataset.resume > 0)) lastTime = player.currentTime; };
onMedia("timeupdate", trackTime);
onMedia("seeking", trackTime);
onMedia("play", () => { wantPlay = true; });
onMedia("pause", () => { if (!player.error) wantPlay = false; });

onMedia("error", async () => {
  if (!player.src || idx < 0) return;
  const f = files[idx];
  // Retry once on the other endpoint at the same position and play/pause state. Failures often happen
  // on the new range request made when resuming after a pause.
  if (player.dataset.retried !== "1") {
    const failed = player.src, fromProxy = !failed.startsWith("https://www.googleapis.com/");
    const at = +player.dataset.resume || lastTime, resume = wantPlay;
    // No server.js behind this page (e.g. static hosting): use the API for the rest of the session.
    if (fromProxy) useProxy = await fetch("/media/health").then(r => r.ok, () => false);
    if (player.src !== failed) return; // the user already moved to another file
    player.src = (fromProxy ? apiUrl : proxyUrl)(f);
    player.dataset.retried = 1;
    player.dataset.resume = at;
    if (resume) player.play().catch(() => {});
    return;
  }
  // Both endpoints failed: stay on the file, do not skip ahead or keep playing.
  const src = player.src, name = label(f.name), code = player.error?.code;
  // The media element hides the HTTP status, so probe one byte to tell the user what Drive answered.
  let detail = "";
  try {
    const r = await fetch(src, { headers: { Range: "bytes=0-0" } });
    detail = r.ok
      ? (code === 3 || code === 4 ? " (el navegador no pudo reproducir este formato)" : " (Drive respondió bien: puede ser una extensión o un fallo de red momentáneo)")
      : ` (Drive respondió ${r.status}${r.status === 403 ? ": revisa las restricciones de la API key o espera, puede ser la cuota de descargas" : ""})`;
  } catch { detail = " (Google no respondió o bloqueó un momento las descargas desde tu red; espera unos minutos)"; }
  if (player.src !== src) return; // the user already moved to another file
  say(`No se pudo cargar «${name}»${detail}. Toca el capítulo para reintentar.`, true);
});

let lastSave = 0;
function savePos() {
  // Skip while a resume is pending: currentTime is still 0 and would overwrite the saved position.
  if (idx < 0 || +player.dataset.resume > 0 || !player.duration) return;
  lastSave = Date.now();
  const e = entry(files[idx]);
  e.t = player.currentTime; e.d = player.duration;
  if (!e.done && nearEnd(e.t, e.d)) { e.done = true; updateCount(); }
  saveProgress(); updateRow(idx);
}
onMedia("timeupdate", () => { if (Date.now() - lastSave >= 5000) savePos(); });
onMedia("pause", savePos);
onMedia("seeked", savePos);
// Save when the tab is hidden or the browser is closed.
addEventListener("pagehide", savePos);
document.addEventListener("visibilitychange", () => { if (document.hidden) savePos(); });

function seek(delta) {
  if (!player.duration) return;
  player.currentTime = Math.max(0, Math.min(player.duration, player.currentTime + delta));
}

function setRate(r) {
  rate = r; store.set("rate", r);
  rateSel.value = r;
  video.defaultPlaybackRate = audio.defaultPlaybackRate = r;
  if (player.playbackRate !== r) player.playbackRate = r;
}
rateSel.onchange = () => setRate(+rateSel.value);
$("prev").onclick = () => play(idx - 1);
$("next").onclick = () => play(idx + 1);
$("back10").onclick = () => seek(-SEEK_STEP);
$("fwd10").onclick = () => seek(SEEK_STEP);

// Lock screen / headset controls.
if ("mediaSession" in navigator) {
  const handlers = {
    previoustrack: () => play(idx - 1),
    nexttrack: () => play(idx + 1),
    seekbackward: d => seek(-(d.seekOffset || SEEK_STEP)),
    seekforward: d => seek(d.seekOffset || SEEK_STEP)
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
  }
}

// Floating play/pause button. A tap toggles playback; dragging moves it and the spot is remembered
// as a fraction of the free space, so it stays on screen after rotating or resizing.
const fab = $("fab"), FAB_GAP = 8;
let fabPos = store.get("fabPos", null), fabDrag = null, fabDragged = false;
function placeFab(x, y) {
  const w = fab.offsetWidth, h = fab.offsetHeight, maxX = innerWidth - w - FAB_GAP, maxY = innerHeight - h - FAB_GAP;
  if (x === undefined) { if (!fabPos || !w) return; x = FAB_GAP + fabPos.x * (maxX - FAB_GAP); y = FAB_GAP + fabPos.y * (maxY - FAB_GAP); }
  x = Math.max(FAB_GAP, Math.min(maxX, x)); y = Math.max(FAB_GAP, Math.min(maxY, y));
  Object.assign(fab.style, { left: x + "px", top: y + "px", right: "auto", bottom: "auto" });
  return { x: (x - FAB_GAP) / Math.max(1, maxX - FAB_GAP), y: (y - FAB_GAP) / Math.max(1, maxY - FAB_GAP) };
}
function syncFab() {
  const on = !player.paused, text = on ? "Pausar" : "Reproducir";
  fab.classList.toggle("playing", on);
  fab.setAttribute("aria-label", text); fab.title = text + " (arrastra para moverlo)";
}
fab.addEventListener("pointerdown", e => {
  if (e.button) return;
  const r = fab.getBoundingClientRect();
  fabDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
  fab.setPointerCapture(e.pointerId);
});
fab.addEventListener("pointermove", e => {
  if (!fabDrag || e.pointerId !== fabDrag.id) return;
  // A small threshold keeps a shaky tap from turning into a drag.
  if (!fabDrag.moved && Math.hypot(e.clientX - fabDrag.sx, e.clientY - fabDrag.sy) < 8) return;
  fabDrag.moved = true; fab.classList.add("dragging");
  fabPos = placeFab(e.clientX - fabDrag.dx, e.clientY - fabDrag.dy);
});
const endFabDrag = e => {
  if (!fabDrag || e.pointerId !== fabDrag.id) return;
  if (fabDrag.moved) { fabDragged = true; store.set("fabPos", fabPos); }
  fabDrag = null; fab.classList.remove("dragging");
};
fab.addEventListener("pointerup", endFabDrag);
fab.addEventListener("pointercancel", endFabDrag);
fab.onclick = () => {
  if (fabDragged) { fabDragged = false; return; } // the click that ends a drag is not a tap
  if (player.paused) player.play().catch(() => {}); else player.pause();
};
for (const ev of ["play", "pause", "emptied"]) onMedia(ev, syncFab);
addEventListener("resize", () => placeFab());

async function load(id, resumeKey) {
  say("Cargando carpeta…");
  $("go").disabled = true;
  $("app").hidden = true;
  try {
    folderId = id;
    progress = store.get("progress", {}); // may have changed in another tab
    files = await listFolder(id);
    if (!files.length) { say("La carpeta no contiene archivos de audio o video (o no es pública).", true); return; }
    say(files.length + (files.length === 1 ? " archivo" : " archivos") + " en la carpeta. Mantén presionado un capítulo para marcar como vistos todos hasta ese.");
    store.set("folder", id);
    try { history.replaceState(null, "", "?folder=" + id); } catch {} // shareable link
    $("app").hidden = false;
    idx = -1; render();
    // Resume the last chapter of this folder; otherwise (new or re-uploaded folder) the first unwatched one.
    let i = resumeKey ? files.findIndex(f => fileKey(f) === resumeKey) : -1;
    if (i < 0) i = Math.max(0, files.findIndex(f => !stateOf(f)?.done));
    play(i, false);
    revealRow(rows[i].li, true);
    placeFab();
  } catch (e) { say(e.message || "No se pudo cargar la carpeta.", true); }
  finally { $("go").disabled = false; }
}

const lastFileIn = id => { const last = store.get("last", null); return last && last.folder === id ? last.key : null; };

$("f").onsubmit = e => {
  e.preventDefault();
  const id = parseFolderId($("url").value);
  if (!id) return say("No reconozco la URL de la carpeta.", true);
  if (idx >= 0) savePos();
  load(id, lastFileIn(id));
};

if (!API_KEY) say("Falta configurar la API key: define DRIVE_API_KEY en el servidor (o crea config.js).", true);
else {
  // ?folder=<folder URL or ID> takes precedence over the last saved folder.
  const param = new URLSearchParams(location.search).get("folder");
  const fromParam = param ? parseFolderId(param) : null;
  const id = fromParam || store.get("folder", null);
  if (param && !fromParam) say("El parámetro «folder» de la URL no es una carpeta de Drive válida.", true);
  if (id) {
    $("url").value = "https://drive.google.com/drive/folders/" + id;
    load(id, lastFileIn(id));
  }
}

// PWA: installable app shell.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// Own install button (Chrome/Edge, Android and desktop). Hidden when already running as an installed app.
const installBtn = $("install");
let installPrompt = null;
addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  installPrompt = e;
  installBtn.hidden = false;
});
installBtn.onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  installBtn.hidden = true;
};
addEventListener("appinstalled", () => { installPrompt = null; installBtn.hidden = true; });
