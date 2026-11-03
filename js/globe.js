import { land } from "./land.js";

const plane = new Image();
plane.src = new URL("../images/plane.png", import.meta.url).href;
const PLANE_NOSE = -43.9 * Math.PI / 180;

const RAD = Math.PI / 180;
const MAX_ZOOM = 2000;
const CITY_CELL = 8;
const CITY_LNG_CELLS = 360 / CITY_CELL;
let cityList = null;
let cityBuckets = null;
let cityLoad = null;

function loadCities() {
  if (cityList || cityLoad) return;
  cityLoad = import("./cities.js")
    .then((mod) => {
      cityList = mod.cities || [];
      cityBuckets = indexCities(cityList);
    })
    .catch(() => {
      cityLoad = null;
    });
}

function indexCities(list) {
  const buckets = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const city = list[index];
    const key = cityCell(city[3], city[4]);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  }
  return buckets;
}

function cityCell(lat, lng) {
  const latCell = clamp(Math.floor((lat + 90) / CITY_CELL), 0, 22);
  const lngCell = floorMod(Math.floor((lng + 180) / CITY_CELL), CITY_LNG_CELLS);
  return `${latCell}:${lngCell}`;
}

function nearestCityIndex(lat, lng) {
  if (!cityList || !cityBuckets) return -1;
  const latCell = Math.floor((lat + 90) / CITY_CELL);
  const lngCell = Math.floor((lng + 180) / CITY_CELL);
  const cos = Math.cos(lat * RAD);
  let best = -1;
  let bestScore = Infinity;
  for (let dLat = -2; dLat <= 2; dLat += 1) {
    const row = latCell + dLat;
    if (row < 0 || row > 22) continue;
    for (let dLng = -2; dLng <= 2; dLng += 1) {
      const bucket = cityBuckets.get(`${row}:${floorMod(lngCell + dLng, CITY_LNG_CELLS)}`);
      if (!bucket) continue;
      for (let item = 0; item < bucket.length; item += 1) {
        const index = bucket[item];
        const city = cityList[index];
        const dLatRad = (city[3] - lat) * RAD;
        const dLngRad = (city[4] - lng) * RAD * cos;
        const score = dLatRad * dLatRad + dLngRad * dLngRad;
        if (score < bestScore) {
          bestScore = score;
          best = index;
        }
      }
    }
  }
  return best;
}

function floorMod(value, mod) {
  return ((value % mod) + mod) % mod;
}

export function project(lat, lng, spin, tilt) {
  const phi = lat * RAD;
  const lambda = (lng + spin) * RAD;
  const x = Math.cos(phi) * Math.sin(lambda);
  const y = Math.sin(phi);
  const z = Math.cos(phi) * Math.cos(lambda);
  const turn = tilt * RAD;
  return {
    x,
    y: y * Math.cos(turn) - z * Math.sin(turn),
    z: y * Math.sin(turn) + z * Math.cos(turn),
  };
}

export function unproject(nx, ny, spin, tilt) {
  const z = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  const turn = tilt * RAD;
  const y = ny * Math.cos(turn) + z * Math.sin(turn);
  const z0 = -ny * Math.sin(turn) + z * Math.cos(turn);
  const lat = Math.asin(clamp(y, -1, 1)) / RAD;
  const lng = wrap(Math.atan2(nx, z0) / RAD - spin);
  return { lat, lng };
}

export function createGlobe(canvas, options = {}) {
  loadCities();
  const reduced = Boolean(options.reducedMotion);
  const mode = options.mode === "pick" ? "pick" : "browse";
  let markers = chronological(options.markers);
  let pin = options.pin || null;
  let spin = -18;
  let tilt = 20;
  let held = false;
  if (options.view && Number.isFinite(options.view.spin) && Number.isFinite(options.view.tilt)) {
    spin = options.view.spin;
    tilt = clamp(options.view.tilt, -55, 55);
    held = Boolean(options.view.held);
  } else if (pin) {
    spin = -pin.lng;
    tilt = clamp(pin.lat, -55, 55);
  } else if (markers.length) {
    const latest = markers[markers.length - 1];
    spin = -latest.lng;
    tilt = clamp(latest.lat, -55, 55);
  }

  let width = 0;
  let height = 0;
  let dpr = 1;
  let cx = 0;
  let cy = 0;
  let radius = 1;
  let raf = 0;
  let alive = true;
  let last = performance.now();
  let dragging = false;
  let pointerId = null;
  let lastX = 0;
  let lastY = 0;
  let moveStamp = 0;
  let moved = 0;
  let velSpin = 0;
  let velTilt = 0;
  let idleAt = 0;
  let anim = null;
  let frontKey = null;
  let drawn = [];
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let panNX = 0;
  let panNY = 0;
  let drawR = 1;
  let ox = 0;
  let oy = 0;
  let pinching = false;
  let pinch = null;
  let viewKey = "";
  let viewIndexes = null;
  let cityHits = [];
  const pointers = new Map();
  if (options.view && Number.isFinite(options.view.zoom)) zoom = clamp(options.view.zoom, 1, MAX_ZOOM);
  if (options.view && Number.isFinite(options.view.panX)) panNX = options.view.panX;
  if (options.view && Number.isFinite(options.view.panY)) panNY = options.view.panY;
  const context = canvas.getContext("2d");
  const hit = document.createElement("div");
  hit.className = "globe-hit";
  hit.dataset.mode = mode;
  hit.tabIndex = 0;
  const label = canvas.getAttribute("aria-label");
  if (label) hit.setAttribute("aria-label", label);
  canvas.setAttribute("aria-hidden", "true");
  const shell = document.createElement("div");
  shell.className = `globe-frame globe-frame-${mode}`;
  if (canvas.parentNode) {
    canvas.parentNode.insertBefore(shell, canvas);
    shell.append(canvas, hit);
  }

  const syncView = () => {
    radius = Math.max(1, Math.min(width, height) * 0.4);
    cx = width / 2;
    cy = height * 0.46;
    drawR = radius * zoom;
    ox = cx + panX;
    oy = cy + panY;
  };

  const clampPan = () => {
    if (zoom <= 1 || !radius || !width || !height) {
      if (zoom <= 1) {
        zoom = 1;
        panX = 0;
        panY = 0;
      }
      return;
    }
    const maxOffset = Math.max(0, radius * zoom - Math.min(width, height) * 0.2);
    const dist = Math.hypot(panX, panY);
    if (dist > maxOffset) {
      const scale = maxOffset / dist;
      panX *= scale;
      panY *= scale;
    }
  };

  const commitPan = () => {
    clampPan();
    panNX = radius ? panX / radius : 0;
    panNY = radius ? panY / radius : 0;
  };

  let hitKey = "";
  const placeHit = () => {
    const cover = mode === "browse" || drawR * drawR > (width * width + height * height) * 0.22;
    const key = cover ? `cover:${Math.round(width)}:${Math.round(height)}` : `${ox.toFixed(1)}:${oy.toFixed(1)}:${drawR.toFixed(1)}`;
    if (key === hitKey) return;
    hitKey = key;
    if (cover) {
      hit.style.left = "0px";
      hit.style.top = "0px";
      hit.style.width = `${width}px`;
      hit.style.height = `${height}px`;
      hit.style.borderRadius = "0";
      return;
    }
    hit.style.borderRadius = "";
    hit.style.width = `${drawR * 2}px`;
    hit.style.height = `${drawR * 2}px`;
    hit.style.left = `${ox - drawR}px`;
    hit.style.top = `${oy - drawR}px`;
  };

  const applyZoom = (px, py, nextZoom) => {
    syncView();
    const next = clamp(nextZoom, 1, MAX_ZOOM);
    const prevR = Math.max(1, radius * zoom);
    const nextR = Math.max(1, radius * next);
    const nx = (px - cx - panX) / prevR;
    const ny = (cy + panY - py) / prevR;
    zoom = next;
    panX = px - cx - nx * nextR;
    panY = py - cy + ny * nextR;
    held = true;
    anim = null;
    velSpin = 0;
    velTilt = 0;
    idleAt = performance.now();
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    radius = Math.max(1, Math.min(width, height) * 0.4);
    panX = panNX * radius;
    panY = panNY * radius;
    commitPan();
    syncView();
    placeHit();
  };

  const remember = () => {
    options.onView?.({
      spin,
      tilt,
      held,
      zoom,
      panX: radius ? panX / radius : panNX,
      panY: radius ? panY / radius : panNY,
    });
  };

  const face = (lat, lng, animate, done) => {
    const delta = shortest(spin, -lng);
    const nextTilt = clamp(lat, -55, 55);
    held = true;
    if (!animate || reduced) {
      spin += delta;
      tilt = nextTilt;
      anim = null;
      remember();
      done?.();
      return;
    }
    anim = {
      t0: performance.now(),
      dur: 760,
      s0: spin,
      s1: spin + delta,
      a0: tilt,
      a1: nextTilt,
      done,
    };
    velSpin = 0;
    velTilt = 0;
  };

  const step = (dt, now) => {
    if (anim) {
      const t = Math.min(1, (now - anim.t0) / anim.dur);
      const ease = 1 - (1 - t) ** 3;
      spin = anim.s0 + (anim.s1 - anim.s0) * ease;
      tilt = anim.a0 + (anim.a1 - anim.a0) * ease;
      if (t >= 1) {
        spin = anim.s1;
        tilt = anim.a1;
        const done = anim.done;
        anim = null;
        idleAt = now;
        remember();
        done?.();
      }
      return;
    }
    if (dragging || pinching) return;
    if (Math.abs(velSpin) > 0.01 || Math.abs(velTilt) > 0.01) {
      spin += velSpin * dt;
      tilt = clamp(tilt + velTilt * dt, -55, 55);
      const decay = Math.exp(-3.4 * dt);
      velSpin *= decay;
      velTilt *= decay;
      if (Math.abs(velSpin) < 0.01) velSpin = 0;
      if (Math.abs(velTilt) < 0.01) velTilt = 0;
      return;
    }
    if (mode === "browse" && !reduced && now - idleAt > 700) spin -= (4.2 / Math.max(1, zoom)) * dt;
  };

  const draw = () => {
    if (!width || !height) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    syncView();
    placeHit();

    const covered = drawR > Math.hypot(width, height);
    if (zoom < 2.2) {
      context.fillStyle = "rgba(0, 0, 0, 0.45)";
      context.beginPath();
      context.ellipse(ox, oy + drawR * 1.02, drawR * 0.78, Math.max(4, drawR * 0.09), 0, 0, Math.PI * 2);
      context.fill();
    }

    if (covered) {
      context.fillStyle = "#e4d5bf";
      context.fillRect(0, 0, width, height);
    } else {
      const ocean = context.createRadialGradient(ox - drawR * 0.32, oy - drawR * 0.36, drawR * 0.05, ox, oy, drawR);
      ocean.addColorStop(0, "#f7f3ea");
      ocean.addColorStop(0.55, "#e6d8c4");
      ocean.addColorStop(1, "#b89a74");
      context.fillStyle = ocean;
      context.beginPath();
      context.arc(ox, oy, drawR, 0, Math.PI * 2);
      context.fill();
    }

    context.save();
    context.beginPath();
    if (covered) context.rect(0, 0, width, height);
    else context.arc(ox, oy, drawR - 0.5, 0, Math.PI * 2);
    context.clip();
    drawGraticule();
    drawLand();
    drawRoute();
    context.restore();

    if (!covered) {
      context.strokeStyle = "rgba(198, 165, 106, 0.72)";
      context.lineWidth = 1.25;
      context.beginPath();
      context.arc(ox, oy, drawR, 0, Math.PI * 2);
      context.stroke();
    }

    drawn = [];
    for (const marker of markers) drawn.push(placeMarker(marker, false));
    if (pin) drawn.push(placeMarker({ ...pin, id: pin.id || "" }, true));
    drawCities();
    const front = facingMarker();
    const visible = drawn.filter((item) => item.visible).sort((a, b) => a.z - b.z);
    for (const marker of visible) drawSeal(marker, emphasized(marker, front));
    updateFront(front);
  };

  const drawGraticule = () => {
    const step = zoom >= 3.5 ? 10 : zoom >= 1.8 ? 15 : 30;
    const jump = zoom >= 3 ? 2 : 4;
    context.strokeStyle = "rgba(120, 88, 48, 0.2)";
    context.lineWidth = 1;
    context.beginPath();
    for (let lat = -60; lat <= 60; lat += step) strokeLine(sampleLat(lat, jump));
    for (let lng = -180; lng < 180; lng += step) strokeLine(sampleLng(lng, jump));
    context.stroke();
  };

  const drawLand = () => {
    const count = mesh.lat.length;
    for (let index = 0; index < count; index += 1) {
      const point = project(mesh.lat[index], mesh.lng[index], spin, tilt);
      frontX[index] = point.x;
      frontY[index] = point.y;
      frontZ[index] = point.z;
    }
    context.fillStyle = "rgba(22, 17, 13, 0.94)";
    context.beginPath();
    for (let index = 0; index < mesh.triangles.length; index += 3) {
      const poly = clipTriangle(mesh.triangles[index], mesh.triangles[index + 1], mesh.triangles[index + 2]);
      if (poly.length < 3) continue;
      context.moveTo(ox + poly[0].x * drawR, oy - poly[0].y * drawR);
      for (let vertex = 1; vertex < poly.length; vertex += 1) {
        context.lineTo(ox + poly[vertex].x * drawR, oy - poly[vertex].y * drawR);
      }
      context.closePath();
    }
    context.fill();
  };

  const drawRoute = () => {
    if (markers.length < 2) return;
    const legs = [];
    for (let i = 1; i < markers.length; i += 1) {
      if (samePlace(markers[i - 1], markers[i])) continue;
      legs.push(sampleGreatCircle(markers[i - 1], markers[i]));
    }
    if (!legs.length) return;
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    legs.forEach((leg, index) => {
      const age = (index + 1) / legs.length;
      trace(leg, `rgba(247, 243, 234, ${0.42 + 0.5 * age})`, 3.15);
      trace(leg, `rgba(156, 43, 43, ${0.5 + 0.48 * age})`, 1.35);
      drawCourse(leg);
    });
    context.restore();
  };

  const trace = (leg, color, width) => {
    context.strokeStyle = color;
    context.lineWidth = width;
    context.beginPath();
    strokeLine(leg);
    context.stroke();
  };

  const drawCourse = (points) => {
    const [sx, sy] = screen(points[0]);
    const [ex, ey] = screen(points[points.length - 1]);
    const endsOnFront = points[0].z > 0.08 && points[points.length - 1].z > 0.08;
    if (endsOnFront && (ex - sx) ** 2 + (ey - sy) ** 2 < 36 * 36) return;
    let index = -1;
    let score = Infinity;
    for (let i = 1; i < points.length - 1; i += 1) {
      if (points[i].z < 0.14) continue;
      const along = Math.abs(i / (points.length - 1) - 0.62);
      if (along < score) {
        score = along;
        index = i;
      }
    }
    if (index < 0) return;
    const ahead = Math.min(points.length - 1, index + 3);
    const [x1, y1] = screen(points[index]);
    const [x2, y2] = screen(points[ahead]);
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx * dx + dy * dy < 0.25) return;
    if (!plane.complete || !plane.naturalWidth) return;
    const leg = Math.hypot(ex - sx, ey - sy);
    const length = endsOnFront ? clamp(leg * 0.46, 36, 52) : 44;
    const height = length * (plane.naturalHeight / plane.naturalWidth);
    context.save();
    context.translate(x1, y1);
    context.rotate(Math.atan2(dy, dx) - PLANE_NOSE);
    context.shadowColor = "rgba(16, 14, 12, 0.4)";
    context.shadowBlur = 3;
    context.drawImage(plane, -length / 2, -height / 2, length, height);
    context.restore();
  };

  const sampleLat = (lat, jump = 4) => {
    const points = [];
    for (let lng = -180; lng <= 180; lng += jump) points.push(project(lat, lng, spin, tilt));
    return points;
  };

  const sampleLng = (lng, jump = 4) => {
    const points = [];
    for (let lat = -80; lat <= 80; lat += jump) points.push(project(lat, lng, spin, tilt));
    return points;
  };

  const sampleGreatCircle = (from, to) => {
    const a = rawVector(from.lat, from.lng);
    const b = rawVector(to.lat, to.lng);
    const points = [];
    for (let i = 0; i <= 36; i += 1) points.push(tiltVector(slerp(a, b, i / 36)));
    return points;
  };

  const rawVector = (lat, lng) => {
    const phi = lat * RAD;
    const lambda = (lng + spin) * RAD;
    return [Math.cos(phi) * Math.sin(lambda), Math.sin(phi), Math.cos(phi) * Math.cos(lambda)];
  };

  const tiltVector = ([x, y, z]) => {
    const turn = tilt * RAD;
    return {
      x,
      y: y * Math.cos(turn) - z * Math.sin(turn),
      z: y * Math.sin(turn) + z * Math.cos(turn),
    };
  };

  const strokeLine = (points) => {
    let open = false;
    for (let i = 1; i < points.length; i += 1) {
      const piece = clipSegment(points[i - 1], points[i]);
      if (!piece) {
        open = false;
        continue;
      }
      const [start, end] = piece;
      if (!open) {
        const [sx, sy] = screen(start);
        context.moveTo(sx, sy);
        open = true;
      }
      const [ex, ey] = screen(end);
      context.lineTo(ex, ey);
      if (points[i].z < 0.02) open = false;
    }
  };

  const screen = (point) => [ox + point.x * drawR, oy - point.y * drawR];

  const placeMarker = (marker, active) => {
    const point = project(marker.lat, marker.lng, spin, tilt);
    const [sx, sy] = screen(point);
    return { ...marker, sx, sy, z: point.z, visible: point.z > 0.04, active };
  };

  const emphasized = (marker, front) => marker.active || Boolean(front && marker.id && marker.id === front.id);

  const drawSeal = (marker, lead) => {
    const depth = clamp(marker.z, 0.05, 1);
    const unit = clamp(radius / 210, 0.78, 1.12);
    const core = (lead ? 4.5 : 3.35) * (0.84 + depth * 0.16) * unit;
    context.save();
    context.translate(marker.sx, marker.sy);

    context.fillStyle = "rgba(16, 14, 12, 0.22)";
    context.beginPath();
    context.ellipse(0, core * 0.62, core * 0.95, core * 0.34, 0, 0, Math.PI * 2);
    context.fill();

    if (lead) {
      context.strokeStyle = "rgba(198, 165, 106, 0.92)";
      context.lineWidth = 1.15;
      context.beginPath();
      context.arc(0, 0, core + 4.5, 0, Math.PI * 2);
      context.stroke();
    }

    context.fillStyle = "#f7f3ea";
    context.beginPath();
    context.arc(0, 0, core + 1.9, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = "rgba(198, 165, 106, 0.95)";
    context.lineWidth = 1;
    context.beginPath();
    context.arc(0, 0, core + 1.2, 0, Math.PI * 2);
    context.stroke();

    const ink = context.createRadialGradient(-core * 0.3, -core * 0.34, core * 0.15, 0, core * 0.08, core);
    ink.addColorStop(0, "#c24a3c");
    ink.addColorStop(0.7, "#9c2b2b");
    ink.addColorStop(1, "#6e1c1c");
    context.fillStyle = ink;
    context.beginPath();
    context.arc(0, 0, core, 0, Math.PI * 2);
    context.fill();
    context.restore();
  };

  const visibleCityIndexes = () => {
    if (!cityBuckets || !cityList) return null;
    const samples = [
      [width * 0.5, height * 0.5],
      [0, height * 0.5],
      [width, height * 0.5],
      [width * 0.5, 0],
      [width * 0.5, height],
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ];
    const geos = [];
    const keyParts = [];
    for (let item = 0; item < samples.length; item += 1) {
      let nx = (samples[item][0] - ox) / drawR;
      let ny = (oy - samples[item][1]) / drawR;
      const dist2 = nx * nx + ny * ny;
      if (dist2 > 0.9) {
        const scale = Math.sqrt(0.9 / Math.max(dist2, 1e-6));
        nx *= scale;
        ny *= scale;
      }
      const geo = unproject(nx, ny, spin, tilt);
      geos.push(geo);
      keyParts.push(geo.lat.toFixed(0), geo.lng.toFixed(0));
    }
    const key = `${zoom.toFixed(2)}|${keyParts.join(",")}|${Math.round(width)}`;
    if (key === viewKey && viewIndexes) return viewIndexes;
    let minLat = 90;
    let maxLat = -90;
    const lngs = [];
    for (let item = 0; item < geos.length; item += 1) {
      minLat = Math.min(minLat, geos[item].lat);
      maxLat = Math.max(maxLat, geos[item].lat);
      lngs.push(geos[item].lng);
    }
    lngs.sort((a, b) => a - b);
    let maxGap = -1;
    let arcStart = lngs[0];
    for (let item = 0; item < lngs.length; item += 1) {
      const next = item + 1 < lngs.length ? lngs[item + 1] : lngs[0] + 360;
      const gap = next - lngs[item];
      if (gap > maxGap) {
        maxGap = gap;
        arcStart = next > 180 ? next - 360 : next;
      }
    }
    const arcSpan = 360 - maxGap + 8;
    minLat = Math.max(-90, minLat - 4);
    maxLat = Math.min(90, maxLat + 4);
    const seen = new Set();
    const found = [];
    const lat0 = Math.floor((minLat + 90) / CITY_CELL);
    const lat1 = Math.floor((maxLat + 90) / CITY_CELL);
    const lng0 = Math.floor((arcStart + 180) / CITY_CELL);
    const lngSteps = Math.ceil(arcSpan / CITY_CELL) + 1;
    for (let latCell = lat0; latCell <= lat1; latCell += 1) {
      if (latCell < 0 || latCell > 22) continue;
      for (let step = 0; step < lngSteps; step += 1) {
        const id = `${latCell}:${floorMod(lng0 + step, CITY_LNG_CELLS)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const bucket = cityBuckets.get(id);
        if (!bucket) continue;
        for (let item = 0; item < bucket.length; item += 1) found.push(bucket[item]);
      }
    }
    found.sort((a, b) => a - b);
    viewKey = key;
    viewIndexes = found;
    return found;
  };

  const drawCities = () => {
    cityHits = [];
    if (!cityList || !cityList.length) return;
    const indexes = visibleCityIndexes();
    if (!indexes) return;
    const maxLabels = Math.round(clamp(Math.min(width, height) / 18, 14, 42) * clamp(zoom ** 0.8, 1, 8));
    const pinned = new Set();
    for (let item = 0; item < drawn.length; item += 1) {
      const marker = drawn[item];
      if (!marker.visible || !Number.isFinite(marker.lat) || !Number.isFinite(marker.lng)) continue;
      const index = nearestCityIndex(marker.lat, marker.lng);
      if (index >= 0) pinned.add(index);
    }
    const placed = [];
    const spots = [];
    const seen = new Set();
    const onScreen = (x, y) => x >= -12 && y >= -8 && x <= width + 12 && y <= height + 8;
    const onDisc = (x, y) => {
      const dx = (x - ox) / drawR;
      const dy = (y - oy) / drawR;
      return dx * dx + dy * dy <= 0.98;
    };
    const labelHits = (boxX, boxY, boxW, boxH) => {
      for (let item = 0; item < placed.length; item += 1) {
        const box = placed[item];
        if (!box.labeled) continue;
        if (Math.abs(boxX - box.x) < (boxW + box.w) / 2 + 5 && Math.abs(boxY - box.y) < (boxH + box.h) / 2 + 3) return true;
      }
      return false;
    };
    const consider = (index, force) => {
      if (seen.has(index)) return;
      seen.add(index);
      const city = cityList[index];
      const name = city[0];
      if (!name) return;
      const point = project(city[3], city[4], spin, tilt);
      if (point.z < 0.05) return;
      const sx = ox + point.x * drawR;
      const sy = oy - point.y * drawR;
      if (!onDisc(sx, sy) || !onScreen(sx, sy)) return;
      const fontSize = index < 80 || force ? 13 : 12;
      const font = `500 ${fontSize}px "Songti SC", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", serif`;
      let tx = null;
      let ty = sy;
      let boxX = 0;
      let boxW = 0;
      const wantLabel = force || spots.length < maxLabels;
      if (wantLabel) {
        context.font = font;
        const textWidth = context.measureText(name).width;
        const boxH = fontSize + 2;
        const anchors = force
          ? [[sx - textWidth / 2, sy - 16], [sx + 8, sy - 14], [sx - textWidth - 8, sy - 14], [sx + 8, sy + 2]]
          : [[sx + 6, sy], [sx - textWidth - 6, sy], [sx - textWidth / 2, sy - 12], [sx - textWidth / 2, sy + 12]];
        for (let item = 0; item < anchors.length; item += 1) {
          const nextX = anchors[item][0];
          const nextY = anchors[item][1];
          if (nextX < 2 || nextX + textWidth > width - 2 || nextY < 8 || nextY > height - 4) continue;
          const nextBoxX = nextX + textWidth / 2;
          if (!force && labelHits(nextBoxX, nextY, textWidth, boxH)) continue;
          tx = nextX;
          ty = nextY;
          boxX = nextBoxX;
          boxW = textWidth;
          break;
        }
        if (force && tx == null) {
          tx = clamp(sx + 8, 2, Math.max(2, width - textWidth - 2));
          ty = clamp(sy - 16, 10, Math.max(10, height - 6));
          boxX = tx + textWidth / 2;
          boxW = textWidth;
        }
      }
      if (tx == null) return;
      placed.push({
        x: boxX,
        y: ty,
        w: boxW,
        h: fontSize + 2,
        sx,
        sy,
        labeled: tx != null,
      });
      const dot = force ? 0 : (index < 80 ? 2.15 : 1.7);
      cityHits.push({
        name,
        lat: city[3],
        lng: city[4],
        tx,
        ty,
        w: boxW,
        h: fontSize + 2,
        sx,
        sy,
        dot,
        marked: force,
      });
      spots.push({
        sx,
        sy,
        tx,
        ty,
        name,
        font,
        dot,
        alpha: clamp((point.z - 0.05) / 0.35, 0.72, 1),
      });
    };
    for (const index of pinned) consider(index, true);
    for (let item = 0; item < indexes.length; item += 1) consider(indexes[item], false);
    if (!spots.length) return;
    context.save();
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    for (let item = 0; item < spots.length; item += 1) {
      const spot = spots[item];
      if (!spot.dot) continue;
      context.globalAlpha = spot.alpha;
      context.beginPath();
      context.fillStyle = "rgba(16, 14, 12, 0.9)";
      context.arc(spot.sx, spot.sy, spot.dot + 0.85, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.fillStyle = "#e6d3a1";
      context.arc(spot.sx, spot.sy, spot.dot, 0, Math.PI * 2);
      context.fill();
    }
    for (let item = 0; item < spots.length; item += 1) {
      const spot = spots[item];
      if (!spot.name) continue;
      context.globalAlpha = 1;
      context.font = spot.font;
      context.lineWidth = 2.4;
      context.strokeStyle = "rgba(16, 14, 12, 0.82)";
      context.strokeText(spot.name, spot.tx, spot.ty);
      context.fillStyle = "#f7f3ea";
      context.fillText(spot.name, spot.tx, spot.ty);
    }
    context.restore();
  };

  const facingMarker = () => {
    if (mode !== "browse") return null;
    let best = null;
    let bestDistance = Infinity;
    const reach = zoom > 1.2 ? Math.min(width, height) * 0.42 : radius * 0.5;
    for (const marker of drawn) {
      if (!marker.id || marker.z < 0.25) continue;
      const distance = Math.hypot(marker.sx - cx, marker.sy - cy);
      if (distance < reach && distance < bestDistance) {
        best = marker;
        bestDistance = distance;
      }
    }
    return best;
  };

  const updateFront = (best = facingMarker()) => {
    if (mode !== "browse") return;
    const key = best?.id || "";
    if (key === frontKey) return;
    frontKey = key;
    options.onFront?.(best);
  };

  const hitMarker = (px, py, reach = 26) => {
    let best = null;
    let bestDistance = reach;
    for (const marker of drawn) {
      if (!marker.visible || !marker.id) continue;
      const distance = Math.hypot(marker.sx - px, marker.sy - py);
      if (distance < bestDistance) {
        best = marker;
        bestDistance = distance;
      }
    }
    return best;
  };

  const hitCity = (px, py) => {
    let dotHit = null;
    for (let item = cityHits.length - 1; item >= 0; item -= 1) {
      const city = cityHits[item];
      const onLabel = px >= city.tx - 5
        && px <= city.tx + city.w + 5
        && py >= city.ty - city.h / 2 - 5
        && py <= city.ty + city.h / 2 + 5;
      if (onLabel) return { ...city, label: true };
      if (!dotHit && city.dot && Math.hypot(px - city.sx, py - city.sy) <= city.dot + 6) dotHit = city;
    }
    return dotHit;
  };

  const hitMarkedCity = (px, py) => {
    const city = hitCity(px, py);
    return city?.marked ? city : null;
  };

  const markerForCity = (city) => {
    if (!city) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const marker of drawn) {
      if (!marker.visible || !marker.id) continue;
      const distance = Math.hypot(marker.sx - city.sx, marker.sy - city.sy);
      if (distance < bestDistance) {
        best = marker;
        bestDistance = distance;
      }
    }
    return best;
  };

  const localPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onDisk = (px, py) => {
    const dx = (px - ox) / drawR;
    const dy = (py - oy) / drawR;
    return dx * dx + dy * dy <= 1.02;
  };

  const trackPointer = (event) => {
    const point = localPoint(event);
    pointers.set(event.pointerId, {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lx: point.x,
      ly: point.y,
    });
  };

  const fingerSpan = () => {
    const pts = [...pointers.values()];
    const a = pts[0];
    const b = pts[1];
    return {
      dist: Math.max(8, Math.hypot(a.lx - b.lx, a.ly - b.ly)),
      mx: (a.lx + b.lx) / 2,
      my: (a.ly + b.ly) / 2,
    };
  };

  const beginPinch = () => {
    dragging = false;
    pinching = true;
    velSpin = 0;
    velTilt = 0;
    anim = null;
    held = true;
    moved = 24;
    idleAt = performance.now();
    pinch = fingerSpan();
  };

  const onDown = (event) => {
    syncView();
    const point = localPoint(event);
    if (pointers.size === 0 && !onDisk(point.x, point.y) && !(mode === "browse" && (hitMarker(point.x, point.y, 22) || hitMarkedCity(point.x, point.y)))) return;
    trackPointer(event);
    try { hit.setPointerCapture(event.pointerId); } catch { /* 某些浏览器在测试里没有真实指针。 */ }
    if (pointers.size >= 2) {
      beginPinch();
      return;
    }
    dragging = true;
    pointerId = event.pointerId;
    moved = 0;
    lastX = event.clientX;
    lastY = event.clientY;
    velSpin = 0;
    velTilt = 0;
    anim = null;
    held = true;
    moveStamp = performance.now();
  };

  const onMove = (event) => {
    syncView();
    const point = localPoint(event);
    if (pointers.has(event.pointerId)) trackPointer(event);
    if (pointers.size >= 2 && pinch) {
      event.preventDefault();
      const next = fingerSpan();
      const factor = next.dist / pinch.dist;
      if (Number.isFinite(factor) && factor > 0) applyZoom(pinch.mx, pinch.my, zoom * factor);
      panX += next.mx - pinch.mx;
      panY += next.my - pinch.my;
      commitPan();
      pinch = next;
      moved = 24;
      return;
    }
    if (!dragging || event.pointerId !== pointerId) {
      if (mode === "browse") {
        const hot = hitMarker(point.x, point.y, 22) || hitMarkedCity(point.x, point.y);
        hit.style.cursor = hot ? "pointer" : onDisk(point.x, point.y) ? "" : "default";
      }
      return;
    }
    event.preventDefault();
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    const deg = (180 / Math.PI) / Math.max(drawR, 1);
    const now = performance.now();
    const dt = Math.max(0.016, (now - moveStamp) / 1000);
    moveStamp = now;
    velSpin = (dx * deg) / dt;
    velTilt = (dy * deg) / dt;
    spin += dx * deg;
    tilt = clamp(tilt + dy * deg, -55, 55);
  };

  const finish = (event, pick) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    if (!pick || moved > 6) {
      if (reduced || moved <= 6) {
        velSpin = 0;
        velTilt = 0;
      }
      remember();
      return;
    }
    velSpin = 0;
    velTilt = 0;
    syncView();
    const point = localPoint(event);
    const marker = hitMarker(point.x, point.y, 22);
    const marked = !marker && mode === "browse" ? markerForCity(hitMarkedCity(point.x, point.y)) : null;
    const chosen = marker || marked;
    if (chosen && options.onSelect) {
      options.onSelect(chosen.id);
      return;
    }
    if (mode === "pick") {
      const nx = (point.x - ox) / drawR;
      const ny = (oy - point.y) / drawR;
      if (nx * nx + ny * ny <= 1) {
        const spot = unproject(nx, ny, spin, tilt);
        pin = { lat: spot.lat, lng: spot.lng };
        options.onPick?.(spot);
      }
    }
    remember();
  };

  const endPointer = (event, pick) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pinching) {
      if (pointers.size >= 2) {
        pinch = fingerSpan();
        return;
      }
      pinching = false;
      pinch = null;
      remember();
      if (pointers.size === 1) {
        const rest = [...pointers.values()][0];
        dragging = true;
        pointerId = rest.id;
        moved = 24;
        lastX = rest.x;
        lastY = rest.y;
        moveStamp = performance.now();
        velSpin = 0;
        velTilt = 0;
        return;
      }
      dragging = false;
      pointerId = null;
      return;
    }
    finish(event, pick);
  };

  const onWheel = (event) => {
    syncView();
    const point = localPoint(event);
    if (!onDisk(point.x, point.y)) return;
    event.preventDefault();
    let dy = event.deltaY;
    if (event.deltaMode === 1) dy *= 16;
    else if (event.deltaMode === 2) dy *= height;
    dy = clamp(dy, -240, 240);
    const gain = event.ctrlKey ? 0.012 : 0.0022;
    applyZoom(point.x, point.y, zoom * Math.exp(-dy * gain));
    commitPan();
    remember();
  };

  const onKey = (event) => {
    const step = event.shiftKey ? 18 : 8;
    let used = true;
    if (event.key === "ArrowLeft") spin -= step;
    else if (event.key === "ArrowRight") spin += step;
    else if (event.key === "ArrowUp") tilt = clamp(tilt - step, -55, 55);
    else if (event.key === "ArrowDown") tilt = clamp(tilt + step, -55, 55);
    else if (event.key === "+" || event.key === "=") applyZoom(cx, cy, zoom * 1.28);
    else if (event.key === "-" || event.key === "_") applyZoom(cx, cy, zoom / 1.28);
    else if (event.key === "0") {
      zoom = 1;
      panX = 0;
      panY = 0;
      commitPan();
      held = true;
      anim = null;
      velSpin = 0;
      velTilt = 0;
    } else used = false;
    if (!used) return;
    event.preventDefault();
    if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_") commitPan();
    held = true;
    velSpin = 0;
    velTilt = 0;
    anim = null;
    remember();
  };

  const frame = (now) => {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt, now);
    if (!alive) return;
    draw();
    if (!alive) return;
    raf = requestAnimationFrame(frame);
  };

  const onUp = (event) => endPointer(event, true);
  const onCancel = (event) => endPointer(event, false);
  hit.addEventListener("pointerdown", onDown);
  hit.addEventListener("pointermove", onMove);
  hit.addEventListener("pointerup", onUp);
  hit.addEventListener("pointercancel", onCancel);
  hit.addEventListener("keydown", onKey);
  hit.addEventListener("wheel", onWheel, { passive: false });
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  resize();
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      hit.removeEventListener("pointerdown", onDown);
      hit.removeEventListener("pointermove", onMove);
      hit.removeEventListener("pointerup", onUp);
      hit.removeEventListener("pointercancel", onCancel);
      hit.removeEventListener("keydown", onKey);
      hit.removeEventListener("wheel", onWheel);
      hit.remove();
      if (shell.parentNode && shell.contains(canvas)) shell.replaceWith(canvas);
    },
    setPin(next) {
      pin = next;
    },
    focus(lat, lng) {
      pin = { lat, lng };
      face(lat, lng, true);
    },
    setMarkers(next) {
      markers = chronological(next);
    },
  };
}

const HORIZON = 0.02;
const mesh = buildLandMesh(land);
const frontX = new Float64Array(mesh.lat.length);
const frontY = new Float64Array(mesh.lat.length);
const frontZ = new Float64Array(mesh.lat.length);

function buildLandMesh(rings) {
  const lat = [];
  const lng = [];
  const triangles = [];
  for (const ring of rings) {
    let count = ring.length / 2;
    if (count > 2 && ring[0] === ring[(count - 1) * 2] && ring[1] === ring[(count - 1) * 2 + 1]) count -= 1;
    if (count < 3) continue;
    const base = lat.length;
    const points = [];
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let index = 0; index < count; index += 1) {
      const longitude = ring[index * 2];
      const latitude = ring[index * 2 + 1];
      lng.push(longitude);
      lat.push(latitude);
      const point = unitVector(latitude, longitude);
      points.push(point);
      sx += point[0];
      sy += point[1];
      sz += point[2];
    }
    const length = Math.hypot(sx, sy, sz) || 1;
    const center = [sx / length, sy / length, sz / length];
    const axes = tangentBasis(center);
    const flat = points.map((point) => stereographic(point, center, axes));
    for (const index of triangulate(flat)) triangles.push(base + index);
  }
  return { lat, lng, triangles };
}

function unitVector(lat, lng) {
  const phi = lat * RAD;
  const lambda = lng * RAD;
  const cosine = Math.cos(phi);
  return [cosine * Math.cos(lambda), cosine * Math.sin(lambda), Math.sin(phi)];
}

function tangentBasis(center) {
  const aux = Math.abs(center[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  let ex = aux[1] * center[2] - aux[2] * center[1];
  let ey = aux[2] * center[0] - aux[0] * center[2];
  let ez = aux[0] * center[1] - aux[1] * center[0];
  const length = Math.hypot(ex, ey, ez);
  ex /= length;
  ey /= length;
  ez /= length;
  return {
    e: [ex, ey, ez],
    n: [center[1] * ez - center[2] * ey, center[2] * ex - center[0] * ez, center[0] * ey - center[1] * ex],
  };
}

function stereographic(point, center, axes) {
  const dot = point[0] * center[0] + point[1] * center[1] + point[2] * center[2];
  const scale = 2 / (1 + dot);
  const x = (scale - 1) * center[0] + scale * point[0];
  const y = (scale - 1) * center[1] + scale * point[1];
  const z = (scale - 1) * center[2] + scale * point[2];
  return [
    x * axes.e[0] + y * axes.e[1] + z * axes.e[2],
    x * axes.n[0] + y * axes.n[1] + z * axes.n[2],
  ];
}

function triangulate(flat) {
  const index = flat.map((_, item) => item);
  let area = 0;
  for (let item = 0; item < flat.length; item += 1) area += earCross(flat, 0, item, (item + 1) % flat.length);
  if (area < 0) index.reverse();
  const triangles = [];
  let guard = flat.length * flat.length;
  while (index.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let cursor = 0; cursor < index.length; cursor += 1) {
      const i0 = index[(cursor + index.length - 1) % index.length];
      const i1 = index[cursor];
      const i2 = index[(cursor + 1) % index.length];
      if (earCross(flat, i0, i1, i2) <= 1e-12) continue;
      let blocked = false;
      for (let probe = 0; probe < index.length; probe += 1) {
        const point = index[probe];
        if (point === i0 || point === i1 || point === i2) continue;
        if (earContains(flat, point, i0, i1, i2)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      triangles.push(i0, i1, i2);
      index.splice(cursor, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (index.length === 3) triangles.push(index[0], index[1], index[2]);
  return triangles;
}

function earCross(flat, i, j, k) {
  const a = flat[i];
  const b = flat[j];
  const c = flat[k];
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function earContains(flat, point, a, b, c) {
  const ab = earCross(flat, a, b, point);
  const bc = earCross(flat, b, c, point);
  const ca = earCross(flat, c, a, point);
  return ab >= 0 && bc >= 0 && ca >= 0;
}

function clipTriangle(i, j, k) {
  const a = { x: frontX[i], y: frontY[i], z: frontZ[i] };
  const b = { x: frontX[j], y: frontY[j], z: frontZ[j] };
  const c = { x: frontX[k], y: frontY[k], z: frontZ[k] };
  if (a.z >= HORIZON && b.z >= HORIZON && c.z >= HORIZON) return [a, b, c];
  if (a.z < HORIZON && b.z < HORIZON && c.z < HORIZON) return [];
  const input = [a, b, c];
  const output = [];
  for (let index = 0; index < input.length; index += 1) {
    const from = input[index];
    const to = input[(index + 1) % input.length];
    const fromIn = from.z >= HORIZON;
    const toIn = to.z >= HORIZON;
    if (fromIn && toIn) output.push(to);
    else if (fromIn && !toIn) output.push(planeCut(from, to));
    else if (!fromIn && toIn) {
      output.push(planeCut(from, to));
      output.push(to);
    }
  }
  return output;
}

function planeCut(from, to) {
  const t = (HORIZON - from.z) / (to.z - from.z);
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: HORIZON,
  };
}

function clipSegment(a, b) {
  const limit = 0.02;
  if (a.z >= limit && b.z >= limit) return [a, b];
  if (a.z < limit && b.z < limit) return null;
  const t = (limit - a.z) / (b.z - a.z);
  const mid = {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: limit,
  };
  return a.z >= limit ? [a, mid] : [mid, b];
}

function slerp(a, b, t) {
  const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  const angle = Math.acos(dot);
  if (angle < 1e-3) return a;
  const scale = Math.sin(angle);
  const left = Math.sin((1 - t) * angle) / scale;
  const right = Math.sin(t * angle) / scale;
  return [
    a[0] * left + b[0] * right,
    a[1] * left + b[1] * right,
    a[2] * left + b[2] * right,
  ];
}

function chronological(list) {
  return (list || []).slice().sort(byTime);
}

function byTime(a, b) {
  const date = compareText(a.date, b.date);
  if (date) return date;
  const updated = compareText(a.updated, b.updated);
  if (updated) return updated;
  return compareText(a.id, b.id);
}

function compareText(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function samePlace(a, b) {
  const lat = (a.lat - b.lat) * RAD;
  const lng = (a.lng - b.lng) * RAD;
  return lat * lat + lng * lng < (0.05 * RAD) ** 2;
}

function shortest(from, to) {
  return wrap(to - from);
}

function wrap(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
