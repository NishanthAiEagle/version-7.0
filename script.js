/* script.js — Auto face-shape adjustment for accurate earring placement */

const videoElement   = document.getElementById('webcam');
const canvasElement  = document.getElementById('overlay');
const canvasCtx      = canvasElement.getContext('2d');

const tryAllBtn      = document.getElementById('tryall-btn');
const flashOverlay   = document.getElementById('flash-overlay');
const galleryModal   = document.getElementById('gallery-modal');
const galleryMain    = document.getElementById('gallery-main');
const galleryThumbs  = document.getElementById('gallery-thumbs');
const galleryClose   = document.getElementById('gallery-close');

const earSizeRange   = document.getElementById('earSizeRange');
const earSizeVal     = document.getElementById('earSizeVal');
const neckYRange     = document.getElementById('neckYRange');
const neckYVal       = document.getElementById('neckYVal');
const neckScaleRange = document.getElementById('neckScaleRange');
const neckScaleVal   = document.getElementById('neckScaleVal');
const posSmoothRange = document.getElementById('posSmoothRange');
const posSmoothVal   = document.getElementById('posSmoothVal');
const earSmoothRange = document.getElementById('earSmoothRange');
const earSmoothVal   = document.getElementById('earSmoothVal');
const debugToggle    = document.getElementById('debugToggle');

let earringImg = null, necklaceImg = null;
let currentType = '';
let smoothedLandmarks = null;
let lastPersonSegmentation = null;
let bodyPixNet = null;
let lastBodyPixRun = 0;
let lastSnapshotDataURL = '';

/* Tunables */
let EAR_SIZE_FACTOR = parseFloat(earSizeRange.value);
let NECK_Y_OFFSET_FACTOR = parseFloat(neckYRange.value);
let NECK_SCALE_MULTIPLIER = parseFloat(neckScaleRange.value);
let POS_SMOOTH = parseFloat(posSmoothRange.value);
let EAR_DIST_SMOOTH = parseFloat(earSmoothRange.value);

/* smoothing state */
const smoothedState = { leftEar: null, rightEar: null, neckPoint: null, angle: 0, earDist: null, faceShape: 'unknown' };
const angleBuffer = [];
const ANGLE_BUFFER_LEN = 5;

/* BodyPix params */
let bodyPixNetLoaded = false;

/* watermark */
const watermarkImg = new Image(); watermarkImg.src = "logo_watermark.png"; watermarkImg.crossOrigin = "anonymous";

/* helper functions */
function loadImage(src) { return new Promise(res => { const i = new Image(); i.crossOrigin='anonymous'; i.src = src; i.onload = ()=>res(i); i.onerror = ()=>res(null); }); }
function toPxX(normX){ return normX * canvasElement.width; }
function toPxY(normY){ return normY * canvasElement.height; }
function lerp(a,b,t){ return a*t + b*(1-t); }
function lerpPt(a,b,t){ return { x: lerp(a.x,b.x,t), y: lerp(a.y,b.y,t) }; }

/* BodyPix loader */
async function ensureBodyPixLoaded() {
  if (bodyPixNetLoaded) return;
  try {
    bodyPixNet = await bodyPix.load({ architecture:'MobileNetV1', outputStride:16, multiplier:0.5, quantBytes:2 });
    bodyPixNetLoaded = true;
  } catch(e) { console.warn('BodyPix load failed', e); bodyPixNetLoaded = false; }
}
async function runBodyPixIfNeeded(){
  const throttle = 300;
  const now = performance.now();
  if (!bodyPixNetLoaded) return;
  if (now - lastBodyPixRun < throttle) return;
  lastBodyPixRun = now;
  try {
    const seg = await bodyPixNet.segmentPerson(videoElement, { internalResolution:'low', segmentationThreshold:0.7 });
    lastPersonSegmentation = { data: seg.data, width: seg.width, height: seg.height };
  } catch(e) { console.warn('seg err', e); }
}

/* FaceMesh */
const faceMesh = new FaceMesh({ locateFile: (f)=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });

faceMesh.onResults(async (results) => {
  if (videoElement.videoWidth && videoElement.videoHeight) {
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
  }

  canvasCtx.clearRect(0,0,canvasElement.width,canvasElement.height);
  try { canvasCtx.drawImage(videoElement,0,0,canvasElement.width,canvasElement.height); } catch(e){}

  if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) {
    smoothedLandmarks = null; drawWatermark(canvasCtx); return;
  }

  const landmarks = results.multiFaceLandmarks[0];

  if (!smoothedLandmarks) smoothedLandmarks = landmarks;
  else {
    smoothedLandmarks = smoothedLandmarks.map((prev,i) => ({
      x: prev.x * 0.72 + landmarks[i].x * 0.28,
      y: prev.y * 0.72 + landmarks[i].y * 0.28,
      z: prev.z * 0.72 + landmarks[i].z * 0.28
    }));
  }

  // compute pixel points for ears & neck
  const leftEar  = { x: toPxX(smoothedLandmarks[132].x), y: toPxY(smoothedLandmarks[132].y) };
  const rightEar = { x: toPxX(smoothedLandmarks[361].x), y: toPxY(smoothedLandmarks[361].y) };
  const neckP    = { x: toPxX(smoothedLandmarks[152].x), y: toPxY(smoothedLandmarks[152].y) };

  // bounding box for face shape detection (use many landmarks)
  let minX=1, minY=1, maxX=0, maxY=0;
  for (let i=0;i<smoothedLandmarks.length;i++){
    const lm = smoothedLandmarks[i];
    if (lm.x < minX) minX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y > maxY) maxY = lm.y;
  }
  const faceWidth = (maxX - minX) * canvasElement.width;
  const faceHeight = (maxY - minY) * canvasElement.height;
  const aspect = faceHeight / (faceWidth || 1);

  // classify shape
  let faceShape = 'oval';
  if (aspect < 1.05) faceShape = 'round';
  else if (aspect > 1.25) faceShape = 'long';
  else faceShape = 'oval';
  smoothedState.faceShape = faceShape;

  // earDist & smoothing
  const rawEarDist = Math.hypot(rightEar.x - leftEar.x, rightEar.y - leftEar.y);
  if (smoothedState.earDist == null) smoothedState.earDist = rawEarDist;
  else smoothedState.earDist = smoothedState.earDist * EAR_DIST_SMOOTH + rawEarDist * (1 - EAR_DIST_SMOOTH);

  // smooth positions
  if (!smoothedState.leftEar) {
    smoothedState.leftEar = leftEar; smoothedState.rightEar = rightEar; smoothedState.neckPoint = neckP;
    smoothedState.angle = Math.atan2(rightEar.y - leftEar.y, rightEar.x - leftEar.x);
  } else {
    smoothedState.leftEar = lerpPt(smoothedState.leftEar, leftEar, POS_SMOOTH);
    smoothedState.rightEar = lerpPt(smoothedState.rightEar, rightEar, POS_SMOOTH);
    smoothedState.neckPoint = lerpPt(smoothedState.neckPoint, neckP, POS_SMOOTH);

    const rawAngle = Math.atan2(rightEar.y - leftEar.y, rightEar.x - leftEar.x);
    let prev = smoothedState.angle;
    let diff = rawAngle - prev;
    if (diff > Math.PI) diff -= 2*Math.PI;
    if (diff < -Math.PI) diff += 2*Math.PI;
    smoothedState.angle = prev + diff * (1 - 0.82);
  }

  // angle median buffer
  angleBuffer.push(smoothedState.angle);
  if (angleBuffer.length > ANGLE_BUFFER_LEN) angleBuffer.shift();
  if (angleBuffer.length > 2) {
    const s = angleBuffer.slice().sort((a,b)=>a-b);
    smoothedState.angle = s[Math.floor(s.length/2)];
  }

  // draw jewelry with face-shape-aware placement
  drawJewelrySmart(smoothedState, canvasCtx, smoothedLandmarks, { faceWidth, faceHeight, faceShape });

  // segmentation (occlusion)
  await ensureBodyPixLoaded();
  runBodyPixIfNeeded();

  if (lastPersonSegmentation && lastPersonSegmentation.data) compositeHeadOcclusion(canvasCtx, smoothedLandmarks, lastPersonSegmentation);
  else drawWatermark(canvasCtx);

  // debug overlay
  if (debugToggle.classList.contains('on')) drawDebugMarkers();
});

/* Camera */
const camera = new Camera(videoElement, { onFrame: async ()=>{ await faceMesh.send({ image: videoElement }); }, width:1280, height:720 });
camera.start();

/* Smart draw: adjusts based on face shape */
function drawJewelrySmart(state, ctx, landmarks, meta){
  const leftEar = state.leftEar, rightEar = state.rightEar, neckPoint = state.neckPoint;
  const earDist = state.earDist || Math.hypot(rightEar.x - leftEar.x, rightEar.y - leftEar.y);
  const angle = state.angle || 0;
  const faceShape = meta.faceShape;
  const faceW = meta.faceWidth, faceH = meta.faceHeight;

  // shape-based adjustments (px)
  let xAdj = 0, yAdj = 0, sizeMult = 1.0;
  if (faceShape === 'round') {
    xAdj = Math.round(faceW * 0.035);    // push slightly outward
    yAdj = Math.round(faceH * 0.025);    // hang slightly lower
    sizeMult = 1.08;                      // slightly larger
  } else if (faceShape === 'oval') {
    xAdj = Math.round(faceW * 0.02);
    yAdj = Math.round(faceH * 0.01);
    sizeMult = 1.00;
  } else { // long
    xAdj = Math.round(faceW * 0.01);     // minor outward
    yAdj = Math.round(faceH * -0.01);    // pull up a bit
    sizeMult = 0.96;                      // slightly smaller
  }

  // final earring size uses slider (EAR_SIZE_FACTOR) * shape multiplier
  const finalEarringFactor = EAR_SIZE_FACTOR * sizeMult;

  // EARRINGS
  if (earringImg && landmarks) {
    const eWidth = earDist * finalEarringFactor;
    const eHeight = (earringImg.height / earringImg.width) * eWidth;
    const leftX = leftEar.x - eWidth/2 - xAdj;
    const rightX = rightEar.x - eWidth/2 + xAdj;
    const leftY = leftEar.y + (eHeight * 0.12) + yAdj;
    const rightY = rightEar.y + (eHeight * 0.12) + yAdj;

    // keep earrings upright (small counter-rotation)
    const tiltCorrection = - (angle * 0.08);

    ctx.save();
    ctx.translate(leftX + eWidth/2, leftY + eHeight/2);
    ctx.rotate(tiltCorrection);
    ctx.drawImage(earringImg, -eWidth/2, -eHeight/2, eWidth, eHeight);
    ctx.restore();

    ctx.save();
    ctx.translate(rightX + eWidth/2, rightY + eHeight/2);
    ctx.rotate(-tiltCorrection);
    ctx.drawImage(earringImg, -eWidth/2, -eHeight/2, eWidth, eHeight);
    ctx.restore();
  }

  // NECKLACE (unchanged main formula, but uses neck tunables)
  if (necklaceImg && landmarks) {
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

/* watermark */
function drawWatermark(ctx){
  try {
    if (!watermarkImg || !watermarkImg.naturalWidth) return;
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const wmW = Math.round(cw * 0.22);
    const wmH = Math.round((watermarkImg.height / watermarkImg.width) * wmW);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(watermarkImg, cw - wmW - 14, ch - wmH - 14, wmW, wmH);
    ctx.globalAlpha = 1.0;
  } catch(e){}
}

/* composite occlusion */
function compositeHeadOcclusion(mainCtx, landmarks, seg){
  try {
    const segData = seg.data, segW = seg.width, segH = seg.height;
    const indices = [10,151,9,197,195,4];
    let minX=1,minY=1,maxX=0,maxY=0;
    indices.forEach(i => { const x=landmarks[i].x, y=landmarks[i].y; if (x<minX) minX=x; if(y<minY) minY=y; if(x>maxX) maxX=x; if(y>maxY) maxY=y; });
    const padX = 0.18*(maxX-minX), padY = 0.40*(maxY-minY);
    const left = Math.max(0, (minX - padX) * canvasElement.width);
    const top  = Math.max(0, (minY - padY) * canvasElement.height);
    const right = Math.min(canvasElement.width, (maxX + padX) * canvasElement.width);
    const bottom= Math.min(canvasElement.height,(maxY + padY) * canvasElement.height);
    const w = Math.max(0, right-left), h = Math.max(0, bottom-top);
    if (w<=0 || h<=0) { drawWatermark(mainCtx); return; }
    const off = document.createElement('canvas'); off.width = canvasElement.width; off.height = canvasElement.height;
    const offCtx = off.getContext('2d'); offCtx.drawImage(videoElement,0,0,off.width,off.height);
    const imgData = offCtx.getImageData(left, top, w, h);
    const dst = mainCtx.getImageData(left, top, w, h);
    const sx = segW / canvasElement.width, sy = segH / canvasElement.height;
    for (let y=0;y<h;y++){
      const segY = Math.floor((top+y)*sy); if (segY<0||segY>=segH) continue;
      for (let x=0;x<w;x++){
        const segX = Math.floor((left+x)*sx); if (segX<0||segX>=segW) continue;
        const idx = segY*segW + segX;
        if (segData[idx] === 1) {
          const i = (y*w + x)*4;
          dst.data[i]=imgData.data[i]; dst.data[i+1]=imgData.data[i+1]; dst.data[i+2]=imgData.data[i+2]; dst.data[i+3]=imgData.data[i+3];
        }
      }
    }
    mainCtx.putImageData(dst, left, top);
    drawWatermark(mainCtx);
  } catch(e) { drawWatermark(mainCtx); }
}

/* Snapshots, tryAll & gallery — keep existing logic (omitted for brevity here) */
/* For full features, reuse the same functions you had (takeSnapshot, startAutoTry, stopAutoTry, openGallery, etc.). */
/* --- I'll include them below as-is so the project remains complete --- */

/* (BEGIN existing snapshot / tryAll / gallery functions) */
function triggerFlash(){ flashOverlay.classList.add('active'); setTimeout(()=>flashOverlay.classList.remove('active'), 180); }

async function takeSnapshot(){
  if (!smoothedLandmarks) { alert('Face not detected'); return; }
  await ensureWatermarkLoaded();
  triggerFlash();
  const snap = document.createElement('canvas'); snap.width = canvasElement.width; snap.height = canvasElement.height;
  const ctx = snap.getContext('2d'); ctx.drawImage(videoElement,0,0,snap.width,snap.height);
  // draw current jewelry into snapshot using same placement rules
  drawJewelrySmart(smoothedState, ctx, smoothedLandmarks, { faceWidth: (0.5*canvasElement.width), faceHeight:(0.7*canvasElement.height), faceShape: smoothedState.faceShape });
  if (lastPersonSegmentation && lastPersonSegmentation.data) compositeHeadOcclusion(ctx, smoothedLandmarks, lastPersonSegmentation);
  else drawWatermark(ctx);
  lastSnapshotDataURL = snap.toDataURL('image/png');
  document.getElementById('snapshot-preview').src = lastSnapshotDataURL;
  document.getElementById('snapshot-modal').style.display = 'block';
}

function saveSnapshot(){ const a=document.createElement('a'); a.href = lastSnapshotDataURL; a.download = `jewelry-${Date.now()}.png`; a.click(); }
async function shareSnapshot(){ if (!navigator.share) { alert('Sharing not supported'); return; } const blob = await (await fetch(lastSnapshotDataURL)).blob(); const file = new File([blob], 'look.png', { type: 'image/png' }); await navigator.share({ files: [file] }); }
function closeSnapshotModal(){ document.getElementById('snapshot-modal').style.display = 'none'; }

// ===== try-all & gallery logic (reused from your prior file) =====
let autoTryRunning = false, autoTryTimeout = null, autoTryIndex = 0, autoSnapshots = [];
function stopAutoTry(){ autoTryRunning=false; if (autoTryTimeout) clearTimeout(autoTryTimeout); autoTryTimeout=null; tryAllBtn.classList.remove('active'); tryAllBtn.textContent='Try All'; if (autoSnapshots.length>0) openGallery(); }
function toggleTryAll(){ if (autoTryRunning) stopAutoTry(); else startAutoTry(); }

async function startAutoTry(){
  if (!currentType) { alert('Choose a category first'); return; }
  const list = buildImageList(currentType); if (!list.length) { alert('No items'); return; }
  autoSnapshots=[]; autoTryIndex=0; autoTryRunning=true; tryAllBtn.classList.add('active'); tryAllBtn.textContent='Stop';
  const step = async ()=>{
    if (!autoTryRunning) return;
    const src = list[autoTryIndex];
    if (currentType.includes('earrings')) await changeEarring(src); else await changeNecklace(src);
    await new Promise(r=>setTimeout(r,800));
    triggerFlash();
    if (smoothedLandmarks) {
      const snap = document.createElement('canvas'); snap.width=canvasElement.width; snap.height=canvasElement.height;
      const ctx = snap.getContext('2d'); try{ ctx.drawImage(videoElement,0,0,snap.width,snap.height); }catch(e){}
      drawJewelrySmart(smoothedState, ctx, smoothedLandmarks, { faceWidth: (0.5*canvasElement.width), faceHeight:(0.7*canvasElement.height), faceShape: smoothedState.faceShape });
      if (lastPersonSegmentation && lastPersonSegmentation.data) compositeHeadOcclusion(ctx, smoothedLandmarks, lastPersonSegmentation);
      else drawWatermark(ctx);
      autoSnapshots.push(snap.toDataURL('image/png'));
    }
    autoTryIndex++; if (autoTryIndex>=list.length){ stopAutoTry(); return; }
    autoTryTimeout = setTimeout(step, 2000);
  };
  step();
}

function openGallery(){ galleryThumbs.innerHTML=''; autoSnapshots.forEach((src,i)=>{ const img=document.createElement('img'); img.src=src; img.onclick=()=> setGalleryMain(i); galleryThumbs.appendChild(img); }); if (autoSnapshots.length) setGalleryMain(0); galleryModal.style.display='flex'; }
function setGalleryMain(i){ galleryMain.src = autoSnapshots[i]; const thumbs = galleryThumbs.querySelectorAll('img'); thumbs.forEach((t,idx)=> t.classList.toggle('active', idx===i)); }
document.getElementById('gallery-close').addEventListener('click', ()=> galleryModal.style.display='none');
async function downloadAllImages(){ if (!autoSnapshots.length) return; const zip = new JSZip(), f = zip.folder('Looks'); for (let i=0;i<autoSnapshots.length;i++){ const b = autoSnapshots[i].split(',')[1]; f.file(`look_${i+1}.png`, b, { base64:true }); } const blob = await zip.generateAsync({ type:'blob' }); saveAs(blob, 'Looks.zip'); }
async function shareCurrentFromGallery(){ if (!navigator.share) { alert('Share not supported'); return; } const blob = await (await fetch(galleryMain.src)).blob(); const file = new File([blob],'look.png',{type:'image/png'}); await navigator.share({ files:[file] }); }

// ===== assets UI helpers =====
function toggleCategory(category){ document.getElementById('subcategory-buttons').style.display='flex'; const subs = document.querySelectorAll('#subcategory-buttons button'); subs.forEach(b => b.style.display = b.innerText.toLowerCase().includes(category) ? 'inline-block' : 'none'); document.getElementById('jewelry-options').style.display='none'; stopAutoTry(); }
function selectJewelryType(type){ currentType = type; document.getElementById('jewelry-options').style.display='flex'; earringImg=null; necklaceImg=null; const { start, end } = getRangeForType(type); insertJewelryOptions(type,'jewelry-options', start, end); stopAutoTry(); }
function getRangeForType(type){ let start=1,end=15; if (type==='gold_earrings') end=16; if (type==='gold_necklaces') end=19; if (type==='diamond_earrings') end=9; if (type==='diamond_necklaces') end=6; return {start,end}; }
function buildImageList(type){ const {start,end} = getRangeForType(type); const list=[]; for (let i=start;i<=end;i++) list.push(`${type}/${type}${i}.png`); return list; }
function insertJewelryOptions(type, containerId, startIndex, endIndex){ const container = document.getElementById(containerId); container.innerHTML=''; for (let i=startIndex;i<=endIndex;i++){ const src = `${type}/${type}${i}.png`; const btn = document.createElement('button'); const img = document.createElement('img'); img.src=src; btn.appendChild(img); btn.onclick = () => { if (type.includes('earrings')) changeEarring(src); else changeNecklace(src); }; container.appendChild(btn); } }
async function changeEarring(src){ earringImg = await loadImage(src); }
async function changeNecklace(src){ necklaceImg = await loadImage(src); }
function ensureWatermarkLoaded(){ return new Promise(res => { if (watermarkImg.complete && watermarkImg.naturalWidth) res(); else { watermarkImg.onload = ()=>res(); watermarkImg.onerror = ()=>res(); } }); }
function toggleInfoModal(){ const m = document.getElementById('info-modal'); m.style.display = m.style.display === 'block' ? 'none' : 'block'; }

/* debug markers */
function drawDebugMarkers(){
  if (!smoothedState.leftEar) return;
  const ctx = canvasCtx;
  ctx.save();
  ctx.fillStyle='cyan'; ctx.beginPath(); ctx.arc(smoothedState.leftEar.x, smoothedState.leftEar.y,6,0,Math.PI*2); ctx.fill(); ctx.fillText('L', smoothedState.leftEar.x+8, smoothedState.leftEar.y);
  ctx.fillStyle='magenta'; ctx.beginPath(); ctx.arc(smoothedState.rightEar.x, smoothedState.rightEar.y,6,0,Math.PI*2); ctx.fill(); ctx.fillText('R', smoothedState.rightEar.x+8, smoothedState.rightEar.y);
  ctx.fillStyle='yellow'; ctx.beginPath(); ctx.arc(smoothedState.neckPoint.x, smoothedState.neckPoint.y,6,0,Math.PI*2); ctx.fill(); ctx.fillText('N', smoothedState.neckPoint.x+8, smoothedState.neckPoint.y);
  ctx.restore();
}

/* slider bindings */
earSizeRange.addEventListener('input', ()=>{ EAR_SIZE_FACTOR = parseFloat(earSizeRange.value); earSizeVal.textContent = EAR_SIZE_FACTOR.toFixed(2); });
neckYRange.addEventListener('input', ()=>{ NECK_Y_OFFSET_FACTOR = parseFloat(neckYRange.value); neckYVal.textContent = NECK_Y_OFFSET_FACTOR.toFixed(2); });
neckScaleRange.addEventListener('input', ()=>{ NECK_SCALE_MULTIPLIER = parseFloat(neckScaleRange.value); neckScaleVal.textContent = NECK_SCALE_MULTIPLIER.toFixed(2); });
posSmoothRange.addEventListener('input', ()=>{ POS_SMOOTH = parseFloat(posSmoothRange.value); posSmoothVal.textContent = POS_SMOOTH.toFixed(2); });
earSmoothRange.addEventListener('input', ()=>{ EAR_DIST_SMOOTH = parseFloat(earSmoothRange.value); earSmoothVal.textContent = EAR_DIST_SMOOTH.toFixed(2); });

debugToggle.addEventListener('click', ()=> debugToggle.classList.toggle('on') );

/* init */
ensureBodyPixLoaded();

/* expose for HTML */
window.toggleCategory = toggleCategory;
window.selectJewelryType = selectJewelryType;
window.takeSnapshot = takeSnapshot;
window.saveSnapshot = saveSnapshot;
window.shareSnapshot = shareSnapshot;
window.closeSnapshotModal = closeSnapshotModal;
window.toggleTryAll = toggleTryAll;
window.downloadAllImages = downloadAllImages;
window.shareCurrentFromGallery = shareCurrentFromGallery;
window.toggleInfoModal = toggleInfoModal;
