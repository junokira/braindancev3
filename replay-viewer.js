// Replay viewer module
//
// Responsible for rendering media on a plane within a Three.js
// scene and animating the camera along a motion path. Provides
// controls for play/pause, timeline scrubbing and audio muting.
// Expects the containing HTML to define elements with ids
// viewport, play-btn, mute-btn, timeline and telemetry. See N07–N15.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { getReplay } from './script.js';

// Main entry point
document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const viewport = document.getElementById('viewport');
  const playBtn = document.getElementById('play-btn');
  const muteBtn = document.getElementById('mute-btn');
  const timeline = document.getElementById('timeline');
  const telemetry = document.getElementById('telemetry');
  const errorText = document.getElementById('error-text');
  if (!id || !viewport || !playBtn || !muteBtn || !timeline) return;
  const replay = await getReplay(id);
  if (!replay) {
    if (errorText) errorText.textContent = 'Replay not found';
    return;
  }
  // Create Three.js renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  renderer.setClearColor(0x000000, 1);
  viewport.appendChild(renderer.domElement);
  // Scene and camera
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, viewport.clientWidth / viewport.clientHeight, 0.1, 100);
  camera.position.set(0, 0, 3);
  // Controls (for manual orbit)
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enabled = false; // disabled during follow mode by default
  // Media loading
  let mediaUrl = null;
  let texture;
  let videoEl;
  if (replay.mediaKind === 'image') {
    // Create texture for image
    mediaUrl = URL.createObjectURL(replay.mediaBlob);
    await new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        mediaUrl,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          texture = tex;
          resolve();
        },
        undefined,
        (err) => reject(err)
      );
    });
  } else {
    // Create video element and texture
    mediaUrl = URL.createObjectURL(replay.mediaBlob);
    videoEl = document.createElement('video');
    videoEl.src = mediaUrl;
    videoEl.playsInline = true;
    videoEl.preload = 'auto';
    videoEl.loop = false;
    videoEl.muted = true; // start muted; user can unmute
    await videoEl.play().catch(() => {});
    videoEl.pause();
    texture = new THREE.VideoTexture(videoEl);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
  }
  // Create plane
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(geometry, material);
  scene.add(plane);
  // Camera path
  const path = Array.isArray(replay.cameraPath) && replay.cameraPath.length > 0 ? replay.cameraPath : [];
  // Playback state
  let playing = false;
  let animating = true;
  let followT = 0;
  let lastFrameTime = performance.now();
  // UI state
  timeline.value = 0;
  timeline.min = 0;
  timeline.max = 100;
  playBtn.textContent = 'Play';
  // Mute control
  const updateMuteIcon = () => {
    muteBtn.textContent = videoEl && !videoEl.muted ? 'Mute' : 'Unmute';
  };
  muteBtn.addEventListener('click', () => {
    if (!videoEl) return;
    videoEl.muted = !videoEl.muted;
    updateMuteIcon();
  });
  updateMuteIcon();
  // Timeline interaction
  let scrubbing = false;
  timeline.addEventListener('input', () => {
    scrubbing = true;
    const t = timeline.value / 100;
    followT = t;
    updateCameraFromPath(t);
    if (videoEl && videoEl.duration && !isNaN(videoEl.duration)) {
      videoEl.currentTime = t * videoEl.duration;
    }
  });
  timeline.addEventListener('change', () => {
    scrubbing = false;
  });
  // Play/pause control
  playBtn.addEventListener('click', () => {
    playing = !playing;
    playBtn.textContent = playing ? 'Pause' : 'Play';
    if (videoEl) {
      if (playing) {
        videoEl.play().catch(() => {});
      } else {
        videoEl.pause();
      }
    }
  });
  // Window resize handling
  const ro = new ResizeObserver(() => {
    const { clientWidth, clientHeight } = viewport;
    renderer.setSize(clientWidth, clientHeight);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  });
  ro.observe(viewport);
  // Animation loop
  function animate() {
    if (!animating) return;
    requestAnimationFrame(animate);
    const now = performance.now();
    const delta = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    if (playing && path.length > 0 && !scrubbing) {
      if (videoEl && videoEl.duration && !isNaN(videoEl.duration)) {
        followT = Math.min(1, videoEl.currentTime / videoEl.duration);
      } else {
        followT += delta / 10; // approximate 10 seconds loop for images
        if (followT > 1) followT = 0;
      }
      timeline.value = followT * 100;
    }
    if (path.length > 0) {
      updateCameraFromPath(followT);
    }
    if (controls.enabled) {
      controls.update();
    }
    renderer.render(scene, camera);
  }
  function updateCameraFromPath(t) {
    if (!path || path.length === 0) return;
    // Find segment via linear interpolation
    const idx = Math.floor(t * (path.length - 1));
    const nextIdx = Math.min(path.length - 1, idx + 1);
    const localT = (t * (path.length - 1)) - idx;
    const p0 = path[idx];
    const p1 = path[nextIdx];
    const x = p0.x + (p1.x - p0.x) * localT;
    const y = p0.y + (p1.y - p0.y) * localT;
    const z = p0.z + (p1.z - p0.z) * localT;
    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
    if (telemetry) {
      telemetry.textContent = `t=${t.toFixed(2)} x=${x.toFixed(2)} z=${z.toFixed(2)}`;
    }
  }
  animate();
  // Cleanup on pagehide
  const cleanup = () => {
    animating = false;
    ro.disconnect();
    controls.dispose();
    renderer.dispose();
    if (texture && texture.dispose) texture.dispose();
    if (videoEl) {
      videoEl.pause();
      videoEl.src = '';
      videoEl.load();
    }
    if (mediaUrl) {
      URL.revokeObjectURL(mediaUrl);
    }
  };
  window.addEventListener('pagehide', cleanup, { once: true });
});