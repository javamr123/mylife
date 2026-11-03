import { GitHub, publicContentHead, rawContentUrl } from "./github.js";
import { createGlobe } from "./globe.js";
import { blobToBase64, compressImage, nextPhotoName } from "./images.js";
import { renderMarkdown } from "./markdown.js";
import {
  assertId,
  assertRepoPath,
  clearToken,
  CONTENT_BRANCH,
  commitTitle,
  coordPair,
  dateOrEmpty,
  esc,
  formatLatLng,
  formatRange,
  formatSize,
  formatStamp,
  suggestedRepo,
  loadConfig,
  normalizeToken,
  plainSummary,
  safeCoverPath,
  safeImageFile,
  saveConfig,
  sortTrips,
  todayISO,
  uniqueId,
  validBranch,
  validOwner,
  validateEntry,
} from "./util.js";

const DRAFT_KEY = "lushu.draft.v1";
const GLOBE_VIEW = "lushu.globe.view";
const globes = [];
let pickControl = null;
let cityModule = null;

const state = {
  booted: false,
  loadError: "",
  site: { title: "路书", subtitle: "个人旅行记录", author: "" },
  trips: [],
  source: "repo",
  contentSha: "",
  contentBranch: "",
  auth: null,
  authError: "",
  repoPrivate: false,
  route: { name: "home" },
  hash: "#/",
  view: { status: "loading", error: "" },
  tripCache: new Map(),
  privateUrls: new Map(),
  editor: null,
  gate: "",
  publishing: false,
};

let expectedHash = null;
let toastTimer = 0;

function client() {
  const config = loadConfig();
  if (!config.token || !config.owner || !config.repo) {
    throw new Error("先在设置里连接 GitHub。");
  }
  return new GitHub(config);
}

function parseRoute() {
  const hash = (location.hash || "#/").replace(/^#/, "");
  const parts = hash.split("/").filter(Boolean).map(safeDecode);
  if (parts[0] === "t" && parts[1]) return { name: "trip", id: parts[1] };
  if (parts[0] === "write" && parts[1]) return { name: "write", id: parts[1] };
  if (parts[0] === "write") return { name: "write", id: "" };
  return { name: "home", id: "" };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function go(hash) {
  const next = hash.startsWith("#") ? hash : `#${hash}`;
  if ((location.hash || "#/") === next) {
    onRoute();
    return;
  }
  expectedHash = next;
  location.hash = next;
}

async function boot() {
  state.hash = location.hash || "#/";
  state.route = parseRoute();
  render();
  try {
    await loadShell();
  } catch (error) {
    state.loadError = friendlyError(error);
    state.view = { status: "error", error: state.loadError };
  }
  state.booted = true;
  await onRoute();
}

async function loadShell() {
  const config = loadConfig();
  if (config.token && config.owner && config.repo) {
    try {
      const github = new GitHub(config);
      state.auth = await github.connectInfo();
      state.repoPrivate = state.auth.privateRepo;
      state.authError = "";
      await readAllFromApi(github);
      state.source = "api";
      state.loadError = "";
      state.view = { status: "ready", error: "" };
      return;
    } catch (error) {
      state.auth = null;
      state.repoPrivate = false;
      state.authError = friendlyError(error);
    }
  }
  await readAllFromRepo();
}

async function readAllFromRepo() {
  state.source = "repo";
  state.tripCache.clear();
  if (location.protocol === "file:") {
    throw new Error("请用 GitHub Pages 或本地静态服务器打开。直接双击文件读不到记录。");
  }
  const { owner, repo, branch } = suggestedRepo();
  rememberContent(await publicContentHead({ owner, repo, siteBranch: branch }));
  const indexText = await fetchRawText("content/index.json");
  state.trips = indexText ? parseIndex(indexText) : [];
  const siteText = await fetchRawText("content/site.json");
  if (siteText) state.site = parseSite(siteText);
  await attachCovers();
  state.loadError = "";
  state.view = { status: "ready", error: "" };
}

async function readAllFromApi(github) {
  state.source = "api";
  state.tripCache.clear();
  const ref = await contentRef(github);
  const indexFile = await github.getTextFile("content/index.json", ref.branch);
  state.trips = indexFile ? parseIndex(indexFile.text) : [];
  const siteFile = await github.getTextFile("content/site.json", ref.branch);
  if (siteFile) state.site = parseSite(siteFile.text);
  await attachCovers();
}

async function contentRef(github) {
  try {
    const head = await github.head(CONTENT_BRANCH);
    const ref = { branch: CONTENT_BRANCH, sha: head.commitSha };
    rememberContent(ref);
    return ref;
  } catch (error) {
    if (error.status !== 404) throw error;
    const head = await github.head();
    const ref = { branch: github.branch, sha: head.commitSha };
    rememberContent(ref);
    return ref;
  }
}

function rememberContent(ref) {
  state.contentSha = ref.sha;
  state.contentBranch = ref.branch;
}

async function fetchRawText(path) {
  const { owner, repo } = suggestedRepo();
  let response;
  try {
    response = await fetch(rawContentUrl(owner, repo, state.contentSha, path));
  } catch {
    throw new Error("连不上 GitHub。浏览器需要能直接访问 api.github.com。");
  }
  if (response.status === 404) return "";
  if (!response.ok) throw new Error("读不到旅行记录。");
  return response.text();
}

function parseIndex(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("content/index.json 不是合法的 JSON。");
  }
  const trips = Array.isArray(data?.trips) ? data.trips : [];
  return trips
    .filter((trip) => trip && /^[a-z0-9][a-z0-9-]{0,60}$/.test(trip.id))
    .map((trip) => ({
      id: trip.id,
      title: String(trip.title || "未命名").slice(0, 80),
      date: dateOrEmpty(trip.date),
      endDate: dateOrEmpty(trip.endDate),
      place: String(trip.place || "").slice(0, 40),
      lat: coordPair(trip.lat, trip.lng)?.lat ?? null,
      lng: coordPair(trip.lat, trip.lng)?.lng ?? null,
      summary: String(trip.summary || "").slice(0, 160),
      cover: typeof trip.cover === "string" ? trip.cover : "",
      updated: typeof trip.updated === "string" ? trip.updated : "",
    }))
    .sort(sortTrips);
}

function parseSite(text) {
  try {
    const data = JSON.parse(text);
    return {
      title: String(data.title || "路书").slice(0, 40),
      subtitle: String(data.subtitle || "个人旅行记录").slice(0, 60),
      author: String(data.author || "").slice(0, 40),
    };
  } catch {
    return state.site;
  }
}

async function attachCovers() {
  const paths = state.trips.map((trip) => safeCoverPath(trip.cover, trip.id)).filter(Boolean);
  await prefetchPrivate(paths);
  for (const trip of state.trips) {
    trip.coverSrc = resolveSrc(safeCoverPath(trip.cover, trip.id), trip.updated);
  }
}

async function prefetchPrivate(paths) {
  if (!(state.repoPrivate && state.source === "api")) return;
  const missing = paths.filter((path) => path && !state.privateUrls.has(path));
  await Promise.all(missing.map(async (path) => {
    try {
      state.privateUrls.set(path, await client().getImageObjectUrl(path, state.contentBranch || undefined));
    } catch {
      state.privateUrls.set(path, "");
    }
  }));
}

function resolveSrc(path) {
  if (!path) return "";
  if (state.repoPrivate && state.source === "api") return state.privateUrls.get(path) || "";
  const { owner, repo } = suggestedRepo();
  return rawContentUrl(owner, repo, state.contentSha, path);
}

async function onRoute() {
  const route = parseRoute();
  const sameWrite = route.name === "write"
    && state.route.name === "write"
    && state.editor
    && (route.id || "") === (state.editor.id || "");

  if (sameWrite) {
    state.route = route;
    render();
    return;
  }

  if (state.editor) {
    readEditorDom();
    saveDraft();
    revokeLocalPhotos();
    state.editor = null;
    state.gate = "";
  }

  state.route = route;
  state.hash = location.hash || "#/";

  if (!state.booted) {
    render();
    return;
  }

  if (route.name === "trip") {
    state.view = { status: "loading", error: "" };
    render();
    try {
      await ensureTrip(route.id);
      state.view = { status: "ready", error: "" };
    } catch (error) {
      state.view = { status: "error", error: friendlyError(error) };
    }
    render({ focus: true });
    return;
  }

  if (route.name === "write") {
    state.view = { status: "loading", error: "" };
    render();
    try {
      await prepareEditor(route.id);
      state.view = { status: "ready", error: "" };
    } catch (error) {
      state.editor = null;
      state.view = { status: "error", error: friendlyError(error) };
    }
    render({ focus: true });
    return;
  }

  state.view = state.loadError
    ? { status: "error", error: state.loadError }
    : { status: "ready", error: "" };
  render({ focus: true });
}

async function ensureTrip(id) {
  assertId(id);
  if (state.tripCache.has(id)) return state.tripCache.get(id);

  let metaText = "";
  let bodyText = "";
  if (state.source === "api" && loadConfig().token) {
    const github = client();
    const branch = state.contentBranch || (await contentRef(github)).branch;
    const metaFile = await github.getTextFile(`content/trips/${id}/meta.json`, branch);
    const bodyFile = await github.getTextFile(`content/trips/${id}/journal.md`, branch);
    if (!metaFile) throw new Error("找不到这篇记录。");
    metaText = metaFile.text;
    bodyText = bodyFile?.text || "";
  } else {
    metaText = await fetchRawText(`content/trips/${id}/meta.json`);
    if (!metaText) throw new Error("找不到这篇记录。");
    bodyText = await fetchRawText(`content/trips/${id}/journal.md`);
  }

  let meta;
  try {
    meta = JSON.parse(metaText);
  } catch {
    throw new Error("这篇记录的格式不对。");
  }

  const images = [];
  for (const raw of meta.images || []) {
    const file = safeImageFile(raw.file);
    if (!file) continue;
    images.push({
      file,
      caption: String(raw.caption || "").slice(0, 80),
      cover: Boolean(raw.cover),
    });
  }
  const coverFile = safeImageFile(meta.cover) || images.find((image) => image.cover)?.file || images[0]?.file || "";
  const model = {
    id,
    title: String(meta.title || "未命名").slice(0, 80),
    date: dateOrEmpty(meta.date),
    endDate: dateOrEmpty(meta.endDate),
    place: String(meta.place || "").slice(0, 40),
    summary: String(meta.summary || "").slice(0, 160),
    body: bodyText,
    updated: typeof meta.updated === "string" ? meta.updated : "",
    images,
    coverFile,
  };
  const paths = model.images.map((image) => `content/trips/${id}/${image.file}`);
  await prefetchPrivate(paths);
  for (const image of model.images) {
    image.src = resolveSrc(`content/trips/${id}/${image.file}`, model.updated);
  }
  model.coverSrc = coverFile ? resolveSrc(`content/trips/${id}/${coverFile}`, model.updated) : "";
  state.tripCache.set(id, model);
  return model;
}

async function prepareEditor(id) {
  state.gate = "";
  if (id) {
    assertId(id);
    if (!state.auth?.canPush) {
      state.gate = "edit";
      state.editor = null;
      return;
    }
    await loadExistingEditor(id);
    return;
  }
  state.editor = blankEditor();
  applyNewDraft(state.editor);
}

function blankEditor() {
  return {
    id: "",
    isNew: true,
    title: "",
    date: todayISO(),
    endDate: "",
    place: "",
    lat: null,
    lng: null,
    summary: "",
    body: "",
    images: [],
    removedPaths: [],
    errors: [],
    dirty: false,
    preview: false,
    confirmDelete: false,
    note: "",
  };
}

async function loadExistingEditor(id) {
  const github = client();
  const branch = state.contentBranch || (await contentRef(github)).branch;
  const metaFile = await github.getTextFile(`content/trips/${id}/meta.json`, branch);
  const bodyFile = await github.getTextFile(`content/trips/${id}/journal.md`, branch);
  if (!metaFile) throw new Error("找不到这篇记录。");
  let meta;
  try {
    meta = JSON.parse(metaFile.text);
  } catch {
    throw new Error("这篇记录的格式不对。");
  }
  const images = [];
  for (const raw of meta.images || []) {
    const file = safeImageFile(raw.file);
    if (!file) continue;
    const remotePath = `content/trips/${id}/${file}`;
    images.push({
      name: file.slice("images/".length),
      caption: String(raw.caption || ""),
      cover: Boolean(raw.cover) || meta.cover === file,
      remotePath,
      blob: null,
      previewUrl: "",
      size: 0,
    });
  }
  normalizeCover(images);
  const editor = {
    ...blankEditor(),
    id,
    isNew: false,
    title: String(meta.title || ""),
    date: dateOrEmpty(meta.date) || todayISO(),
    endDate: dateOrEmpty(meta.endDate),
    place: String(meta.place || ""),
    lat: coordPair(meta.lat, meta.lng)?.lat ?? null,
    lng: coordPair(meta.lat, meta.lng)?.lng ?? null,
    summary: String(meta.summary || ""),
    body: bodyFile?.text || "",
    images,
    dirty: false,
  };
  await prefetchPrivate(images.map((image) => image.remotePath));
  for (const image of images) {
    image.previewUrl = resolveSrc(image.remotePath, meta.updated);
  }
  const draft = loadDraft();
  if (draft && !draft.isNew && draft.id === id && meaningfulDraft(draft)) {
    overlayDraft(editor, draft);
    editor.note = draft.hadLocalPhotos
      ? "已恢复未发布的修改。上次新加的照片需要再选一次。"
      : "已恢复未发布的修改。";
    editor.dirty = true;
  }
  state.editor = editor;
}

function render({ focus = false } = {}) {
  if (state.editor && document.getElementById("editor")) readEditorDom();
  destroyGlobes();
  document.title = documentTitle();
  document.getElementById("site-title").textContent = state.site.title || "路书";
  document.getElementById("site-sub").textContent = state.site.subtitle || "个人旅行记录";
  const authorName = (state.site.author || "").trim();
  const author = document.getElementById("site-author");
  author.textContent = authorName;
  author.hidden = !authorName;
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = state.site.subtitle || "个人旅行记录";
  renderAuthPill();

  const view = document.getElementById("view");
  const scrollY = window.scrollY;
  if (state.route.name === "write" && state.view.status === "ready") {
    view.innerHTML = editorHtml();
    bindEditor(view);
    mountPickGlobe();
  } else {
    view.innerHTML = mainHtml();
    if (state.route.name === "home" && state.booted && state.view.status === "ready") mountHomeGlobe();
  }
  if (focus) {
    window.scrollTo(0, 0);
    if (state.route.name === "write" && state.editor?.isNew) {
      view.querySelector("[data-field=title]")?.focus();
    } else {
      view.focus();
    }
  } else {
    window.scrollTo(0, scrollY);
  }
}

function documentTitle() {
  if (state.route.name === "trip") {
    const trip = state.tripCache.get(state.route.id);
    if (trip) return `${trip.title} · ${state.site.title}`;
  }
  if (state.route.name === "write") return `写日志 · ${state.site.title}`;
  return state.site.title || "路书";
}

function renderAuthPill() {
  const pill = document.getElementById("auth-pill");
  const writing = Boolean(state.auth?.canPush);
  pill.hidden = !writing;
  pill.textContent = writing ? "可写" : "";
}

function mainHtml() {
  if (!state.booted || state.view.status === "loading") return `<p class="status">正在读取…</p>`;
  if (state.view.status === "error") return emptyHtml("没有读到", state.view.error);
  if (state.route.name === "trip") return tripHtml();
  return homeHtml();
}

function homeHtml() {
  const banner = draftBanner();
  const landed = landedTrips();
  const loose = state.trips.filter((trip) => !coordPair(trip.lat, trip.lng));
  const looseHtml = loose.length
    ? `<p class="unplaced">还有 ${loose.length} 篇没有落在地球上：${loose.map((trip) => `<a href="#/t/${esc(trip.id)}">${esc(trip.title)}</a>`).join("、")}</p>`
    : "";
  const index = state.trips.length
    ? `<nav class="sr-only" aria-label="全部记录">${state.trips.map((trip) => `<a href="#/t/${esc(trip.id)}">${esc(trip.title)}</a>`).join("")}</nav>`
    : "";
  const caption = landed.length ? "" : `<h1>还没有落下第一站</h1>`;
  return `${banner}<section class="globe-home">
    <canvas id="globe" aria-label="旅行过的地球"></canvas>
    <div id="globe-caption" class="globe-caption">${caption}</div>
    ${looseHtml}
    ${index}
  </section>`;
}

function landedTrips() {
  return state.trips
    .filter((trip) => coordPair(trip.lat, trip.lng))
    .map((trip) => ({ ...trip, ...coordPair(trip.lat, trip.lng) }))
    .sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : (a.date < b.date ? -1 : 1)));
}

function paintCaption(marker) {
  const caption = document.getElementById("globe-caption");
  if (!caption) return;
  if (!landedTrips().length) {
    if (caption.dataset.state === "empty") return;
    caption.dataset.state = "empty";
    caption.dataset.id = "";
    caption.innerHTML = `<h1>还没有落下第一站</h1>`;
    return;
  }
  if (!marker) {
    if (caption.dataset.state === "away") return;
    caption.dataset.state = "away";
    caption.dataset.id = "";
    caption.innerHTML = `<p class="hint">转到有印记的那一面</p>`;
    return;
  }
  if (caption.dataset.state === "trip" && caption.dataset.id === marker.id) return;
  const trip = state.trips.find((item) => item.id === marker.id);
  if (!trip) return;
  caption.dataset.state = "trip";
  caption.dataset.id = trip.id;
  caption.innerHTML = `<a href="#/t/${esc(trip.id)}">
    <p class="kicker">${esc(metaLine(trip))}</p>
    <h1>${esc(trip.title)}</h1>
    ${trip.summary ? `<p class="summary">${esc(trip.summary)}</p>` : ""}
  </a>`;
}

function mountHomeGlobe() {
  const canvas = document.getElementById("globe");
  if (!canvas) return;
  globes.push(createGlobe(canvas, {
    mode: "browse",
    markers: landedTrips(),
    view: readGlobeView(),
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    onSelect: (id) => go(`#/t/${id}`),
    onFront: paintCaption,
    onView: writeGlobeView,
  }));
}

function mountPickGlobe() {
  const canvas = document.getElementById("pick-globe");
  if (!canvas || !state.editor) return;
  pickControl = createGlobe(canvas, {
    mode: "pick",
    pin: coordPair(state.editor.lat, state.editor.lng),
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    onPick: (spot) => {
      const point = coordPair(spot.lat, spot.lng);
      if (!point || !state.editor) return;
      const stamp = ++pickStamp;
      state.editor.lat = point.lat;
      state.editor.lng = point.lng;
      state.editor.dirty = true;
      pickControl?.setPin(point);
      saveDraft();
      paintLandReadout();
      ensureCities().then((mod) => {
        if (stamp !== pickStamp || !state.editor) return;
        const city = mod.nearestCity(point.lat, point.lng);
        writePlace(mod.cityName(city));
        saveDraft();
        paintLandReadout();
      });
    },
  });
  globes.push(pickControl);
  paintLandReadout();
}

function paintLandReadout() {
  const readout = document.getElementById("land-readout");
  if (!readout || !state.editor) return;
  const spot = coordPair(state.editor.lat, state.editor.lng);
  if (!spot) {
    readout.textContent = "还没落点。这篇不会出现在首页的地球上。";
    return;
  }
  const city = cityModule?.nearestCity(spot.lat, spot.lng);
  const where = city ? `${cityModule.cityLine(city)} · ` : "";
  readout.textContent = `${where}落在 ${formatLatLng(spot.lat, spot.lng)}。这篇会出现在首页的地球上。`;
}

function ensureCities() {
  if (cityModule) return Promise.resolve(cityModule);
  return import("./cities.js").then((mod) => {
    cityModule = mod;
    return mod;
  });
}

function writePlace(name) {
  const place = String(name || "").slice(0, 40);
  if (!state.editor) return;
  state.editor.place = place;
  state.editor.dirty = true;
  const input = document.getElementById("place-input");
  if (input) input.value = place;
}

let pickStamp = 0;

function chooseCity(city) {
  const point = coordPair(city[3], city[4]);
  if (!point || !state.editor || !cityModule) return;
  state.editor.lat = point.lat;
  state.editor.lng = point.lng;
  writePlace(cityModule.cityName(city));
  pickControl?.focus(point.lat, point.lng);
  saveDraft();
  paintLandReadout();
}

function destroyGlobes() {
  for (const globe of globes) globe.destroy();
  globes.length = 0;
  pickControl = null;
}

function readGlobeView() {
  try {
    const data = JSON.parse(sessionStorage.getItem(GLOBE_VIEW) || "null");
    if (!data || !Number.isFinite(data.spin) || !Number.isFinite(data.tilt)) return null;
    return data;
  } catch {
    return null;
  }
}

function writeGlobeView(view) {
  try {
    sessionStorage.setItem(GLOBE_VIEW, JSON.stringify({
      spin: view.spin,
      tilt: view.tilt,
      held: Boolean(view.held),
    }));
  } catch {
    // 隐私模式可能写不进这次转动。
  }
}

function forgetGlobeView() {
  sessionStorage.removeItem(GLOBE_VIEW);
}

function storedTrip(trip) {
  const spot = coordPair(trip.lat, trip.lng);
  const stored = {
    id: trip.id,
    title: trip.title,
    date: trip.date,
    endDate: trip.endDate,
    place: trip.place,
    summary: trip.summary,
    cover: trip.cover || "",
    updated: trip.updated || "",
  };
  if (spot) {
    stored.lat = spot.lat;
    stored.lng = spot.lng;
  }
  return stored;
}

function tripHtml() {
  const trip = state.tripCache.get(state.route.id);
  if (!trip) return emptyHtml("找不到这篇", "它可能还没发布，或编号不对。");
  const edit = state.auth?.canPush ? `<a class="btn ghost" href="#/write/${esc(trip.id)}">修改</a>` : "";
  const stamp = formatStamp(trip.updated);
  return `<article class="article">
    <div class="article-top">
      <a class="back" href="#/">← 回到地球</a>
      ${edit}
    </div>
    ${articleHtml(trip)}
    ${stamp ? `<p class="hint">更新于 ${esc(stamp)}</p>` : ""}
  </article>`;
}

function articleHtml(model) {
  const meta = metaLine(model);
  const cover = model.coverSrc
    ? `<img class="cover" src="${esc(model.coverSrc)}" alt="" referrerpolicy="no-referrer">`
    : "";
  const prose = String(model.body || "").trim()
    ? `<div class="prose">${renderMarkdown(model.body, resolverFor(model.images))}</div>`
    : `<p class="hint">这一篇是照片。</p>`;
  return `<p class="kicker">${esc(meta)}</p>
    <h1>${esc(model.title || "未命名")}</h1>
    ${model.summary ? `<p class="lede">${esc(model.summary)}</p>` : ""}
    ${cover}
    ${prose}
    ${galleryHtml(model)}`;
}

function galleryHtml(model) {
  const images = (model.images || []).filter((image) => {
    const file = image.file || `images/${image.name}`;
    if (bodyReferences(model.body, file)) return false;
    if (file === model.coverFile) return false;
    return true;
  });
  if (!images.length) return "";
  return `<section class="gallery">${images.map((image) => {
    const src = image.src || image.previewUrl || "";
    if (!src) return "";
    const caption = image.caption || "";
    return `<figure>
      <img src="${esc(src)}" alt="${esc(caption || "旅行照片")}" referrerpolicy="no-referrer" loading="lazy">
      ${caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}
    </figure>`;
  }).join("")}</section>`;
}

function bodyReferences(body, file) {
  return String(body || "").includes(`(${file})`) || String(body || "").includes(`(./${file})`);
}

function resolverFor(images) {
  return (url) => {
    const found = (images || []).find((image) => {
      const file = image.file || `images/${image.name}`;
      return file === url || file.endsWith(`/${url}`);
    });
    return found?.src || found?.previewUrl || "";
  };
}

function metaLine(model) {
  const when = formatRange(model.date, model.endDate);
  return [when, model.place].filter(Boolean).join(" · ");
}

function emptyHtml(title, copy, action = false) {
  const button = action ? `<p><button type="button" class="btn solid" data-action="write">写第一篇</button></p>` : "";
  return `<section class="empty">
    <p class="seal-large" aria-hidden="true">记</p>
    <h1>${esc(title)}</h1>
    <p>${esc(copy)}</p>
    ${button}
  </section>`;
}

function draftBanner() {
  const draft = meaningfulDraft(loadDraft()) ? loadDraft() : null;
  if (!draft) return "";
  const title = draft.title?.trim() || "未命名";
  return `<div class="banner">
    <p>有未发布的草稿：${esc(title)}</p>
    <div>
      <button type="button" class="btn solid" data-action="resume-draft">继续写</button>
      <button type="button" class="btn ghost" data-action="discard-draft">丢弃</button>
    </div>
  </div>`;
}

function editorHtml() {
  if (state.gate === "edit") {
    return `<section class="gate">
      <p class="seal-large" aria-hidden="true">记</p>
      <h1>还不能修改</h1>
      <p>先在设置里连上，才能改这篇。</p>
      <p><button type="button" class="btn solid" data-action="settings">打开设置</button></p>
    </section>`;
  }
  const editor = state.editor;
  if (!editor) return `<p class="status">正在读取…</p>`;
  if (editor.preview) {
    return `<div id="editor" class="editor">
      <div class="article-top">
        <button type="button" class="btn ghost" data-action="edit-again">返回编辑</button>
      </div>
      <article class="article">${articleHtml(modelFromEditor(editor))}</article>
    </div>`;
  }
  return `<form id="editor" class="editor" novalidate>
    <p><a class="back" href="#/">← 返回</a></p>
    <h1>${editor.isNew ? "新的一篇" : "修改这篇"}</h1>
    ${editor.note ? `<p class="note">${esc(editor.note)}</p>` : ""}
    ${errorHtml(editor.errors)}
    <label class="block"><span>标题</span><input data-field="title" maxlength="80" value="${esc(editor.title)}"></label>
    <div class="split">
      <label class="block"><span>出发</span><input type="date" data-field="date" value="${esc(editor.date)}"></label>
      <label class="block"><span>结束</span><input type="date" data-field="endDate" value="${esc(editor.endDate)}"></label>
    </div>
    <div class="city-field">
      <label class="block" for="place-input"><span>地点</span>
        <input id="place-input" data-field="place" maxlength="40" autocomplete="off" placeholder="搜索城市" value="${esc(editor.place)}">
      </label>
      <ul id="city-list" class="city-list" hidden></ul>
    </div>
    <div class="land-pick">
      <p class="hint">搜索城市，或在球上点一下。点到的城市会写进地点。</p>
      <canvas id="pick-globe" aria-label="选择落点"></canvas>
      <p id="land-readout" class="hint"></p>
      <button type="button" class="btn ghost" data-action="clear-land">清除落点</button>
    </div>
    <label class="block"><span>摘要</span><textarea data-field="summary" maxlength="140" rows="2">${esc(editor.summary)}</textarea></label>
    <label class="block"><span>正文</span><textarea data-field="body" maxlength="20000">${esc(editor.body)}</textarea></label>
    <p class="hint"><span data-count>${editor.body.trim().length} 字</span> · 可用标题、列表、引用和链接。照片默认排在文末。</p>
    <label class="dropzone">
      <input id="photo-input" type="file" accept="image/*" multiple>
      <strong>把照片拖到这里，或点击选择</strong>
      <span class="drop-note hint">照片会压小一些，再放进这篇</span>
    </label>
    ${photoListHtml(editor.images)}
    <div class="editor-actions">
      <button type="button" class="btn ghost" data-action="preview">预览</button>
      <button type="submit" class="btn solid">发布</button>
    </div>
    ${editor.id ? `<p><button type="button" class="btn danger" data-action="delete-trip">${editor.confirmDelete ? "确认删除？" : "删除这篇"}</button></p>` : ""}
  </form>`;
}

function photoMetaHtml(image) {
  const bits = [image.cover ? "封面" : "", image.size ? formatSize(image.size) : ""].filter(Boolean);
  return bits.length ? `<p class="hint">${esc(bits.join(" · "))}</p>` : "";
}

function photoListHtml(images) {
  if (!images.length) return "";
  return images.map((image) => `<div class="photo-item">
    <img src="${esc(image.previewUrl)}" alt="" referrerpolicy="no-referrer">
    <div>
      <input data-caption="${esc(image.name)}" value="${esc(image.caption)}" placeholder="照片说明" maxlength="80">
      ${photoMetaHtml(image)}
      <div class="photo-actions">
        <button type="button" data-action="cover" data-name="${esc(image.name)}">设为封面</button>
        <button type="button" data-action="up" data-name="${esc(image.name)}">上移</button>
        <button type="button" data-action="down" data-name="${esc(image.name)}">下移</button>
        <button type="button" data-action="insert" data-name="${esc(image.name)}">插入正文</button>
        <button type="button" data-action="remove-photo" data-name="${esc(image.name)}">移除</button>
      </div>
    </div>
  </div>`).join("");
}

function errorHtml(errors) {
  if (!errors?.length) return "";
  return `<div class="form-errors">${errors.map((error) => `<p>${esc(error)}</p>`).join("")}</div>`;
}

function modelFromEditor(editor) {
  const images = editor.images.map((image) => ({
    file: `images/${image.name}`,
    name: image.name,
    caption: image.caption,
    cover: image.cover,
    src: image.previewUrl,
    previewUrl: image.previewUrl,
  }));
  const cover = images.find((image) => image.cover) || images[0];
  return {
    id: editor.id || "draft",
    title: editor.title,
    date: editor.date,
    endDate: editor.endDate,
    place: editor.place,
    summary: plainSummary(editor.body, editor.summary),
    body: editor.body,
    images,
    coverFile: cover?.file || "",
    coverSrc: cover?.src || "",
    updated: "",
  };
}

function bindEditor(root) {
  const form = root.querySelector("#editor");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    publish();
  });
  form?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("input")) event.preventDefault();
  });
  root.querySelectorAll("[data-field]").forEach((field) => {
    field.addEventListener("input", () => {
      state.editor[field.dataset.field] = field.value;
      state.editor.dirty = true;
      state.editor.confirmDelete = false;
      saveDraft();
      if (field.dataset.field === "body") {
        const count = root.querySelector("[data-count]");
        if (count) count.textContent = `${field.value.trim().length} 字`;
      }
    });
  });
  bindCityField(root);
  root.querySelectorAll("[data-caption]").forEach((field) => {
    field.addEventListener("input", () => {
      const image = state.editor.images.find((item) => item.name === field.dataset.caption);
      if (!image) return;
      image.caption = field.value;
      state.editor.dirty = true;
      saveDraft();
    });
  });
  const input = root.querySelector("#photo-input");
  const zone = root.querySelector(".dropzone");
  if (!input || !zone) return;
  input.addEventListener("change", () => {
    const files = [...input.files];
    input.value = "";
    addFiles(files);
  });
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("drag");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("drag");
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
  });
}

function bindCityField(root) {
  const input = root.querySelector("#place-input");
  const list = root.querySelector("#city-list");
  if (!input || !list) return;
  let matches = [];
  const close = () => {
    list.hidden = true;
    list.innerHTML = "";
    matches = [];
  };
  const open = (found) => {
    matches = found;
    if (!found.length) {
      close();
      return;
    }
    list.hidden = false;
    list.innerHTML = found.map((city, index) => `<li><button type="button" data-city="${index}">${esc(cityModule.cityLine(city))}</button></li>`).join("");
  };
  input.addEventListener("input", () => {
    if (!cityModule) return;
    open(cityModule.searchCities(input.value));
  });
  input.addEventListener("focus", () => {
    if (!cityModule || !input.value.trim()) return;
    open(cityModule.searchCities(input.value));
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Enter" && matches.length) {
      event.preventDefault();
      chooseCity(matches[0]);
      close();
    }
  });
  list.addEventListener("mousedown", (event) => {
    const button = event.target.closest("[data-city]");
    if (!button) return;
    event.preventDefault();
    chooseCity(matches[Number(button.dataset.city)]);
    close();
  });
  input.addEventListener("blur", () => {
    setTimeout(close, 150);
  });
  ensureCities().then(() => {
    if (document.activeElement === input && input.value.trim()) open(cityModule.searchCities(input.value));
    paintLandReadout();
  });
}

function readEditorDom() {
  const root = document.getElementById("editor");
  if (!root || !state.editor) return;
  root.querySelectorAll("[data-field]").forEach((field) => {
    state.editor[field.dataset.field] = field.value;
  });
  root.querySelectorAll("[data-caption]").forEach((field) => {
    const image = state.editor.images.find((item) => item.name === field.dataset.caption);
    if (image) image.caption = field.value;
  });
}

async function addFiles(fileList) {
  if (!state.editor || state.publishing || state.compressing) return;
  const files = [...fileList];
  if (!files.length) return;
  state.compressing = true;
  try {
    readEditorDom();
    const note = document.querySelector(".drop-note");
    if (note) note.textContent = "正在压缩…";
    let failed = "";
    for (const file of files) {
      if (!state.editor) return;
      if (state.editor.images.length >= 24) {
        failed = "一次最多 24 张照片。";
        break;
      }
      try {
        const blob = await compressImage(file);
        if (!state.editor) return;
        const name = nextPhotoName(state.editor.images, state.editor.removedPaths, blob.type);
        state.editor.images.push({
          name,
          caption: "",
          cover: false,
          remotePath: null,
          blob,
          previewUrl: URL.createObjectURL(blob),
          size: blob.size,
        });
      } catch (error) {
        failed = error.message || "这张照片处理不了。";
      }
    }
    if (!state.editor) return;
    normalizeCover(state.editor.images);
    state.editor.dirty = true;
    saveDraft();
    render();
    if (failed) toast(failed);
  } finally {
    state.compressing = false;
  }
}

function normalizeCover(images) {
  if (!images.length) return;
  if (!images.some((image) => image.cover)) images[0].cover = true;
  let chosen = false;
  for (const image of images) {
    if (image.cover && !chosen) chosen = true;
    else image.cover = false;
  }
}

function movePhoto(name, direction) {
  const images = state.editor.images;
  const index = images.findIndex((image) => image.name === name);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= images.length) return;
  [images[index], images[target]] = [images[target], images[index]];
  state.editor.dirty = true;
  saveDraft();
  render();
}

function removePhoto(name) {
  const image = state.editor.images.find((item) => item.name === name);
  if (!image) return;
  if (image.remotePath) {
    try {
      assertRepoPath(image.remotePath);
      state.editor.removedPaths.push(image.remotePath);
    } catch {
      // 忽略不属于内容目录的路径。
    }
  }
  if (image.blob && image.previewUrl) URL.revokeObjectURL(image.previewUrl);
  state.editor.images = state.editor.images.filter((item) => item.name !== name);
  normalizeCover(state.editor.images);
  state.editor.dirty = true;
  saveDraft();
  render();
}

function insertPhoto(name) {
  const image = state.editor.images.find((item) => item.name === name);
  if (!image) return;
  const alt = (image.caption || "").replace(/[\[\]()]/g, "");
  const snippet = `\n\n![${alt}](images/${image.name})\n`;
  const field = document.querySelector("[data-field=body]");
  const start = field?.selectionStart ?? state.editor.body.length;
  const end = field?.selectionEnd ?? start;
  state.editor.body = `${state.editor.body.slice(0, start)}${snippet}${state.editor.body.slice(end)}`;
  if (field) field.value = state.editor.body;
  state.editor.dirty = true;
  saveDraft();
  render();
}

async function publish() {
  if (!state.editor || state.publishing || state.compressing) return;
  readEditorDom();
  const editor = state.editor;
  const errors = validateEntry(editor);
  if (!state.auth?.canPush) {
    saveDraft();
    openSettings();
    toast("发布需要一枚能写入这座仓库的令牌。文字还留在这页。");
    return;
  }
  if (errors.length) {
    editor.errors = errors;
    render();
    document.querySelector(".form-errors")?.scrollIntoView({ block: "center" });
    return;
  }

  state.publishing = true;
  const submit = document.querySelector('#editor button[type="submit"]');
  if (submit) submit.disabled = true;
  openProgress("正在准备…");
  try {
    const github = client();
    const ref = await contentRef(github);
    const indexFile = await github.getTextFile("content/index.json", ref.branch);
    const indexTrips = indexFile ? parseIndex(indexFile.text) : [];
    const id = editor.id || uniqueId(editor.date, indexTrips);
    const tripPath = `content/trips/${id}`;
    normalizeCover(editor.images);
    const imagesMeta = editor.images.map((image) => ({
      file: `images/${image.name}`,
      caption: image.caption.trim(),
      cover: image.cover,
    }));
    const updated = new Date().toISOString();
    const meta = {
      id,
      title: editor.title.trim(),
      date: editor.date,
      endDate: editor.endDate,
      place: editor.place.trim(),
      summary: plainSummary(editor.body, editor.summary),
      cover: imagesMeta.find((image) => image.cover)?.file || "",
      images: imagesMeta,
      updated,
    };
    const spot = coordPair(editor.lat, editor.lng);
    if (spot) {
      meta.lat = spot.lat;
      meta.lng = spot.lng;
    }
    const entry = {
      id,
      title: meta.title,
      date: meta.date,
      endDate: meta.endDate,
      place: meta.place,
      summary: meta.summary,
      cover: meta.cover ? `${tripPath}/${meta.cover}` : "",
      updated,
      lat: spot?.lat,
      lng: spot?.lng,
    };
    const trips = indexTrips.filter((trip) => trip.id !== id).map(storedTrip);
    trips.push(storedTrip(entry));
    trips.sort(sortTrips);

    const binaries = [];
    const fresh = editor.images.filter((image) => image.blob);
    for (let index = 0; index < fresh.length; index += 1) {
      openProgress(`正在准备照片 ${index + 1} / ${fresh.length}`);
      binaries.push({
        path: `${tripPath}/images/${fresh[index].name}`,
        base64: await blobToBase64(fresh[index].blob),
      });
    }

    await github.commit({
      branch: CONTENT_BRANCH,
      message: commitTitle(meta.title),
      textFiles: [
        { path: `${tripPath}/journal.md`, text: `${editor.body.replace(/\r\n/g, "\n").trim()}\n` },
        { path: `${tripPath}/meta.json`, text: `${JSON.stringify(meta, null, 2)}\n` },
        { path: "content/index.json", text: `${JSON.stringify({ trips }, null, 2)}\n` },
      ],
      binaries,
      deletions: editor.removedPaths,
      onProgress: (progress) => openProgress(progressText(progress)),
    });

    editor.dirty = false;
    revokeLocalPhotos();
    state.editor = null;
    clearDraft();
    forgetGlobeView();
    try {
      await readAllFromApi(github);
    } catch (reloadError) {
      state.loadError = friendlyError(reloadError);
    }
    closeProgress();
    toast("已发布。");
    go(`#/t/${id}`);
  } catch (error) {
    closeProgress();
    if (state.editor) {
      state.editor.errors = [friendlyError(error)];
      render();
    } else {
      toast(friendlyError(error));
    }
  } finally {
    state.publishing = false;
  }
}

async function deleteTrip() {
  const editor = state.editor;
  if (!editor?.id || state.publishing) return;
  if (!state.auth?.canPush) {
    openSettings();
    return;
  }
  if (!editor.confirmDelete) {
    editor.confirmDelete = true;
    const button = document.querySelector("[data-action=delete-trip]");
    if (button) button.textContent = "确认删除？";
    return;
  }
  const id = editor.id;
  state.publishing = true;
  openProgress("正在删除…");
  try {
    const github = client();
    const ref = await contentRef(github);
    const indexFile = await github.getTextFile("content/index.json", ref.branch);
    const trips = (indexFile ? parseIndex(indexFile.text) : []).filter((trip) => trip.id !== id).map(storedTrip);
    const head = await github.head(ref.branch);
    const paths = await github.listBlobPaths(head.treeSha);
    const deletions = paths.filter((path) => path.startsWith(`content/trips/${id}/`));
    await github.commit({
      branch: CONTENT_BRANCH,
      message: `删除记录 ${id}`.slice(0, 72),
      textFiles: [{ path: "content/index.json", text: `${JSON.stringify({ trips }, null, 2)}\n` }],
      binaries: [],
      deletions,
      onProgress: () => openProgress("正在删除…"),
    });
    editor.dirty = false;
    revokeLocalPhotos();
    state.editor = null;
    forgetGlobeView();
    const draft = loadDraft();
    if (draft?.id === id) clearDraft();
    try {
      await readAllFromApi(github);
    } catch {
      state.trips = state.trips.filter((trip) => trip.id !== id);
    }
    closeProgress();
    toast("这篇已删除。");
    go("#/");
  } catch (error) {
    closeProgress();
    editor.errors = [friendlyError(error)];
    editor.confirmDelete = false;
    render();
  } finally {
    state.publishing = false;
  }
}

function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (!draft || typeof draft !== "object") return null;
    return draft;
  } catch {
    return null;
  }
}

function meaningfulDraft(draft) {
  if (!draft) return false;
  const text = `${draft.title || ""}${draft.body || ""}${draft.place || ""}${draft.summary || ""}`.trim();
  return Boolean(text || draft.hadLocalPhotos || (draft.removedPaths || []).length || coordPair(draft.lat, draft.lng));
}

function saveDraft() {
  const editor = state.editor;
  if (!editor?.dirty) return;
  const payload = {
    id: editor.id,
    isNew: editor.isNew,
    title: editor.title,
    date: editor.date,
    endDate: editor.endDate,
    place: editor.place,
    lat: editor.lat,
    lng: editor.lng,
    summary: editor.summary,
    body: String(editor.body || "").slice(0, 20000),
    imageOrder: editor.images.map((image) => ({
      name: image.name,
      caption: image.caption,
      cover: image.cover,
      remotePath: image.remotePath,
    })),
    removedPaths: editor.removedPaths,
    hadLocalPhotos: editor.images.some((image) => image.blob || !image.remotePath),
  };
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
  } catch {
    toast("这台浏览器存不下草稿，离开页面前请先发布。");
  }
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

function applyNewDraft(editor) {
  const draft = loadDraft();
  if (!draft?.isNew || !meaningfulDraft(draft)) return;
  editor.title = String(draft.title || "");
  editor.date = dateOrEmpty(draft.date) || editor.date;
  editor.endDate = dateOrEmpty(draft.endDate);
  editor.place = String(draft.place || "");
  editor.lat = coordPair(draft.lat, draft.lng)?.lat ?? null;
  editor.lng = coordPair(draft.lat, draft.lng)?.lng ?? null;
  editor.summary = String(draft.summary || "");
  editor.body = String(draft.body || "");
  editor.dirty = true;
  editor.note = draft.hadLocalPhotos
    ? "已恢复未发布的文字。照片还要再选一次。"
    : "已恢复未发布的文字。";
}

function overlayDraft(editor, draft) {
  editor.title = String(draft.title ?? editor.title);
  editor.date = dateOrEmpty(draft.date) || editor.date;
  editor.endDate = dateOrEmpty(draft.endDate);
  editor.place = String(draft.place ?? editor.place);
  if ("lat" in draft || "lng" in draft) {
    const spot = coordPair(draft.lat, draft.lng);
    editor.lat = spot?.lat ?? null;
    editor.lng = spot?.lng ?? null;
  }
  editor.summary = String(draft.summary ?? editor.summary);
  editor.body = String(draft.body ?? editor.body);
  editor.removedPaths = (draft.removedPaths || []).filter((path) => {
    try {
      return assertRepoPath(path).startsWith(`content/trips/${editor.id}/`);
    } catch {
      return false;
    }
  });
  const removed = new Set(editor.removedPaths);
  editor.images = editor.images.filter((image) => !removed.has(image.remotePath));
  const order = Array.isArray(draft.imageOrder) ? draft.imageOrder : [];
  if (order.length) {
    const byName = new Map(editor.images.map((image) => [image.name, image]));
    const next = [];
    for (const item of order) {
      const image = byName.get(item.name);
      if (!image) continue;
      image.caption = String(item.caption || "");
      image.cover = Boolean(item.cover);
      next.push(image);
      byName.delete(item.name);
    }
    next.push(...byName.values());
    editor.images = next;
  }
  normalizeCover(editor.images);
}

function revokeLocalPhotos() {
  for (const image of state.editor?.images || []) {
    if (image.blob && image.previewUrl) URL.revokeObjectURL(image.previewUrl);
  }
}

function settingsFormHtml() {
  const siteFields = state.auth?.canPush ? `
    <h3>访客看到的站名</h3>
    <label class="field"><span>标题</span><input name="title" maxlength="40"></label>
    <label class="field"><span>副标题</span><input name="subtitle" maxlength="60"></label>
    <label class="field"><span>作者</span><input name="author" maxlength="40"></label>
    <button type="button" class="btn ghost" data-action="save-site">保存站点信息</button>` : "";
  return `<form class="dialog-body" id="settings-form" novalidate>
    <h2 id="settings-title">设置</h2>
    <div id="settings-status">${statusHtml()}</div>
    <label class="field"><span>用户名</span><input name="owner" autocomplete="off" maxlength="80"></label>
    <label class="field"><span>仓库</span><input name="repo" autocomplete="off" maxlength="120"></label>
    <label class="field"><span>分支</span><input name="branch" autocomplete="off" maxlength="100"></label>
    <div class="field">
      <label for="token-input">令牌</label>
      <span class="token-row">
        <input id="token-input" name="token" type="password" autocomplete="off" spellcheck="false" maxlength="512">
        <button type="button" class="btn ghost" data-action="toggle-token">显示</button>
      </span>
    </div>
    <div class="dialog-actions">
      <button type="submit" class="btn solid" data-action="connect">连接</button>
      <button type="button" class="btn ghost" data-action="clear-token">清除</button>
      <button type="button" class="btn ghost" data-action="close-settings">关闭</button>
    </div>
    ${siteFields}
  </form>`;
}

function statusHtml() {
  if (state.authError && !state.auth) return `<div class="form-errors"><p>${esc(state.authError)}</p></div>`;
  if (!state.auth) return "";
  return `<p>${state.auth.canPush ? "可以写日志。" : "这枚令牌不能写入。"}</p>`;
}

function openSettings() {
  const dialog = document.getElementById("settings-dialog");
  if (dialog.open) return;
  dialog.innerHTML = settingsFormHtml();
  const config = loadConfig();
  const repo = suggestedRepo(config);
  dialog.querySelector("[name=owner]").value = repo.owner;
  dialog.querySelector("[name=repo]").value = repo.repo;
  dialog.querySelector("[name=branch]").value = repo.branch;
  dialog.querySelector("[name=token]").value = config.token || "";
  if (state.auth?.canPush) {
    dialog.querySelector("[name=title]").value = state.site.title;
    dialog.querySelector("[name=subtitle]").value = state.site.subtitle;
    dialog.querySelector("[name=author]").value = state.site.author;
  }
  dialog.querySelector("#settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    connectFromDialog();
  });
  dialog.showModal();
}

function readDialogConfig() {
  const dialog = document.getElementById("settings-dialog");
  const owner = dialog.querySelector("[name=owner]").value.trim();
  const repo = dialog.querySelector("[name=repo]").value.trim();
  const branch = dialog.querySelector("[name=branch]").value.trim() || "main";
  const token = normalizeToken(dialog.querySelector("[name=token]").value);
  if (!token) throw new Error("先粘贴令牌。");
  if (!owner || !repo) throw new Error("填写 GitHub 用户名和仓库名。");
  if (!validOwner(owner) || !validOwner(repo)) throw new Error("用户名或仓库名格式不对。");
  if (!validBranch(branch)) throw new Error("分支名不正确。");
  return { owner, repo, branch, token };
}

async function connectFromDialog() {
  const dialog = document.getElementById("settings-dialog");
  const button = dialog.querySelector("[data-action=connect]");
  button.disabled = true;
  try {
    const next = readDialogConfig();
    const github = new GitHub(next);
    const auth = await github.connectInfo();
    saveConfig(next);
    state.auth = auth;
    state.authError = "";
    state.repoPrivate = auth.privateRepo;
    await readAllFromApi(github);
    state.source = "api";
    state.loadError = "";
    state.view = { status: "ready", error: "" };
    dialog.innerHTML = settingsFormHtml();
    dialog.querySelector("[name=owner]").value = next.owner;
    dialog.querySelector("[name=repo]").value = next.repo;
    dialog.querySelector("[name=branch]").value = next.branch;
    dialog.querySelector("[name=token]").value = next.token;
    if (auth.canPush) {
      dialog.querySelector("[name=title]").value = state.site.title;
      dialog.querySelector("[name=subtitle]").value = state.site.subtitle;
      dialog.querySelector("[name=author]").value = state.site.author;
    }
    dialog.querySelector("#settings-form").addEventListener("submit", (event) => {
      event.preventDefault();
      connectFromDialog();
    });
    render();
    toast(auth.canPush ? "已连接，可以写日志。" : "已连接，但这枚令牌不能写入。");
  } catch (error) {
    state.auth = null;
    state.authError = friendlyError(error);
    const status = dialog.querySelector("#settings-status");
    if (status) status.innerHTML = statusHtml();
  } finally {
    const current = document.querySelector("[data-action=connect]");
    if (current) current.disabled = false;
  }
}

async function saveSiteFromDialog() {
  if (!state.auth?.canPush || state.publishing) return;
  const dialog = document.getElementById("settings-dialog");
  const site = {
    title: dialog.querySelector("[name=title]").value.trim() || "路书",
    subtitle: dialog.querySelector("[name=subtitle]").value.trim() || "个人旅行记录",
    author: dialog.querySelector("[name=author]").value.trim(),
  };
  const text = `${JSON.stringify(site, null, 2)}\n`;
  state.publishing = true;
  openProgress("正在保存站点信息…");
  try {
    const github = client();
    const ref = await contentRef(github);
    const current = await github.getTextFile("content/site.json", ref.branch);
    if (current?.text === text) {
      closeProgress();
      toast("站点信息没有变化。");
      return;
    }
    await github.commit({
      branch: CONTENT_BRANCH,
      message: "更新站点信息",
      textFiles: [{ path: "content/site.json", text }],
      binaries: [],
      deletions: [],
    });
    state.site = site;
    closeProgress();
    render();
    toast("站点信息已保存。");
  } catch (error) {
    closeProgress();
    state.authError = friendlyError(error);
    const status = document.querySelector("#settings-status");
    if (status) status.innerHTML = statusHtml();
  } finally {
    state.publishing = false;
  }
}

function forgetToken() {
  clearToken();
  const tokenInput = document.querySelector("[name=token]");
  if (tokenInput) tokenInput.value = "";
  state.auth = null;
  state.authError = "";
  state.repoPrivate = false;
  state.privateUrls.clear();
  readAllFromRepo()
    .catch((error) => {
      state.loadError = friendlyError(error);
      state.view = { status: "error", error: state.loadError };
    })
    .finally(() => {
      const status = document.querySelector("#settings-status");
      if (status) status.innerHTML = statusHtml();
      render();
      toast("已清除。");
    });
}

function openProgress(text) {
  document.getElementById("progress-text").textContent = text;
  const dialog = document.getElementById("progress-dialog");
  if (!dialog.open) dialog.showModal();
}

function closeProgress() {
  const dialog = document.getElementById("progress-dialog");
  if (dialog.open) dialog.close();
}

function progressText(progress) {
  if (!progress) return "正在准备…";
  if (progress.phase === "upload") return `正在上传照片 ${progress.current} / ${progress.total}`;
  if (progress.phase === "retry") return "分支有新提交，正在重试…";
  if (progress.phase === "commit") return "正在保存…";
  return "正在保存…";
}

function toast(message) {
  const element = document.getElementById("toast");
  element.hidden = false;
  element.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
    element.textContent = "";
  }, 7000);
}

function friendlyError(error) {
  const status = error?.status;
  const message = error?.message || "出错了。";
  if (status === 401) return "令牌无效或已过期。";
  if (status === 403 && /rate limit/i.test(message)) return "GitHub 接口次数用完了，等一会儿再试。";
  if (status === 403) return "令牌没有这次操作的权限。确认它只授给这座仓库，并且 Contents 是读写。";
  if (status === 404) return message === "Not Found" ? "找不到仓库、分支或文件。" : message;
  if (/Repository is empty/i.test(message)) return "仓库还没有任何提交。先把这个网页推上去。";
  if (/Failed to fetch|Load failed|NetworkError/i.test(message)) {
    return "连不上 GitHub。浏览器需要能直接访问 api.github.com。";
  }
  return message;
}

function holdsLocalPhotos(route) {
  if (!state.editor?.images?.some((image) => image.blob)) return false;
  if (route.name === "write" && (route.id || "") === (state.editor.id || "")) return false;
  return true;
}

function onClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "settings") openSettings();
  if (action === "close-settings") document.getElementById("settings-dialog").close();
  if (action === "write") go("#/write");
  if (action === "toggle-token") {
    const input = document.querySelector("[name=token]");
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "隐藏" : "显示";
  }
  if (action === "clear-token") forgetToken();
  if (action === "save-site") saveSiteFromDialog();
  if (action === "resume-draft") {
    const draft = loadDraft();
    go(draft?.id && !draft.isNew ? `#/write/${draft.id}` : "#/write");
  }
  if (action === "discard-draft") {
    clearDraft();
    render();
  }
  if (!state.editor) return;
  if (action === "preview") {
    state.editor.preview = true;
    render();
  }
  if (action === "edit-again") {
    state.editor.preview = false;
    render();
  }
  if (action === "cover") {
    state.editor.images.forEach((image) => {
      image.cover = image.name === button.dataset.name;
    });
    state.editor.dirty = true;
    saveDraft();
    render();
  }
  if (action === "up") movePhoto(button.dataset.name, -1);
  if (action === "down") movePhoto(button.dataset.name, 1);
  if (action === "remove-photo") removePhoto(button.dataset.name);
  if (action === "insert") insertPhoto(button.dataset.name);
  if (action === "delete-trip") deleteTrip();
  if (action === "clear-land") {
    state.editor.lat = null;
    state.editor.lng = null;
    state.editor.dirty = true;
    pickControl?.setPin(null);
    saveDraft();
    paintLandReadout();
  }
}

document.getElementById("settings-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

document.getElementById("progress-dialog").addEventListener("cancel", (event) => {
  if (state.publishing) event.preventDefault();
});

document.addEventListener("click", onClick);

window.addEventListener("hashchange", () => {
  const current = location.hash || "#/";
  if (expectedHash && current !== expectedHash) {
    expectedHash = null;
    return;
  }
  expectedHash = null;
  if (holdsLocalPhotos(parseRoute())) {
    const ok = confirm("离开后，这次选的照片需要重新添加。已写的文字会留在这台浏览器。");
    if (!ok) {
      expectedHash = state.hash || "#/";
      location.hash = expectedHash;
      return;
    }
  }
  state.hash = current;
  onRoute();
});

window.addEventListener("beforeunload", (event) => {
  if (state.editor?.images?.some((image) => image.blob)) {
    event.preventDefault();
    event.returnValue = "";
  }
});

boot();
