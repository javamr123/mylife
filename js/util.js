const CONFIG_KEY = "lushu.config.v1";
export const CONTENT_BRANCH = "content";

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function siteBase() {
  let path = location.pathname;
  if (path.endsWith("/index.html")) path = path.slice(0, -"index.html".length);
  else if (!path.endsWith("/")) path = `${path}/`;
  return path;
}

export function guessRepo() {
  const host = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (!host) return null;
  const owner = host[1];
  const parts = location.pathname.split("/").filter((part) => part && part !== "index.html");
  if (parts.length === 0) return { owner, repo: `${owner}.github.io` };
  return { owner, repo: parts[0] };
}

export function suggestedRepo(config = loadConfig()) {
  const guess = guessRepo();
  return {
    owner: config.owner || guess?.owner || "javamr123",
    repo: config.repo || guess?.repo || "mylife",
    branch: config.branch || "main",
  };
}

export function loadConfig() {
  const empty = { owner: "", repo: "", branch: "main", token: "" };
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return empty;
    const data = JSON.parse(raw);
    return {
      owner: String(data.owner || ""),
      repo: String(data.repo || ""),
      branch: String(data.branch || "main"),
      token: String(data.token || ""),
    };
  } catch {
    return empty;
  }
}

export function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({
    owner: config.owner,
    repo: config.repo,
    branch: config.branch || "main",
    token: config.token || "",
  }));
}

export function clearToken() {
  const config = loadConfig();
  config.token = "";
  saveConfig(config);
  return config;
}

export function dateOrEmpty(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : "";
}

export function formatRange(date, endDate) {
  if (!date) return "";
  const start = formatOne(date);
  if (!endDate || endDate === date) return start;
  const [y1, m1, d1] = date.split("-").map(Number);
  const [y2, m2, d2] = endDate.split("-").map(Number);
  if (y1 === y2 && m1 === m2) return `${y1}年${m1}月${d1}日 – ${d2}日`;
  if (y1 === y2) return `${y1}年${m1}月${d1}日 – ${m2}月${d2}日`;
  return `${start} – ${formatOne(endDate)}`;
}

function formatOne(date) {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return `${year}年${month}月${day}日`;
}

export function formatStamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function assertId(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(id || "")) {
    throw new Error("这篇记录的编号无效。");
  }
  return id;
}

export function assertRepoPath(path) {
  if (
    typeof path !== "string" ||
    !path.startsWith("content/") ||
    path.includes("..") ||
    path.includes("//") ||
    path.endsWith("/") ||
    !/^content\/[A-Za-z0-9._/-]+$/.test(path)
  ) {
    throw new Error("写入路径不安全，已取消。");
  }
  return path;
}

export function safeImageFile(file) {
  return /^images\/[A-Za-z0-9._-]+$/.test(file || "") ? file : "";
}

export function safeCoverPath(cover, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(id || "")) return "";
  const pattern = new RegExp(`^content/trips/${id}/images/[A-Za-z0-9._-]+$`);
  return pattern.test(cover || "") ? cover : "";
}

export function safeHttps(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

export function safeAvatar(url) {
  return /^https:\/\/avatars\.githubusercontent\.com\//.test(url || "") ? url : "";
}

export function uniqueId(date, trips) {
  const base = dateOrEmpty(date);
  if (!base) throw new Error("请填写出发日期。");
  const used = new Set(trips.map((trip) => trip.id));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function sortTrips(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

export function plainSummary(body, explicit) {
  const given = String(explicit || "").trim();
  if (given) return given.slice(0, 140);
  const text = String(body || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/[#>*_[\]()`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= 90) return text;
  return `${text.slice(0, 90)}…`;
}

export function coordPair(lat, lng) {
  if (lat == null || lng == null || lat === "" || lng === "") return null;
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return {
    lat: Math.round(latitude * 10000) / 10000,
    lng: Math.round(longitude * 10000) / 10000,
  };
}

export function formatLatLng(lat, lng) {
  const north = lat >= 0 ? "N" : "S";
  const east = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}°${north}，${Math.abs(lng).toFixed(2)}°${east}`;
}

export function validateEntry(entry) {
  const errors = [];
  if (!String(entry.title || "").trim()) errors.push("写一个标题。");
  if (!dateOrEmpty(entry.date)) errors.push("填写出发日期。");
  if (entry.endDate && entry.date && entry.endDate < entry.date) {
    errors.push("结束日期要在出发之后。");
  }
  const hasLat = entry.lat != null && entry.lat !== "";
  const hasLng = entry.lng != null && entry.lng !== "";
  if ((hasLat || hasLng) && !coordPair(entry.lat, entry.lng)) errors.push("落点要落在地球上。");
  const images = entry.images || [];
  if (!String(entry.body || "").trim() && images.length === 0) {
    errors.push("写一点正文，或至少放一张照片。");
  }
  if (images.length > 24) errors.push("一次最多 24 张照片。");
  if (String(entry.body || "").length > 20000) errors.push("正文太长了。");
  return errors;
}

export function commitTitle(title) {
  const clean = String(title || "").replace(/\s+/g, " ").trim();
  return `记录：${clean || "未命名"}`.slice(0, 72);
}

export function todayISO() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "");
}

export function validOwner(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value)) return false;
  return value !== "." && value !== ".." && !value.includes("..");
}

export function validBranch(value) {
  return /^[A-Za-z0-9._/-]+$/.test(value || "") && !value.includes("..");
}
