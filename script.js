/* script.js - Aurum Atelier: Any Filename Support + All Features */

/* CONFIGURATION: 
   List your exact filenames here for each category.
   You can use any name (e.g., "design1.png", "ruby_set.jpg").
*/
const JEWELRY_CONFIG = {
  gold_earrings: [
    "1.png", "2.png", "Fsn_ge0121.png", "4.png", "5.png"
    // Add more here: "my_custom_design.png",
  ],
  gold_necklaces: [
    "1.png", "2.png", "3.png", "4.png", "5.png"
  ],
  diamond_earrings: [
    "1.png", "2.png", "3.png", "4.png", "5.png"
  ],
  diamond_necklaces: [
    "1.png", "2.png", "3.png", "4.png", "5.png", "6.png"
  ]
};

/* --- 1. PRELOAD WATERMARK --- */
const watermarkImg = new Image();
watermarkImg.src = 'logo_watermark.png'; 

/* DOM Elements */
const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('overlay');
const canvasCtx = canvasElement.getContext('2d');
const loadingStatus = document.getElementById('loading-status');

/* --- HIDE GESTURE INDICATOR --- */
const gestureIndicator = document.getElementById('gesture-indicator');
if (gestureIndicator) {
    gestureIndicator.style.display = 'none';
}
const indicatorDot = document.getElementById('indicator-dot');
const indicatorText = document.getElementById('indicator-text');

/* App State */
let earringImg = null, necklaceImg = null, currentType = '';
let isProcessingHand = false;
let isProcessingFace = false;

/* --- Gesture State --- */
let lastGestureTime = 0;
const GESTURE_COOLDOWN = 800; 
let previousHandX = null;     

/* --- Try All / Gallery State --- */
let autoTryRunning = false;
let autoSnapshots = [];
let autoTryIndex = 0;
let autoTryTimeout = null;
let currentPreviewData = { url: null, name: 'aurum_look.png' }; 

/* --- Asset Preloading Cache --- */
const preloadedAssets = {};

// Updated to use the Filename List
async function preloadCategory(type) {
  if (preloadedAssets[type]) return; 
  preloadedAssets[type] = [];
  
  const files = JEWELRY_CONFIG[type];
  if (!files) return;

  files.forEach(filename => {
    // Construct path: folder/filename
    const src = `${type}/${filename}`;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    preloadedAssets[type].push(img);
  });
}

/* --- UI Indicator Helpers --- */
function updateHandIndicator(detected) {
  if (!detected) previousHandX = null; 
}

function flashIndicator(color) {
    if(indicatorDot && indicatorDot.style.display !== 'none') {
        indicatorDot.style.background = color;
        setTimeout(() => { indicatorDot.style.background = "#00ff88"; }, 300);
    }
}

/* ---------- HAND DETECTION (SWIPE LOGIC) ---------- */
const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 0, 
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5
});

hands.onResults((results) => {
  isProcessingHand = false; 
  const hasHand = results.multiHandLandmarks && results.multiHandLandmarks.length > 0;
  updateHandIndicator(hasHand);

  if (!hasHand || autoTryRunning) return;

  const now = Date.now();
  if (now - lastGestureTime < GESTURE_COOLDOWN) return;

  const landmarks = results.multiHandLandmarks[0];
  const indexTip = landmarks[8]; 
  const currentX = indexTip.x;   

  if (previousHandX !== null) {
      const diff = currentX - previousHandX;
      const SWIPE_THRESHOLD = 0.04; 

      if (diff < -SWIPE_THRESHOLD) { 
        navigateJewelry(1);
        lastGestureTime = now;
        flashIndicator("#d4af37");
        previousHandX = null; 
      } 
      else if (diff > SWIPE_THRESHOLD) { 
        navigateJewelry(-1);
        lastGestureTime = now;
        flashIndicator("#d4af37");
        previousHandX = null; 
      }
  }

  if (now - lastGestureTime > 100) {
      previousHandX = currentX;
  }
});

/* ---------- FACE MESH ---------- */
const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});

faceMesh.setOptions({ refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });

faceMesh.onResults((results) => {
  isProcessingFace = false;
  
  if(loadingStatus.style.display !== 'none') {
      loadingStatus.style.display = 'none';
  }

  canvasElement.width = videoElement.videoWidth;
  canvasElement.height = videoElement.videoHeight;
  
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  
  canvasCtx.translate(canvasElement.width, 0);
  canvasCtx.scale(-1, 1);

  if (results.multiFaceLandmarks && results.multiFaceLandmarks[0]) {
    const lm = results.multiFaceLandmarks[0];
    
    const leftEar = { x: lm[132].x * canvasElement.width, y: lm[132].y * canvasElement.height };
    const rightEar = { x: lm[361].x * canvasElement.width, y: lm[361].y * canvasElement.height };
    const neck = { x: lm[152].x * canvasElement.width, y: lm[152].y * canvasElement.height };
    const earDist = Math.hypot(rightEar.x - leftEar.x, rightEar.y - leftEar.y);

    if (earringImg && earringImg.complete) {
      let ew = earDist * 0.25;
      let eh = (earringImg.height/earringImg.width) * ew;
      canvasCtx.drawImage(earringImg, leftEar.x - ew/2, leftEar.y, ew, eh);
      canvasCtx.drawImage(earringImg, rightEar.x - ew/2, rightEar.y, ew, eh);
    }
    
    if (necklaceImg && necklaceImg.complete) {
      let nw = earDist * 1.2;
      let nh = (necklaceImg.height/necklaceImg.width) * nw;
      canvasCtx.drawImage(necklaceImg, neck.x - nw/2, neck.y + (earDist*0.2), nw, nh);
    }
  }
  canvasCtx.restore();
});

/* ---------- FAST CAMERA INIT & LOOP ---------- */
async function startCameraFast() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: "user"
            }
        });
        
        videoElement.srcObject = stream;
        
        videoElement.onloadeddata = () => {
            videoElement.play();
            loadingStatus.textContent = "Loading AI Models...";
            detectLoop(); 
        };
    } catch (err) {
        console.error("Camera Error:", err);
        alert("Camera permission denied or not found. Please allow camera access.");
        loadingStatus.textContent = "Camera Error";
    }
}

async function detectLoop() {
    if (videoElement.readyState >= 2) {
        if (!isProcessingFace) {
            isProcessingFace = true;
            await faceMesh.send({image: videoElement});
        }
        if (!isProcessingHand) {
            isProcessingHand = true;
            await hands.send({image: videoElement});
        }
    }
    requestAnimationFrame(detectLoop);
}

window.onload = startCameraFast;

/* ---------- NAVIGATION & SELECTION ---------- */
function navigateJewelry(dir) {
  if (!currentType || !preloadedAssets[currentType]) return;
  
  const list = preloadedAssets[currentType];
  let currentImg = currentType.includes('earrings') ? earringImg : necklaceImg;
  
  let idx = list.indexOf(currentImg);
  let nextIdx = (idx + dir + list.length) % list.length;
  
  const nextItem = list[nextIdx];
  if (currentType.includes('earrings')) earringImg = nextItem;
  else necklaceImg = nextItem;
}

// Updated to iterate over filenames
function selectJewelryType(type) {
  currentType = type;
  preloadCategory(type); 
  
  const container = document.getElementById('jewelry-options');
  container.innerHTML = '';
  container.style.display = 'flex';
  
  const files = JEWELRY_CONFIG[type];
  if (!files) return;

  // Use index to map button to asset
  files.forEach((filename, i) => {
    const btnImg = new Image();
    btnImg.src = `${type}/${filename}`;
    btnImg.className = "thumb-btn"; 
    btnImg.onclick = () => {
        // Since preloadedAssets[type] was pushed in same order as JEWELRY_CONFIG[type]
        // we can access by index
        const fullImg = preloadedAssets[type][i];
        if (type.includes('earrings')) earringImg = fullImg;
        else necklaceImg = fullImg;
    };
    container.appendChild(btnImg);
  });
}

function toggleCategory(cat) {
  document.getElementById('subcategory-buttons').style.display = 'flex';
  const subs = document.querySelectorAll('.subpill');
  subs.forEach(b => b.style.display = b.innerText.toLowerCase().includes(cat) ? 'inline-block' : 'none');
}

/* ---------- TRY ALL (AUTO CAPTURE) ---------- */
async function toggleTryAll() {
  if (!currentType) {
    alert("Please select a sub-category (e.g. Gold Earrings) first!");
    return;
  }
  
  if (autoTryRunning) {
    stopAutoTry();
  } else {
    startAutoTry();
  }
}

function startAutoTry() {
  autoTryRunning = true;
  autoSnapshots = [];
  autoTryIndex = 0;
  
  const btn = document.getElementById('tryall-btn');
  btn.textContent = "STOPPING...";
  btn.classList.add('active');
  
  runAutoStep();
}

function stopAutoTry() {
  autoTryRunning = false;
  if (autoTryTimeout) clearTimeout(autoTryTimeout);
  
  const btn = document.getElementById('tryall-btn');
  btn.textContent = "Try All";
  btn.classList.remove('active');
  
  if (autoSnapshots.length > 0) showGallery();
}

async function runAutoStep() {
  if (!autoTryRunning) return;

  const assets = preloadedAssets[currentType];
  if (!assets || autoTryIndex >= assets.length) {
    stopAutoTry();
    return;
  }

  const targetImg = assets[autoTryIndex];
  if (currentType.includes('earrings')) earringImg = targetImg;
  else necklaceImg = targetImg;

  autoTryTimeout = setTimeout(() => {
    captureToGallery();
    autoTryIndex++;
    runAutoStep();
  }, 1500); 
}

/* ---------- CAPTURE + WATERMARK + TEXT (FROM FILENAME) ---------- */
function captureToGallery() {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = videoElement.videoWidth;
  tempCanvas.height = videoElement.videoHeight;
  const tempCtx = tempCanvas.getContext('2d');
  
  // 1. Draw Video (Mirrored)
  tempCtx.translate(tempCanvas.width, 0);
  tempCtx.scale(-1, 1);
  tempCtx.drawImage(videoElement, 0, 0);
  
  // 2. Draw Jewelry Overlay (Reset transform first)
  tempCtx.setTransform(1, 0, 0, 1, 0, 0); 
  tempCtx.drawImage(canvasElement, 0, 0);

  // --- DYNAMIC NAME GENERATION ---
  let itemName = "Aurum Look";
  let itemFilename = "aurum_look.png";
  
  if (currentType && preloadedAssets[currentType]) {
      const list = preloadedAssets[currentType];
      let currentImg = currentType.includes('earrings') ? earringImg : necklaceImg;
      let idx = list.indexOf(currentImg);
      
      if(idx >= 0 && JEWELRY_CONFIG[currentType][idx]) {
          const rawFilename = JEWELRY_CONFIG[currentType][idx];
          
          // Clean up filename for display (remove extension, replace _ with space)
          const nameOnly = rawFilename.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");
          
          // Capitalize first letters
          itemName = nameOnly.replace(/\b\w/g, l => l.toUpperCase());
          
          // Create download filename
          itemFilename = `Aurum_${rawFilename}`;
      }
  }

  // 3. Draw Text (Bottom Left)
  const padding = 20; 
  tempCtx.font = "bold 24px Montserrat, sans-serif";
  tempCtx.textAlign = "left";
  tempCtx.textBaseline = "bottom";
  
  // Text Shadow
  tempCtx.fillStyle = "rgba(0,0,0,0.8)";
  tempCtx.fillText(itemName, padding + 2, tempCanvas.height - padding + 2);
  
  // Text Main
  tempCtx.fillStyle = "#ffffff";
  tempCtx.fillText(itemName, padding, tempCanvas.height - padding);

  // 4. Draw Watermark (Bottom Right)
  if (watermarkImg.complete && watermarkImg.naturalWidth > 0) {
      const wWidth = tempCanvas.width * 0.25; 
      const wHeight = (watermarkImg.height / watermarkImg.width) * wWidth;
      
      const wX = tempCanvas.width - wWidth - padding;
      const wY = tempCanvas.height - wHeight - padding;
      
      tempCtx.globalAlpha = 0.9; 
      tempCtx.drawImage(watermarkImg, wX, wY, wWidth, wHeight);
      tempCtx.globalAlpha = 1.0;
  }
  
  const dataUrl = tempCanvas.toDataURL('image/png');
  autoSnapshots.push(dataUrl);
  
  const flash = document.getElementById('flash-overlay');
  if(flash) {
    flash.classList.add('active');
    setTimeout(() => flash.classList.remove('active'), 100);
  }
  
  return { url: dataUrl, name: itemFilename }; 
}

function takeSnapshot() {
    const shotData = captureToGallery();
    openSinglePreview(shotData);
}

/* ---------- SINGLE PREVIEW ---------- */
function openSinglePreview(shotData) {
    currentPreviewData = shotData; 
    
    const modal = document.getElementById('preview-modal');
    const img = document.getElementById('preview-image');
    
    img.src = shotData.url;
    modal.style.display = 'flex';
}

function closePreview() {
    document.getElementById('preview-modal').style.display = 'none';
}

function downloadSingleSnapshot() {
    if(currentPreviewData && currentPreviewData.url) {
        saveAs(currentPreviewData.url, currentPreviewData.name);
    }
}

async function shareSingleSnapshot() {
    if(!currentPreviewData.url) return;
    
    const response = await fetch(currentPreviewData.url);
    const blob = await response.blob();
    
    const file = new File([blob], currentPreviewData.name, { type: "image/png" });
    
    if (navigator.share) {
        try {
            await navigator.share({
                title: 'My Aurum Atelier Look',
                text: 'Check out this jewelry I tried on virtually!',
                files: [file]
            });
        } catch (err) {
            console.warn("Share failed:", err);
        }
    } else {
        alert("Sharing is not supported on this browser. Please use Download.");
    }
}

/* ---------- GALLERY & LIGHTBOX ---------- */
function showGallery() {
  const modal = document.getElementById('gallery-modal');
  const grid = document.getElementById('gallery-grid');
  if(!modal || !grid) return;

  grid.innerHTML = '';
  
  autoSnapshots.forEach((src, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = "gallery-item-wrapper";
    
    const img = document.createElement('img');
    img.src = src;
    img.className = "gallery-thumb";
    
    img.onclick = () => openLightbox(index);
    
    wrapper.appendChild(img);
    grid.appendChild(wrapper);
  });
  
  modal.style.display = 'flex';
}

function openLightbox(selectedIndex) {
    const lightbox = document.getElementById('lightbox-overlay');
    const lightboxImg = document.getElementById('lightbox-image');
    const strip = document.getElementById('lightbox-thumbs');
    
    lightboxImg.src = autoSnapshots[selectedIndex];
    
    strip.innerHTML = '';
    
    autoSnapshots.forEach((src, idx) => {
        const thumb = document.createElement('img');
        thumb.src = src;
        thumb.className = "strip-thumb";
        if(idx === selectedIndex) thumb.classList.add('active');
        
        thumb.onclick = () => {
            lightboxImg.src = src;
            document.querySelectorAll('.strip-thumb').forEach(t => t.classList.remove('active'));
            thumb.classList.add('active');
        };
        
        strip.appendChild(thumb);
    });

    lightbox.style.display = 'flex';
}

function closeLightbox() {
    document.getElementById('lightbox-overlay').style.display = 'none';
}

function closeGallery() {
  document.getElementById('gallery-modal').style.display = 'none';
}

/* ---------- ZIP DOWNLOAD ---------- */
function downloadAllAsZip() {
    if (autoSnapshots.length === 0) {
        alert("No images to download!");
        return;
    }

    const overlay = document.getElementById('process-overlay');
    const spinner = document.getElementById('process-spinner');
    const success = document.getElementById('process-success');
    const text = document.getElementById('process-text');

    overlay.style.display = 'flex';
    spinner.style.display = 'block';
    success.style.display = 'none';
    text.innerText = "Packaging Collection...";

    const zip = new JSZip();
    const folder = zip.folder("Aurum_Collection");

    autoSnapshots.forEach((dataUrl, index) => {
        const base64Data = dataUrl.replace(/^data:image\/(png|jpg);base64,/, "");
        folder.file(`look_${index + 1}.png`, base64Data, {base64: true});
    });

    zip.generateAsync({type:"blob"})
    .then(function(content) {
        saveAs(content, "Aurum_Collection.zip");

        spinner.style.display = 'none';
        success.style.display = 'block';
        text.innerText = "Download Started!";

        setTimeout(() => {
            overlay.style.display = 'none';
        }, 2000);
    });
}

/* ---------- INITIALIZATION ---------- */
window.toggleCategory = toggleCategory;
window.selectJewelryType = selectJewelryType;
window.toggleTryAll = toggleTryAll;
window.closeGallery = closeGallery;
window.closeLightbox = closeLightbox;
window.takeSnapshot = takeSnapshot;
window.downloadAllAsZip = downloadAllAsZip;
window.closePreview = closePreview;
window.downloadSingleSnapshot = downloadSingleSnapshot;
window.shareSingleSnapshot = shareSingleSnapshot;

/* ===========================
   DISABLE RIGHT CLICK & DEV TOOLS
   ============================ */
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.onkeydown = function(e) {
  if (e.keyCode === 123) return false; // F12
  if (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67 || e.keyCode === 75)) return false;
  if (e.ctrlKey && e.keyCode === 85) return false; // Ctrl+U
};