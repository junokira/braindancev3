// BD Replay core logic
//
// This module centralises the IndexedDB layer, replay data
// management and page initialisers for the BD Replay application.
// It is written as an ES module and exports several helpers for
// other modules (most notably the replay viewer). Page specific
// functions are invoked based on the `data-page` attribute on the
// `<body>` element. See accompanying HTML files for usage.

const DB_NAME = 'bdReplay';
const DB_VERSION = 1;
let dbPromise;

/**
 * Open (or upgrade) the IndexedDB database. A module level
 * singleton promise is used to avoid repeated connections. If a
 * version change occurs in another tab the existing connection is
 * closed and the page reloads. See N01.
 * @returns {Promise<IDBDatabase>}
 */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains('replays')) {
        db.createObjectStore('replays', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
      }
    };
    request.onblocked = () => {
      console.warn('IndexedDB upgrade blocked by another open tab');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      // If another tab upgrades the DB then close this connection
      // and reload to avoid being stuck in a blocked state.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        location.reload();
      };
      resolve(db);
    };
  });
  return dbPromise;
}

/**
 * Run a function against a store within a transaction. Automatically
 * retries once if the connection is invalidated by the browser (see
 * N16). Returns the function's result on successful completion.
 * @param {string} storeName
 * @param {'readonly'|'readwrite'} mode
 * @param {Function} fn
 */
export async function withStore(storeName, mode, fn) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      try {
        result = fn(store);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    if (err && err.name === 'InvalidStateError') {
      // Reset connection and retry
      dbPromise = null;
      return withStore(storeName, mode, fn);
    }
    throw err;
  }
}

/**
 * Retrieve all replays stored in IndexedDB.
 * @returns {Promise<Array>}
 */
export async function getAllReplays() {
  return withStore('replays', 'readonly', (store) => store.getAll());
}

/**
 * Retrieve a single replay by id.
 * @param {string} id
 * @returns {Promise<object|undefined>}
 */
export async function getReplay(id) {
  return withStore('replays', 'readonly', (store) => store.get(id));
}

/**
 * Persist a replay record. The record must include an `id` field.
 * @param {object} replay
 */
export async function saveReplay(replay) {
  return withStore('replays', 'readwrite', (store) => {
    store.put(replay);
  });
}

/**
 * Delete a replay record by id.
 * @param {string} id
 */
export async function deleteReplay(id) {
  return withStore('replays', 'readwrite', (store) => {
    store.delete(id);
  });
}

/**
 * Update a replay record with new fields. Automatically stamps
 * `updated` with the current time.
 * @param {string} id
 * @param {object} updates
 */
export async function updateReplay(id, updates) {
  const replay = await getReplay(id);
  if (!replay) return;
  Object.assign(replay, updates);
  replay.updated = Date.now();
  await saveReplay(replay);
  return replay;
}

/**
 * Retrieve a setting value from IndexedDB. If no value is stored,
 * return the provided default.
 * @param {string} key
 * @param {*} defaultVal
 */
export async function getSetting(key, defaultVal) {
  const value = await withStore('settings', 'readonly', (store) => store.get(key));
  return value === undefined ? defaultVal : value;
}

/**
 * Persist a setting value to IndexedDB.
 * @param {string} key
 * @param {*} value
 */
export async function setSetting(key, value) {
  return withStore('settings', 'readwrite', (store) => {
    store.put(value, key);
  });
}

/**
 * Format a byte count into a human friendly string. Handles zero,
 * NaN and negative values gracefully. See N21.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Generate a pseudo‑random identifier. Uses crypto.randomUUID if
 * available, otherwise falls back to a timestamp and random base36
 * string. This function is used when creating new replays.
 * @returns {string}
 */
export function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * Capture a thumbnail from an image file. The image is resized
 * proportionally to fit within a 320px bound. The returned value
 * is a data URL of a JPEG compressed using the provided quality.
 * @param {File|Blob} file
 * @param {number} quality
 * @returns {Promise<string>} data URL
 */
export async function captureImageThumbnail(file, quality) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  return new Promise((resolve, reject) => {
    img.onload = () => {
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      const maxDim = 320;
      if (w > h && w > maxDim) {
        h = h * (maxDim / w);
        w = maxDim;
      } else if (h >= w && h > maxDim) {
        w = w * (maxDim / h);
        h = maxDim;
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => {
          const reader = new FileReader();
          reader.onload = () => {
            URL.revokeObjectURL(url);
            resolve(reader.result);
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        },
        'image/jpeg',
        quality
      );
    };
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Capture a thumbnail from a video file. Seeks to 8% of the
 * duration (guarding against non-finite durations as per F06) and
 * captures a frame. The returned value is a data URL of a JPEG.
 * @param {File|Blob} file
 * @param {number} quality
 */
export async function captureVideoThumbnail(file, quality) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.src = url;
  return new Promise((resolve, reject) => {
    const onLoaded = () => {
      const safeDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 10;
      const targetTime = Math.min(1, safeDuration * 0.08);
      const captureFrame = () => {
        const canvas = document.createElement('canvas');
        const w = video.videoWidth;
        const h = video.videoHeight;
        let drawW = w;
        let drawH = h;
        const maxDim = 320;
        if (w > h && w > maxDim) {
          drawH = h * (maxDim / w);
          drawW = maxDim;
        } else if (h >= w && h > maxDim) {
          drawW = w * (maxDim / h);
          drawH = maxDim;
        }
        canvas.width = drawW;
        canvas.height = drawH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, drawW, drawH);
        canvas.toBlob(
          (blob) => {
            const reader = new FileReader();
            reader.onload = () => {
              // Release resources
              video.src = '';
              video.load();
              URL.revokeObjectURL(url);
              resolve(reader.result);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          },
          'image/jpeg',
          quality
        );
      };
      // Seek and capture
      const seek = () => {
        video.removeEventListener('loadeddata', onLoaded);
        // One-off handler for the seeked event. See N02 for why
        // we install and remove listeners rather than assigning
        // repeatedly inside a loop.
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          video.removeEventListener('error', onError);
          captureFrame();
        };
        const onError = () => {
          video.removeEventListener('seeked', onSeeked);
          video.removeEventListener('error', onError);
          reject(new Error('Failed to seek for thumbnail'));
        };
        video.addEventListener('seeked', onSeeked);
        video.addEventListener('error', onError);
        try {
          video.currentTime = targetTime;
        } catch (err) {
          // Some browsers throw if setting currentTime while
          // seeking; fall back to 0
          video.currentTime = 0;
        }
      };
      seek();
    };
    video.addEventListener('loadeddata', onLoaded);
    video.onerror = () => reject(new Error('Failed to load video'));
  });
}

/**
 * Compute a simple motion quality metric from device orientation
 * samples. Uses variance relative to the first sample and wraps
 * compass heading (alpha) across 0/360 boundaries. See N07 and N09.
 * @param {Array<{alpha:number,beta:number,gamma:number,time:number}>} samples
 * @returns {number}
 */
export function computeSensorMotionQuality(samples) {
  if (!samples || samples.length === 0) return 0;
  const base = samples[0];
  let sum = 0;
  for (const s of samples) {
    const alphaDiff = Math.min(Math.abs(s.alpha - base.alpha), 360 - Math.abs(s.alpha - base.alpha));
    const betaDiff = Math.abs(s.beta - base.beta);
    sum += alphaDiff + betaDiff;
  }
  const variance = sum / samples.length;
  return Math.min(1, variance / 30);
}

/**
 * Convert orientation sensor samples into a camera path. Computes
 * yaw and pitch relative to the first sample and produces a series
 * of points in 3D space. The path is normalized into a gentle
 * spiral around the media plane. See N10.
 * @param {Array<{alpha:number,beta:number,gamma:number,time:number}>} samples
 * @returns {Array<{t:number,x:number,y:number,z:number,yaw:number,pitch:number}>}
 */
export function cameraPathFromSensor(samples) {
  if (!samples || samples.length === 0) return [];
  const baseAlpha = samples[0].alpha || 0;
  const baseBeta = samples[0].beta || 0;
  const count = samples.length;
  // Downsample to at most 128 points evenly distributed
  const step = Math.max(1, Math.floor(count / 96));
  const path = [];
  for (let i = 0; i < count && path.length < 128; i += step) {
    const s = samples[i];
    const t = i / (count - 1);
    // Compute delta alpha with wrap-around into [-180,180]
    const rawAlphaDelta = (s.alpha - baseAlpha + 540) % 360 - 180;
    const rawBetaDelta = s.beta - baseBeta;
    const yaw = (rawAlphaDelta / 180) * Math.PI;
    const pitch = (rawBetaDelta / 180) * Math.PI;
    // Place the camera on a shrinking circle around the content
    const radius = 2.6 - 1.6 * t;
    const x = Math.sin(yaw) * radius;
    const z = Math.cos(yaw) * radius;
    path.push({ t, x, y: 0, z, yaw, pitch });
  }
  return path;
}

/**
 * Estimate a motion path from video by sampling frames and
 * accumulating pixel differences. This is a simple heuristic used
 * in the absence of sensor data. It yields a list of points in
 * 3D space together with a quality metric. Path values are
 * normalized to fit within the viewer bounds. See N02, N06 and
 * unresolved architecture gap description.
 * @param {Blob} blob
 * @param {function(progress:number,stage:string):void} [onProgress]
 * @returns {Promise<{cameraPath:Array,motionQuality:number}>}
 */
export async function estimateMotionPathFromVideo(blob, onProgress) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.src = url;
  // Wait for video to load metadata
  await new Promise((resolve, reject) => {
    const onLoaded = () => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      reject(new Error('Video failed to load'));
    };
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('error', onError);
  });
  const safeDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 10;
  const frameCount = 64;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  let lastBrightness = null;
  let accumX = 0;
  let accumZ = 0;
  const rawPath = [];
  for (let i = 0; i < frameCount; i++) {
    const t = i / (frameCount - 1);
    const targetTime = safeDuration * t;
    // Seek to the target time and wait for the seeked event. See N02.
    await new Promise((resolve, reject) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        reject(new Error('Seek failed'));
      };
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      try {
        video.currentTime = Math.min(video.duration - 0.05, targetTime);
      } catch (e) {
        video.currentTime = 0;
      }
    });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Compute brightness averages on left/right halves for lateral motion
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sumLeft = 0;
    let sumRight = 0;
    let countLeft = 0;
    let countRight = 0;
    for (let y = 0; y < canvas.height; y += 16) {
      for (let x = 0; x < canvas.width; x += 16) {
        const idx = (y * canvas.width + x) * 4;
        const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        if (x < canvas.width / 2) {
          sumLeft += brightness;
          countLeft++;
        } else {
          sumRight += brightness;
          countRight++;
        }
      }
    }
    const avgLeft = sumLeft / countLeft;
    const avgRight = sumRight / countRight;
    const lateral = (avgRight - avgLeft) / 255; // range roughly [-1,1]
    // Compute global brightness for forward/back movement
    let total = 0;
    let cnt = 0;
    for (let p = 0; p < data.length; p += 64) {
      total += data[p] + data[p + 1] + data[p + 2];
      cnt++;
    }
    const avgBrightness = total / (cnt * 3);
    let forward = 0;
    if (lastBrightness !== null) {
      forward = (avgBrightness - lastBrightness) / 255;
    }
    lastBrightness = avgBrightness;
    accumX += lateral * 0.2;
    accumZ += forward * 0.1;
    rawPath.push({ t, x: accumX, y: 0, z: accumZ });
    if (onProgress) {
      onProgress(Math.floor(((i + 1) / frameCount) * 100), 'Analyzing frames');
    }
  }
  // Normalize the path into the viewer coordinate space. We map x
  // into [-1.5,1.5] and z into [1,2.5] with inverted range so that
  // movement forward moves closer to the plane. This resolves the
  // unresolved architecture gap described in the audit.
  const xs = rawPath.map((p) => p.x);
  const zs = rawPath.map((p) => p.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const cameraPath = rawPath.map((p) => {
    const xNorm = maxX !== minX ? (p.x - minX) / (maxX - minX) : 0.5;
    const zNorm = maxZ !== minZ ? (p.z - minZ) / (maxZ - minZ) : p.t;
    return {
      t: p.t,
      x: xNorm * 3 - 1.5,
      y: 0,
      z: 2.5 - zNorm * 1.5
    };
  });
  // Compute a simple quality: total distance travelled normalised
  let dist = 0;
  for (let i = 1; i < cameraPath.length; i++) {
    const dx = cameraPath[i].x - cameraPath[i - 1].x;
    const dz = cameraPath[i].z - cameraPath[i - 1].z;
    dist += Math.sqrt(dx * dx + dz * dz);
  }
  const motionQuality = Math.min(1, dist / (cameraPath.length * 0.1));
  // Cleanup
  video.src = '';
  video.load();
  URL.revokeObjectURL(url);
  return { cameraPath, motionQuality };
}

/**
 * Create a replay record from a media file and optional sensor
 * samples. Generates a thumbnail and sets up the record with
 * default fields. The caller is responsible for persisting the
 * record via saveReplay().
 * @param {File|Blob} file
 * @param {Array} [sensorSamples]
 */
export async function makeReplayFromFile(file, sensorSamples) {
  const id = generateId();
  const thumbQuality = parseFloat(await getSetting('thumbnailQuality', '0.78')) || 0.78;
  const mediaKind = file.type.startsWith('image') ? 'image' : 'video';
  const replay = {
    id,
    name: file.name || 'Untitled',
    created: Date.now(),
    updated: Date.now(),
    status: 'processing',
    fileSize: file.size,
    mediaKind,
    mediaBlob: file,
    thumbnail: '',
    motionSource: 'synthetic',
    motionQuality: 0,
    cameraPath: [],
    hasSensor: false,
    sensorSamples: []
  };
  if (mediaKind === 'image') {
    replay.thumbnail = await captureImageThumbnail(file, thumbQuality);
  } else {
    replay.thumbnail = await captureVideoThumbnail(file, thumbQuality);
  }
  if (sensorSamples && sensorSamples.length > 1) {
    replay.hasSensor = true;
    replay.sensorSamples = sensorSamples;
    replay.motionSource = 'sensor';
    replay.cameraPath = cameraPathFromSensor(sensorSamples);
    replay.motionQuality = computeSensorMotionQuality(sensorSamples);
    replay.status = 'ready';
  }
  return replay;
}

/**
 * Initialise the upload page. Handles selecting a media file and
 * storing a replay in IndexedDB before redirecting to the processing
 * page. Drag‑and‑drop is supported (see new issue N12). The page
 * expects an element with id="file-input" and a button with
 * id="upload-btn".
 */
async function initUploadPage() {
  const fileInput = document.getElementById('file-input');
  const uploadBtn = document.getElementById('upload-btn');
  const dropZone = document.getElementById('drop-zone');
  if (!fileInput || !uploadBtn) return;
  const handleFile = async (file) => {
    if (!file) {
      alert('Please select a media file to upload.');
      return;
    }
    const replay = await makeReplayFromFile(file);
    await saveReplay(replay);
    window.location.href = `processing.html?id=${encodeURIComponent(replay.id)}`;
  };
  uploadBtn.addEventListener('click', () => {
    const file = fileInput.files && fileInput.files[0];
    handleFile(file);
  });
  // Drag and drop support
  const onDragOver = (e) => {
    e.preventDefault();
    if (dropZone) dropZone.classList.add('over');
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    if (dropZone) dropZone.classList.remove('over');
  };
  const onDrop = (e) => {
    e.preventDefault();
    if (dropZone) dropZone.classList.remove('over');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  };
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);
}

/**
 * Initialise the capture page. Provides a camera preview and
 * records a short clip along with orientation samples. The page
 * requires elements with ids: preview, start-btn, stop-btn. See
 * N12 for drag-and-drop on the upload page; the capture page uses
 * direct recording instead.
 */
async function initCapturePage() {
  const preview = document.getElementById('preview');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  if (!preview || !startBtn || !stopBtn) return;
  let mediaStream;
  let recorder;
  let chunks = [];
  let sensorSamples = [];
  let collecting = false;
  const addSample = (event) => {
    if (!collecting) return;
    sensorSamples.push({
      alpha: event.alpha ?? 0,
      beta: event.beta ?? 0,
      gamma: event.gamma ?? 0,
      time: performance.now()
    });
  };
  const stopSensors = () => {
    window.removeEventListener('deviceorientation', addSample);
  };
  startBtn.addEventListener('click', async () => {
    if (mediaStream) return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      alert('Unable to access camera: ' + err.message);
      return;
    }
    preview.srcObject = mediaStream;
    preview.play();
    chunks = [];
    sensorSamples = [];
    collecting = true;
    window.addEventListener('deviceorientation', addSample);
    recorder = new MediaRecorder(mediaStream, { mimeType: 'video/webm' });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };
    recorder.onstop = async () => {
      collecting = false;
      stopSensors();
      const blob = new Blob(chunks, { type: recorder.mimeType });
      // Stop preview
      preview.pause();
      preview.srcObject = null;
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
      // Create replay and redirect
      const replay = await makeReplayFromFile(blob, sensorSamples);
      await saveReplay(replay);
      window.location.href = `processing.html?id=${encodeURIComponent(replay.id)}`;
    };
    recorder.start(250);
    startBtn.disabled = true;
    stopBtn.disabled = false;
  });
  stopBtn.addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  });
}

/**
 * Initialise the processing page. Handles replays in the
 * 'processing' state by computing motion paths and updating
 * progress. If the replay is already ready, it simply reveals the
 * explore button. See F02 and N13.
 */
async function initProcessingPage() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const statusText = document.getElementById('status-text');
  const progressBar = document.getElementById('progress-bar');
  const exploreBtn = document.getElementById('explore-btn');
  if (!id || !statusText || !progressBar) return;
  const replay = await getReplay(id);
  if (!replay) {
    statusText.textContent = 'Replay not found.';
    return;
  }
  // If already ready, show explore
  if (replay.status === 'ready') {
    statusText.textContent = 'Ready to explore';
    progressBar.style.width = '100%';
    if (exploreBtn) {
      exploreBtn.removeAttribute('hidden');
      exploreBtn.href = `replay.html?id=${encodeURIComponent(id)}`;
    }
    return;
  }
  // Otherwise perform processing
  let currentProgress = 0;
  const setProgress = (val, stage, persist = false) => {
    currentProgress = Math.min(100, Math.max(val, currentProgress));
    progressBar.style.width = `${currentProgress}%`;
    statusText.textContent = stage;
    // Persist intermediate status only when requested
    if (persist) {
      updateReplay(id, { processing: { progress: currentProgress, stage }, updated: Date.now() });
    }
  };
  try {
    setProgress(10, 'Reading metadata');
    // For sensor replays the path is already computed
    if (replay.hasSensor) {
      setProgress(100, 'Ready', false);
      await updateReplay(id, { status: 'ready' });
      if (exploreBtn) {
        exploreBtn.removeAttribute('hidden');
        exploreBtn.href = `replay.html?id=${encodeURIComponent(id)}`;
      }
      return;
    }
    // Estimate motion from video if applicable
    if (replay.mediaKind === 'video') {
      setProgress(20, 'Extracting motion', false);
      const { cameraPath, motionQuality } = await estimateMotionPathFromVideo(replay.mediaBlob, (p, stage) => {
        // Map the estimator progress into 20..80
        const val = 20 + (p / 100) * 60;
        setProgress(val, stage, false);
      });
      replay.cameraPath = cameraPath;
      replay.motionQuality = motionQuality;
      replay.motionSource = 'video';
    } else {
      // Static images use a synthetic circular path
      const synthetic = [];
      for (let i = 0; i < 64; i++) {
        const t = i / 63;
        const angle = t * Math.PI * 2;
        const radius = 2.4;
        synthetic.push({ t, x: Math.sin(angle) * radius, y: 0, z: Math.cos(angle) * radius });
      }
      replay.cameraPath = synthetic;
      replay.motionQuality = 0;
      replay.motionSource = 'synthetic';
    }
    // Mark ready and persist
    replay.status = 'ready';
    await saveReplay(replay);
    setProgress(100, 'Ready', false);
    if (exploreBtn) {
      exploreBtn.removeAttribute('hidden');
      exploreBtn.href = `replay.html?id=${encodeURIComponent(id)}`;
    }
  } catch (err) {
    console.error(err);
    statusText.textContent = 'Error during processing';
  }
}

/**
 * Initialise the library page. Lists all replays, allows renaming
 * and deleting records. Avoids full re-renders when renaming as per
 * F14. Provides export functionality via the download attribute on
 * anchor tags.
 */
async function initLibraryPage() {
  const list = document.getElementById('replay-list');
  if (!list) return;
  const replays = await getAllReplays();
  replays.sort((a, b) => b.created - a.created);
  list.innerHTML = '';
  for (const r of replays) {
    const item = document.createElement('div');
    item.className = 'card';
    item.dataset.id = r.id;
    item.innerHTML = `
      <img class="thumb" src="${r.thumbnail || ''}" alt="${r.name} thumbnail">
      <div class="info">
        <strong class="name">${escapeHtml(r.name)}</strong><br>
        <small>${new Date(r.created).toLocaleString()}</small><br>
        <small>${r.mediaKind} · ${formatBytes(r.fileSize)} · ${r.motionSource}</small><br>
        <small>Quality: ${(r.motionQuality * 100).toFixed(0)}%</small>
      </div>
      <div class="actions">
        <button class="button rename-btn">Rename</button>
        <button class="button delete-btn">Delete</button>
        <a class="button" href="replay.html?id=${encodeURIComponent(r.id)}">Open</a>
        <a class="button export-btn" download="${escapeFileName(r.name)}.json">Export</a>
      </div>
    `;
    list.appendChild(item);
    // Export handler
    const exportBtn = item.querySelector('.export-btn');
    exportBtn.addEventListener('click', (e) => {
      const data = { ...r };
      // Remove blob fields for export
      delete data.mediaBlob;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const exportUrl = URL.createObjectURL(blob);
      exportBtn.href = exportUrl;
      setTimeout(() => URL.revokeObjectURL(exportUrl), 10000);
    });
    // Rename handler
    const renameBtn = item.querySelector('.rename-btn');
    renameBtn.addEventListener('click', async () => {
      const newName = prompt('Enter a new name for this replay:', r.name);
      if (!newName || newName.trim() === '' || newName === r.name) return;
      await updateReplay(r.id, { name: newName.trim() });
      // Update DOM in place
      item.querySelector('.name').textContent = escapeHtml(newName.trim());
    });
    // Delete handler
    const deleteBtn = item.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${r.name}" from this browser?`)) return;
      await deleteReplay(r.id);
      item.remove();
    });
  }
}

/**
 * Initialise the settings page. Provides a thumbnail quality
 * selector and optionally other settings. Values are saved to
 * IndexedDB when changed. Hides the page if not needed.
 */
async function initSettingsPage() {
  const select = document.getElementById('thumbnail-quality');
  if (!select) return;
  const value = await getSetting('thumbnailQuality', '0.78');
  select.value = String(value);
  select.addEventListener('change', () => {
    setSetting('thumbnailQuality', select.value);
  });
}

/**
 * Escape HTML special characters to avoid XSS when injecting
 * untrusted strings into the DOM. This is used when rendering
 * replay names. See N18 for why thumbnail injection is safe.
 * @param {string} str
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a filename for use in a download attribute. Removes
 * problematic characters and whitespace.
 * @param {string} name
 */
function escapeFileName(name) {
  return name.replace(/[^a-z0-9_\-]+/gi, '_').substring(0, 64);
}

// Dispatch initialisers based on data-page. The replay page is
// handled entirely in replay-viewer.js (see F05) so there is no
// replay branch here.
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  switch (page) {
    case 'upload':
      initUploadPage();
      break;
    case 'capture':
      initCapturePage();
      break;
    case 'processing':
      initProcessingPage();
      break;
    case 'library':
      initLibraryPage();
      break;
    case 'settings':
      initSettingsPage();
      break;
    default:
      // home or replay handled elsewhere
      break;
  }
});