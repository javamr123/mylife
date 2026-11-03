export async function compressImage(file) {
  if (!file || !file.type?.startsWith("image/")) {
    throw new Error(`${file?.name || "文件"} 不是图片。`);
  }
  if (file.size > 25 * 1024 * 1024) {
    throw new Error(`${file.name} 超过 25MB，请先缩小再选。`);
  }
  if (file.type === "image/gif") {
    if (file.size > 1_500_000) throw new Error(`${file.name} 这张 GIF 太大了。`);
    return file;
  }

  let blob = await rasterize(file, 1920, 0.82);
  if (blob.size > 900_000) blob = await rasterize(file, 1600, 0.72);
  return blob;
}

async function rasterize(file, maxEdge, quality) {
  const source = await decodeImage(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error(`${file.name} 压缩失败。`);
    return blob;
  } finally {
    source.close?.();
  }
}

async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        return decodeViaElement(file);
      }
    }
  }
  return decodeViaElement(file);
}

function decodeViaElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name} 无法读取，请换成 JPG 或 PNG。`));
    };
    image.src = url;
  });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("照片编码失败。"));
    reader.readAsDataURL(blob);
  });
}

export function nextPhotoName(images, removedPaths, type) {
  const ext = type === "image/gif" ? "gif" : "jpg";
  const used = new Set(images.map((image) => image.name));
  for (const path of removedPaths || []) {
    const base = String(path).split("/").pop();
    if (base) used.add(base);
  }
  let number = 1;
  let name = "";
  do {
    name = `photo-${String(number).padStart(2, "0")}.${ext}`;
    number += 1;
  } while (used.has(name));
  return name;
}
