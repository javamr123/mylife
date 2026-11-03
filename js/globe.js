import { land } from "./land.js";

const RAD = Math.PI / 180;

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
  const reduced = Boolean(options.reducedMotion);
  const mode = options.mode === "pick" ? "pick" : "browse";
  let markers = options.markers || [];
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
  let anim = null;
  let frontKey = null;
  let drawn = [];
  const context = canvas.getContext("2d");

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  };

  const remember = () => {
    options.onView?.({ spin, tilt, held });
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
        remember();
        done?.();
      }
      return;
    }
    if (dragging) return;
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
    if (mode === "browse" && !held && !reduced) spin -= 0.7 * dt;
  };

  const draw = () => {
    if (!width || !height) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    radius = Math.min(width, height) * 0.4;
    cx = width / 2;
    cy = height * 0.46;

    context.fillStyle = "rgba(0, 0, 0, 0.45)";
    context.beginPath();
    context.ellipse(cx, cy + radius * 1.02, radius * 0.78, radius * 0.09, 0, 0, Math.PI * 2);
    context.fill();

    const ocean = context.createRadialGradient(cx - radius * 0.32, cy - radius * 0.36, radius * 0.05, cx, cy, radius);
    ocean.addColorStop(0, "#f7f3ea");
    ocean.addColorStop(0.55, "#e6d8c4");
    ocean.addColorStop(1, "#b89a74");
    context.fillStyle = ocean;
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fill();

    context.save();
    context.beginPath();
    context.arc(cx, cy, radius - 0.5, 0, Math.PI * 2);
    context.clip();
    drawGraticule();
    drawLand();
    drawRoute();
    context.restore();

    context.strokeStyle = "rgba(198, 165, 106, 0.72)";
    context.lineWidth = 1.25;
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.stroke();

    context.strokeStyle = "rgba(255, 250, 240, 0.7)";
    context.lineWidth = 1.5;
    context.beginPath();
    context.ellipse(cx - radius * 0.22, cy - radius * 0.34, radius * 0.22, radius * 0.11, -0.7, Math.PI * 0.1, Math.PI * 0.9);
    context.stroke();

    drawn = [];
    for (const marker of markers) drawn.push(placeMarker(marker, false));
    if (pin) drawn.push(placeMarker({ ...pin, id: pin.id || "" }, true));
    for (const marker of drawn.filter((item) => item.visible)) drawSeal(marker);
    updateFront();
  };

  const drawGraticule = () => {
    context.strokeStyle = "rgba(120, 88, 48, 0.2)";
    context.lineWidth = 1;
    context.beginPath();
    for (let lat = -60; lat <= 60; lat += 30) strokeLine(sampleLat(lat));
    for (let lng = -180; lng < 180; lng += 30) strokeLine(sampleLng(lng));
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
      context.moveTo(cx + poly[0].x * radius, cy - poly[0].y * radius);
      for (let vertex = 1; vertex < poly.length; vertex += 1) {
        context.lineTo(cx + poly[vertex].x * radius, cy - poly[vertex].y * radius);
      }
      context.closePath();
    }
    context.fill();
  };

  const drawRoute = () => {
    if (markers.length < 2) return;
    context.strokeStyle = "rgba(176, 58, 48, 0.9)";
    context.lineWidth = 1.35;
    context.lineCap = "round";
    context.beginPath();
    for (let i = 1; i < markers.length; i += 1) {
      strokeLine(sampleGreatCircle(markers[i - 1], markers[i]));
    }
    context.stroke();
  };

  const sampleLat = (lat) => {
    const points = [];
    for (let lng = -180; lng <= 180; lng += 4) points.push(project(lat, lng, spin, tilt));
    return points;
  };

  const sampleLng = (lng) => {
    const points = [];
    for (let lat = -80; lat <= 80; lat += 4) points.push(project(lat, lng, spin, tilt));
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

  const screen = (point) => [cx + point.x * radius, cy - point.y * radius];

  const placeMarker = (marker, active) => {
    const point = project(marker.lat, marker.lng, spin, tilt);
    const [sx, sy] = screen(point);
    return { ...marker, sx, sy, z: point.z, visible: point.z > 0.04, active };
  };

  const drawSeal = (marker) => {
    const size = marker.active ? 8 : 6.5;
    context.save();
    context.translate(marker.sx, marker.sy);
    context.fillStyle = "#f4efe6";
    context.fillRect(-size / 2 - 1.6, -size / 2 - 1.6, size + 3.2, size + 3.2);
    context.fillStyle = "#9c2b2b";
    context.fillRect(-size / 2, -size / 2, size, size);
    context.restore();
  };

  const updateFront = () => {
    if (mode !== "browse") return;
    let best = null;
    let bestDistance = Infinity;
    for (const marker of drawn) {
      if (!marker.id || marker.z < 0.25) continue;
      const distance = Math.hypot(marker.sx - cx, marker.sy - cy);
      if (distance < radius * 0.5 && distance < bestDistance) {
        best = marker;
        bestDistance = distance;
      }
    }
    const key = best?.id || "";
    if (key === frontKey) return;
    frontKey = key;
    options.onFront?.(best);
  };

  const hitMarker = (px, py) => {
    let best = null;
    let bestDistance = 18;
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

  const localPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onDown = (event) => {
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
    try { canvas.setPointerCapture(event.pointerId); } catch { /* 某些浏览器在测试里没有真实指针。 */ }
  };

  const onMove = (event) => {
    const point = localPoint(event);
    if (!dragging || event.pointerId !== pointerId) {
      canvas.style.cursor = hitMarker(point.x, point.y) ? "pointer" : "grab";
      return;
    }
    event.preventDefault();
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    const deg = (180 / Math.PI) / Math.max(radius, 1);
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
    const point = localPoint(event);
    const marker = hitMarker(point.x, point.y);
    if (marker && options.onSelect) {
      face(marker.lat, marker.lng, true, () => options.onSelect(marker.id));
      return;
    }
    if (mode === "pick") {
      const nx = (point.x - cx) / radius;
      const ny = (cy - point.y) / radius;
      if (nx * nx + ny * ny <= 1) {
        const spot = unproject(nx, ny, spin, tilt);
        pin = { lat: spot.lat, lng: spot.lng };
        options.onPick?.(spot);
      }
    }
    remember();
  };

  const onKey = (event) => {
    const step = event.shiftKey ? 18 : 8;
    let used = true;
    if (event.key === "ArrowLeft") spin -= step;
    else if (event.key === "ArrowRight") spin += step;
    else if (event.key === "ArrowUp") tilt = clamp(tilt - step, -55, 55);
    else if (event.key === "ArrowDown") tilt = clamp(tilt + step, -55, 55);
    else used = false;
    if (!used) return;
    event.preventDefault();
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

  const onUp = (event) => finish(event, true);
  const onCancel = (event) => finish(event, false);
  canvas.tabIndex = 0;
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("keydown", onKey);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  resize();
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("keydown", onKey);
    },
    setPin(next) {
      pin = next;
    },
    focus(lat, lng) {
      pin = { lat, lng };
      face(lat, lng, true);
    },
    setMarkers(next) {
      markers = next || [];
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

function shortest(from, to) {
  return wrap(to - from);
}

function wrap(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
