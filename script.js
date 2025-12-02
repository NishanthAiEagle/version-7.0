/* ============================================================
   OVERLAY JEWELS — FULL UPDATED SCRIPT.JS
   Includes:
   ✔ Smoothing
   ✔ Necklace/Earring placement
   ✔ BodyPix Occlusion
   ✔ Snapshot
   ✔ Try-All (with STOP → gallery)
   ✔ Bigger Gallery View (CSS handles size)
   ============================================================ */

/* DOM Elements */
const videoElement   = document.getElementById('webcam');
const canvasElement  = document.getElementById('overlay');
const canvasCtx      = canvasElement.getContext('2d');

/* Active Images */
let earringImg = null;
let necklaceImg = null;
let earringSrc = '';
let necklaceSrc = '';

/* Landmark Smoothing */
let smoothedLandmarks = null;

/* Last snapshot */
let lastSnapshotDataURL = '';

/* Placement Tuning */
const NECK_SCALE_MULTIPLIER   = 1.15;
const NECK_Y_OFFSET_FACTOR    = 0.95;
const NECK_X_OFFSET_FACTOR    = 0.00;

/* Smoothing constants */
const POS_SMOOTH = 0.88;
const ANGLE_SMOOTH = 0.82;
const EAR_DIST_SMOOTH = 0.90;
const ANGLE_BUFFER_LEN = 5;

const smoothedState = {
  leftEar: null,
  rightEar: null,
  neckPoint: null,
  angle: 0,
  earDist: null
};

const angleBuffer = [];

/* BodyPix */
let bodyPixNet = null;
let lastPersonSegmentation = null;
let lastBodyPixRun = 0;
const BODYPIX_CONFIG = {
  architecture: "MobileNetV1",
  multiplier: 0.50,
  outputStride: 16,
  quantBytes: 2
};
const SEGMENTATION_CONFIG = {
  internalResolution: "low",
  segmentationThreshold: 0.7
};
const BODYPIX_THROTTLE_MS = 250;

/* TRY ALL */
let autoTryRunning = false;
let autoTryTimeout = null;
let autoTryIndex = 0;
let autoSnapshots = [];
const tryAllBtn = document.getElementById("tryall-btn");

/* FLASH */
const flashOverlay = document.getElementById("flash-overlay");

/* GALLERY */
const galleryModal  = document.getElementById("gallery-modal");
const galleryMain   = document.getElementById("gallery-main");
const galleryThumbs = document.getElementById("gallery-thumbs");
const galleryClose  = document.getElementById("gallery-close");

/* WATERMARK */
const watermarkImg = new Image();
watermarkImg.src = "logo_watermark.png";
watermarkImg.crossOrigin = "anonymous";

function ensureWatermarkLoaded() {
  return new Promise((resolve) => {
    if (watermarkImg.complete && watermarkImg.naturalWidth !== 0) resolve();
    else { watermarkImg.onload = () => resolve(); watermarkImg.onerror = () => resolve(); }
  });
}

/* Utility: Load PNG */
function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = src;
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
  });
}

async function changeEarring(src) {
  earringSrc = src;
  const img = await loadImage(src);
  if (img) earringImg = img;
}

async function changeNecklace(src) {
  necklaceSrc = src;
  const img = await loadImage(src);
  if (img) necklaceImg = img;
}

/* Category Selection */
function toggleCategory(category) {
  document.getElementById("subcategory-buttons").style.display = "flex";
  const subs = document.querySelectorAll("#subcategory-buttons button");
  subs.forEach(btn => {
    btn.style.display = btn.innerText.toLowerCase().includes(category)
      ? "inline-block"
      : "none";
  });

  document.getElementById("jewelry-options").style.display = "none";
  stopAutoTry();
}

function selectJewelryType(type) {
  window.currentType = type;
  document.getElementById("jewelry-options").style.display = "flex";

  earringImg = null;
  necklaceImg = null;

  const { start, end } = getRange(type);
  insertOptions(type, "jewelry-options", start, end);

  stopAutoTry();
}

function getRange(type) {
  let start = 1, end = 15;

  switch (type) {
    case "gold_earrings":     end = 16; break;
    case "gold_necklaces":    end = 19; break;
    case "diamond_earrings":  end = 9;  break;
    case "diamond_necklaces": end = 6;  break;
  }
  return { start, end };
}

function buildList(type) {
  const { start, end } = getRange(type);
  const list = [];
  for (let i = start; i <= end; i++)
    list.push(`${type}/${type}${i}.png`);
  return list;
}

function insertOptions(type, containerId, startIndex, endIndex) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  for (let i = startIndex; i <= endIndex; i++) {
    const src = `${type}/${type}${i}.png`;
    const btn = document.createElement("button");
    const img = document.createElement("img");

    img.src = src;

    btn.appendChild(img);
    btn.onclick = () => {
      if (type.includes("earrings")) changeEarring(src);
      else changeNecklace(src);
    };

    container.appendChild(btn);
  }
}

/* Mediapipe FaceMesh */
const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});

faceMesh.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6
});

/* Normalized -> Pixel */
function toPxX(nX) { return nX * canvasElement.width; }
function toPxY(nY) { return nY * canvasElement.height; }

/* BodyPix Loader */
async function ensureBodyPixLoaded() {
  if (bodyPixNet) return;
  bodyPixNet = await bodyPix.load(BODYPIX_CONFIG);
}

async function runBodyPixIfNeeded() {
  const now = performance.now();
  if (!bodyPixNet) return;
  if (now - lastBodyPixRun < BODYPIX_THROTTLE_MS) return;

  lastBodyPixRun = now;

  try {
    const seg = await bodyPixNet.segmentPerson(videoElement, SEGMENTATION_CONFIG);
    lastPersonSegmentation = {
      data: seg.data,
      width: seg.width,
      height: seg.height
    };
  } catch (e) {}
}

/* FaceMesh onResults */
faceMesh.onResults(async (results) => {

  /* Sync canvas size */
  if (videoElement.videoWidth && videoElement.videoHeight) {
    canvasElement.width  = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
  }

  /* Draw video frame */
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  try {
    canvasCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
  } catch {}

  if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) {
    smoothedLandmarks = null;
    drawWatermark(canvasCtx);
    return;
  }

  const landmarks = results.multiFaceLandmarks[0];

  /* Landmark smoothing */
  if (!smoothedLandmarks) smoothedLandmarks = landmarks;
  else {
    smoothedLandmarks = smoothedLandmarks.map((prev, i) => ({
      x: prev.x * 0.7 + landmarks[i].x * 0.3,
      y: prev.y * 0.7 + landmarks[i].y * 0.3,
      z: prev.z * 0.7 + landmarks[i].z * 0.3
    }));
  }

  /* Pixel coords */
  const leftEar  = { x: toPxX(smoothedLandmarks[132].x), y: toPxY(smoothedLandmarks[132].y) };
  const rightEar = { x: toPxX(smoothedLandmarks[361].x), y: toPxY(smoothedLandmarks[361].y) };
  const neck     = { x: toPxX(smoothedLandmarks[152].x), y: toPxY(smoothedLandmarks[152].y) };

  const earDist = Math.hypot(rightEar.x - leftEar.x, rightEar.y - leftEar.y);
  const angle   = Math.atan2(rightEar.y - leftEar.y, rightEar.x - leftEar.x);

  /* Smoothing distance */
  if (smoothedState.earDist == null) smoothedState.earDist = earDist;
  else smoothedState.earDist = smoothedState.earDist * EAR_DIST_SMOOTH + earDist * (1 - EAR_DIST_SMOOTH);

  /* Position smoothing */
  function lerp(a, b, t) { return a * t + b * (1 - t); }
  function lerpPt(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }; }

  if (!smoothedState.leftEar) {
    smoothedState.leftEar  = leftEar;
    smoothedState.rightEar = rightEar;
    smoothedState.neckPoint = neck;
    smoothedState.angle = angle;
  } else {
    smoothedState.leftEar  = lerpPt(smoothedState.leftEar,  leftEar,  POS_SMOOTH);
    smoothedState.rightEar = lerpPt(smoothedState.rightEar, rightEar, POS_SMOOTH);
    smoothedState.neckPoint= lerpPt(smoothedState.neckPoint, neck,    POS_SMOOTH);

    let prev = smoothedState.angle;
    let diff = angle - prev;
    if (diff > Math.PI) diff -= 2*Math.PI;
    if (diff < -Math.PI) diff += 2*Math.PI;
    smoothedState.angle = prev + diff * (1 - ANGLE_SMOOTH);
  }

  /* Median filter */
  angleBuffer.push(smoothedState.angle);
  if (angleBuffer.length > ANGLE_BUFFER_LEN) angleBuffer.shift();
  if (angleBuffer.length > 2) {
    const s = angleBuffer.slice().sort((a,b)=>a-b);
    smoothedState.angle = s[Math.floor(s.length/2)];
  }

  /* Draw jewelry */
  drawJewelry(smoothedState, canvasCtx);

  /* Run BodyPix */
  await ensureBodyPixLoaded();
  runBodyPixIfNeeded();

  /* Paint occlusion */
  if (lastPersonSegmentation && lastPersonSegmentation.data) {
    compositeHead(canvasCtx, smoothedLandmarks, lastPersonSegmentation);
  } else drawWatermark(canvasCtx);
});

/* Camera start */
const camera = new Camera(videoElement, {
  onFrame: async () => { await faceMesh.send({ image: videoElement }); },
  width: 1280,
  height: 720
});

camera.start();

/* Draw Jewelry */
function drawJewelry(state, ctx) {
  const { leftEar, rightEar, neckPoint, earDist, angle } = state;

  /* Earrings */
  if (earringImg) {
    const ew = earDist * 0.30;
    const eh = (earringImg.height / earringImg.width) * ew;

    ctx.drawImage(earringImg, leftEar.x - ew/2,  leftEar.y - eh/2,  ew, eh);
    ctx.drawImage(earringImg, rightEar.x - ew/2, rightEar.y - eh/2, ew, eh);
  }

  /* Necklace */
  if (necklaceImg) {
    const nw = earDist * NECK_SCALE_MULTIPLIER;
    const nh = (necklaceImg.height / necklaceImg.width) * nw;

    const yOffset = earDist * NECK_Y_OFFSET_FACTOR;

    ctx.save();
    ctx.translate(neckPoint.x, neckPoint.y + yOffset);
    ctx.rotate(angle);
    ctx.drawImage(necklaceImg, -nw/2, -nh/2, nw, nh);
    ctx.restore();
  }

  drawWatermark(ctx);
}

/* Watermark */
function drawWatermark(ctx) {
  try {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;

    const w = Math.round(cw * 0.22);
    const h = (watermarkImg.height / watermarkImg.width) * w;

    ctx.globalAlpha = 0.85;
    ctx.drawImage(watermarkImg, cw - w - 14, ch - h - 14, w, h);
    ctx.globalAlpha = 1;
  } catch {}
}

/* Occlusion */
function compositeHead(ctx, landmarks, seg) {
  try {
    const segData = seg.data;
    const segW = seg.width;
    const segH = seg.height;

    /* Head area from few points */
    const idx = [10, 151, 9, 197, 195, 4];
    let minX = 1, minY = 1, maxX = 0, maxY = 0;

    idx.forEach(i => {
      const x = landmarks[i].x, y = landmarks[i].y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    });

    const padX = 0.18 * (maxX - minX);
    const padY = 0.40 * (maxY - minY);

    const L = Math.max(0, (minX - padX) * canvasElement.width);
    const T = Math.max(0, (minY - padY) * canvasElement.height);
    const R = Math.min(canvasElement.width,  (maxX + padX) * canvasElement.width);
    const B = Math.min(canvasElement.height, (maxY + padY) * canvasElement.height);

    const W = R - L, H = B - T;
    if (W <= 0 || H <= 0) return;

    const off = document.createElement("canvas");
    off.width = canvasElement.width;
    off.height = canvasElement.height;
    const offCtx = off.getContext("2d");
    offCtx.drawImage(videoElement, 0, 0, off.width, off.height);

    const imgData = offCtx.getImageData(L, T, W, H);
    const dst = ctx.getImageData(L, T, W, H);

    const sx = segW / canvasElement.width;
    const sy = segH / canvasElement.height;

    for (let y = 0; y < H; y++) {
      const sy2 = Math.floor((T + y) * sy);
      if (sy2 < 0 || sy2 >= segH) continue;

      for (let x = 0; x < W; x++) {
        const sx2 = Math.floor((L + x) * sx);
        if (sx2 < 0 || sx2 >= segW) continue;

        const idx = sy2 * segW + sx2;
        if (segData[idx] === 1) {
          const i = (y * W + x) * 4;
          dst.data[i]   = imgData.data[i];
          dst.data[i+1] = imgData.data[i+1];
          dst.data[i+2] = imgData.data[i+2];
          dst.data[i+3] = imgData.data[i+3];
        }
      }
    }

    ctx.putImageData(dst, L, T);
    drawWatermark(ctx);
  } catch {}
}

/* Snapshots */
function triggerFlash() {
  flashOverlay.classList.add("active");
  setTimeout(() => flashOverlay.classList.remove("active"), 180);
}

async function takeSnapshot() {
  if (!smoothedLandmarks) {
    alert("Face not detected.");
    return;
  }

  await ensureWatermarkLoaded();
  triggerFlash();

  const snap = document.createElement("canvas");
  snap.width = canvasElement.width;
  snap.height = canvasElement.height;
  const ctx = snap.getContext("2d");

  ctx.drawImage(videoElement, 0, 0, snap.width, snap.height);
  drawJewelry(smoothedState, ctx);

  if (lastPersonSegmentation && lastPersonSegmentation.data) {
    compositeHead(ctx, smoothedLandmarks, lastPersonSegmentation);
  } else drawWatermark(ctx);

  lastSnapshotDataURL = snap.toDataURL("image/png");

  document.getElementById("snapshot-preview").src = lastSnapshotDataURL;
  document.getElementById("snapshot-modal").style.display = "block";
}

function saveSnapshot() {
  const a = document.createElement("a");
  a.href = lastSnapshotDataURL;
  a.download = `jewelry-${Date.now()}.png`;
  a.click();
}

async function shareSnapshot() {
  if (!navigator.share) { alert("Not supported"); return; }

  const blob = await (await fetch(lastSnapshotDataURL)).blob();
  const file = new File([blob], "jewelry.png", { type: "image/png" });

  await navigator.share({ files: [file] });
}

function closeSnapshotModal() {
  document.getElementById("snapshot-modal").style.display = "none";
}

/* TRY ALL FEATURE */

/* NEW STOP LOGIC */
function stopAutoTry() {
  autoTryRunning = false;
  if (autoTryTimeout) clearTimeout(autoTryTimeout);
  autoTryTimeout = null;

  tryAllBtn.classList.remove("active");
  tryAllBtn.textContent = "Try All";

  // ⭐ NEW FEATURE: If user stops early, show gallery
  if (autoSnapshots.length > 0) openGallery();
}

function toggleTryAll() {
  if (autoTryRunning) stopAutoTry();
  else startAutoTry();
}

async function startAutoTry() {
  if (!window.currentType) {
    alert("Choose a category first.");
    return;
  }

  const list = buildList(window.currentType);
  if (!list.length) return;

  autoSnapshots = [];
  autoTryIndex = 0;
  autoTryRunning = true;

  tryAllBtn.classList.add("active");
  tryAllBtn.textContent = "Stop";

  const next = async () => {
    if (!autoTryRunning) return;

    const src = list[autoTryIndex];

    if (window.currentType.includes("earrings"))
      await changeEarring(src);
    else
      await changeNecklace(src);

    await new Promise(res => setTimeout(res, 800));

    triggerFlash();

    if (smoothedLandmarks) {
      const snap = document.createElement("canvas");
      snap.width = canvasElement.width;
      snap.height = canvasElement.height;
      const ctx = snap.getContext("2d");

      ctx.drawImage(videoElement, 0, 0, snap.width, snap.height);
      drawJewelry(smoothedState, ctx);

      if (lastPersonSegmentation && lastPersonSegmentation.data)
        compositeHead(ctx, smoothedLandmarks, lastPersonSegmentation);
      else drawWatermark(ctx);

      autoSnapshots.push(snap.toDataURL("image/png"));
    }

    autoTryIndex++;
    if (autoTryIndex >= list.length) {
      stopAutoTry();
      return;
    }

    autoTryTimeout = setTimeout(next, 2000);
  };

  next();
}

/* Gallery */
function openGallery() {
  galleryThumbs.innerHTML = "";

  autoSnapshots.forEach((src, i) => {
    const img = document.createElement("img");
    img.src = src;
    img.onclick = () => setGallery(i);
    galleryThumbs.appendChild(img);
  });

  setGallery(0);
  galleryModal.style.display = "flex";
}

function setGallery(i) {
  galleryMain.src = autoSnapshots[i];
  const thumbs = galleryThumbs.querySelectorAll("img");
  thumbs.forEach((img, idx) => {
    img.classList.toggle("active", idx === i);
  });
}

galleryClose.addEventListener("click", () => {
  galleryModal.style.display = "none";
});

/* Downloads */
async function downloadAllImages() {
  if (!autoSnapshots.length) return;

  const zip = new JSZip();
  const folder = zip.folder("Your_Looks");

  for (let i = 0; i < autoSnapshots.length; i++) {
    const base64 = autoSnapshots[i].split(",")[1];
    folder.file(`look_${i + 1}.png`, base64, { base64: true });
  }

  const blob = await zip.generateAsync({ type: "blob" });
  saveAs(blob, "OverlayJewels_Looks.zip");
}

async function shareCurrentFromGallery() {
  if (!navigator.share) return;

  const blob = await (await fetch(galleryMain.src)).blob();
  const file = new File([blob], "look.png", { type: "image/png" });
  await navigator.share({ files: [file] });
}

/* Expose Functions */
window.toggleCategory = toggleCategory;
window.selectJewelryType = selectJewelryType;
window.takeSnapshot = takeSnapshot;
window.saveSnapshot = saveSnapshot;
window.shareSnapshot = shareSnapshot;
window.closeSnapshotModal = closeSnapshotModal;
window.toggleTryAll = toggleTryAll;
window.downloadAllImages = downloadAllImages;
window.shareCurrentFromGallery = shareCurrentFromGallery;
