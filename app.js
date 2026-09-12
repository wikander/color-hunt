(() => {
  'use strict';

  // ---------- Config ----------

  // Max possible RGB Euclidean distance is sqrt(255^2*3) ≈ 441.7.
  // Threshold = how close (in that distance) an attempt must be to count as a match.
  const DIFFICULTY_THRESHOLDS = {
    easy: 130,
    medium: 75,
    hard: 40,
  };

  const SAMPLE_INTERVAL_MS = 150;
  const SAMPLE_WIDTH = 48;
  const SAMPLE_HEIGHT = 36;
  const HISTOGRAM_BITS = 4; // per channel -> 16 levels/channel, 4096 bins

  // Smoothing for the live camera color: a small hand shake changes the
  // dominant color only a little between frames, so it's damped heavily
  // (SLOW). A deliberate move to point at something new changes it a lot,
  // so those bigger jumps are allowed through faster (FAST).
  const SMOOTH_ALPHA_SLOW = 0.12;
  const SMOOTH_ALPHA_FAST = 0.5;
  const SMOOTH_JUMP_DISTANCE = 60;

  const STORAGE_KEY = 'color-hunt-stats-v1';

  // ---------- State ----------

  const state = {
    difficulty: 'medium',
    target: null,         // {r,g,b}
    liveColor: null,      // {r,g,b} - continuously updated, smoothed camera color
    collectedColor: null, // {r,g,b} - snapshot taken on the last tap-to-collect
    attempts: 0,
    stream: null,
    sampleTimer: null,
  };

  const stats = loadStats();

  // ---------- Elements ----------

  const els = {
    screenStart: document.getElementById('screen-start'),
    screenGame: document.getElementById('screen-game'),
    diffButtons: document.querySelectorAll('.diff-btn'),
    btnStart: document.getElementById('btn-start'),
    startError: document.getElementById('start-error'),

    video: document.getElementById('camera'),
    canvas: document.getElementById('sample-canvas'),

    targetThird: document.getElementById('target-third'),
    collectBtn: document.getElementById('collect-btn'),
    blendBtn: document.getElementById('blend-btn'),
    collectedHalf: document.getElementById('collected-half'),

    btnQuit: document.getElementById('btn-quit'),

    statAttempts: document.getElementById('stat-attempts'),

    winOverlay: document.getElementById('win-overlay'),
    winAttempts: document.getElementById('win-attempts'),
    winBest: document.getElementById('win-best'),
    btnNext: document.getElementById('btn-next'),
  };

  const ctx = els.canvas.getContext('2d', { willReadFrequently: true });
  els.canvas.width = SAMPLE_WIDTH;
  els.canvas.height = SAMPLE_HEIGHT;

  // ---------- Color helpers ----------

  function rgbToCss({ r, g, b }) {
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  }

  function colorDistance(a, b) {
    const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function clampByte(v) {
    return Math.min(255, Math.max(0, v));
  }

  // Converts a display RGB color into an approximate Red-Yellow-Blue
  // "paint" space, mirroring how pigments (not light) combine. Plain RGB
  // averaging can't produce blue+yellow=green because it never moves
  // energy between channels; this can, since it's built by shuffling
  // channel overlaps (e.g. the R/G overlap read as "yellow") rather than
  // averaging channels independently.
  function rgbToRyb(r, g, b) {
    const w = Math.min(r, g, b);
    r -= w; g -= w; b -= w;
    const maxRgb = Math.max(r, g, b);

    const y = Math.min(r, g);
    r -= y; g -= y;

    // leftover red+green ("cyan-ish") light has to be split between the
    // yellow and blue pigment outputs, or it'd be double-counted.
    if (b > 0 && g > 0) {
      b /= 2; g /= 2;
    }

    let Y = y + g;
    let B = b + g;
    let R = r;

    const maxRyb = Math.max(R, Y, B);
    if (maxRyb > 0) {
      const scale = maxRgb / maxRyb;
      R *= scale; Y *= scale; B *= scale;
    }

    return { r: R + w, y: Y + w, b: B + w };
  }

  // Inverse of rgbToRyb: turns mixed paint back into a display color.
  function rybToRgb(r, y, b) {
    const w = Math.min(r, y, b);
    r -= w; y -= w; b -= w;
    const maxRyb = Math.max(r, y, b);

    // yellow+blue pigment overlap reads as green light.
    const g = Math.min(y, b);
    y -= g; b -= g;

    // leftover yellow pigment looks like red+green light; leftover blue
    // pigment looks like blue light only.
    let R = r + y;
    let G = g + y;
    let B = b;

    const maxRgb = Math.max(R, G, B);
    if (maxRgb > 0) {
      const scale = maxRyb / maxRgb;
      R *= scale; G *= scale; B *= scale;
    }

    return {
      r: clampByte(R + w),
      g: clampByte(G + w),
      b: clampByte(B + w),
    };
  }

  // Blends two real-world colors the way watercolors mix on paper,
  // rather than just averaging their RGB channels.
  function blendColors(a, b) {
    const rybA = rgbToRyb(a.r, a.g, a.b);
    const rybB = rgbToRyb(b.r, b.g, b.b);
    return rybToRgb(
      (rybA.r + rybB.r) / 2,
      (rybA.y + rybB.y) / 2,
      (rybA.b + rybB.b) / 2
    );
  }

  // Picks black or white text so labels stay legible against any background color.
  function contrastingTextColor({ r, g, b }) {
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 150 ? '#14161a' : '#f5f5f5';
  }

  function randomColor() {
    return {
      r: Math.floor(Math.random() * 256),
      g: Math.floor(Math.random() * 256),
      b: Math.floor(Math.random() * 256),
    };
  }

  // Extracts the "most apparent" color from an image: pixels are quantized
  // into coarse RGB bins, the most frequent bin wins, and its member pixels
  // are averaged for a smooth result. This lets a dominant real-world color
  // win out while still blending naturally when colors are mixed in view.
  function dominantColor(imageData) {
    const data = imageData.data;
    const shift = 8 - HISTOGRAM_BITS;
    const bins = new Map();

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> shift) << (HISTOGRAM_BITS * 2)) | ((g >> shift) << HISTOGRAM_BITS) | (b >> shift);
      let bin = bins.get(key);
      if (!bin) {
        bin = { count: 0, r: 0, g: 0, b: 0 };
        bins.set(key, bin);
      }
      bin.count++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
    }

    let winner = null;
    for (const bin of bins.values()) {
      if (!winner || bin.count > winner.count) winner = bin;
    }
    if (!winner) return { r: 128, g: 128, b: 128 };

    return {
      r: Math.round(winner.r / winner.count),
      g: Math.round(winner.g / winner.count),
      b: Math.round(winner.b / winner.count),
    };
  }

  // ---------- Stats persistence ----------

  function loadStats() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore corrupted/unavailable storage */ }
    return { roundsWon: 0, totalAttempts: 0, bestAttempts: null };
  }

  function saveStats() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
    } catch (e) { /* storage unavailable, ignore */ }
  }

  // ---------- Difficulty picker ----------

  els.diffButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      els.diffButtons.forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.difficulty = btn.dataset.difficulty;
    });
  });

  // ---------- Camera setup ----------

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera access is not supported in this browser.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    state.stream = stream;
    els.video.srcObject = stream;
    await els.video.play();
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
  }

  // Exponential moving average toward the newly sampled color. Small
  // per-frame deltas (hand shake) move slowly; a big delta (pointing at
  // something new) is treated as deliberate and catches up quickly.
  function updateLiveColor(sample) {
    if (!state.liveColor) {
      state.liveColor = sample;
      return;
    }
    const jump = colorDistance(sample, state.liveColor);
    const alpha = jump > SMOOTH_JUMP_DISTANCE ? SMOOTH_ALPHA_FAST : SMOOTH_ALPHA_SLOW;
    state.liveColor = {
      r: state.liveColor.r + alpha * (sample.r - state.liveColor.r),
      g: state.liveColor.g + alpha * (sample.g - state.liveColor.g),
      b: state.liveColor.b + alpha * (sample.b - state.liveColor.b),
    };
  }

  function sampleFrame() {
    if (els.video.readyState < 2) return;
    ctx.drawImage(els.video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const imageData = ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    updateLiveColor(dominantColor(imageData));
    renderLiveColor();
  }

  // ---------- Rendering ----------

  function renderTarget() {
    els.targetThird.style.background = rgbToCss(state.target);
    els.targetThird.style.color = contrastingTextColor(state.target);
  }

  function renderLiveColor() {
    if (!state.liveColor) return;
    els.collectBtn.style.background = rgbToCss(state.liveColor);
    els.collectBtn.style.color = contrastingTextColor(state.liveColor);

    // Preview what tapping Blend would produce: the live color mixed with
    // whatever is currently collected (or just the live color if nothing
    // has been collected yet this round).
    const blendPreview = state.collectedColor
      ? blendColors(state.liveColor, state.collectedColor)
      : state.liveColor;
    els.blendBtn.style.background = rgbToCss(blendPreview);
    els.blendBtn.style.color = contrastingTextColor(blendPreview);
  }

  function renderCollected() {
    if (state.collectedColor) {
      els.collectedHalf.style.background = rgbToCss(state.collectedColor);
      els.collectedHalf.style.color = contrastingTextColor(state.collectedColor);
    } else {
      els.collectedHalf.style.background = '';
      els.collectedHalf.style.color = '';
    }
  }

  function renderStats() {
    els.statAttempts.textContent = state.attempts;
  }

  // ---------- Game flow ----------

  function newRound() {
    state.target = randomColor();
    state.attempts = 0;
    state.collectedColor = null;
    renderTarget();
    renderCollected();
    renderLiveColor();
    renderStats();
    els.winOverlay.hidden = true;
  }

  function commitCollectedColor(nextColor, triggerEl) {
    if (!state.liveColor || els.winOverlay.hidden === false) return;
    state.collectedColor = nextColor;
    state.attempts++;
    stats.totalAttempts++;
    renderCollected();
    renderLiveColor();
    renderStats();

    const dist = colorDistance(state.collectedColor, state.target);
    const threshold = DIFFICULTY_THRESHOLDS[state.difficulty];

    if (dist <= threshold) {
      onRoundWon();
    } else {
      triggerEl.animate(
        [{ filter: 'brightness(1)' }, { filter: 'brightness(0.7)' }, { filter: 'brightness(1)' }],
        { duration: 220 }
      );
    }
  }

  function collect() {
    commitCollectedColor(state.liveColor, els.collectBtn);
  }

  function blend() {
    if (!state.liveColor) return;
    const next = state.collectedColor
      ? blendColors(state.liveColor, state.collectedColor)
      : state.liveColor;
    commitCollectedColor(next, els.blendBtn);
  }

  function onRoundWon() {
    stats.roundsWon++;
    const isNewBest = stats.bestAttempts === null || state.attempts < stats.bestAttempts;
    if (isNewBest) stats.bestAttempts = state.attempts;
    saveStats();
    renderStats();

    els.winAttempts.textContent = state.attempts;
    els.winBest.textContent = isNewBest
      ? '🏆 New best score!'
      : `Best so far: ${stats.bestAttempts} ${stats.bestAttempts === 1 ? 'try' : 'tries'}`;
    els.winOverlay.hidden = false;
  }

  // ---------- Screen transitions ----------

  async function goToGame() {
    els.startError.hidden = true;
    try {
      await startCamera();
    } catch (err) {
      els.startError.textContent = err && err.message
        ? `Couldn't access the camera: ${err.message}`
        : 'Couldn\'t access the camera. Please allow camera permission and try again.';
      els.startError.hidden = false;
      return;
    }

    els.screenStart.hidden = true;
    els.screenGame.hidden = false;

    newRound();

    state.sampleTimer = setInterval(sampleFrame, SAMPLE_INTERVAL_MS);
  }

  function goToStart() {
    if (state.sampleTimer) {
      clearInterval(state.sampleTimer);
      state.sampleTimer = null;
    }
    stopCamera();
    state.liveColor = null;
    newRound();
    els.screenGame.hidden = true;
    els.screenStart.hidden = false;
  }

  // ---------- Wire up events ----------

  els.btnStart.addEventListener('click', goToGame);
  els.btnQuit.addEventListener('click', goToStart);
  els.collectBtn.addEventListener('click', collect);
  els.blendBtn.addEventListener('click', blend);
  els.btnNext.addEventListener('click', newRound);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.stream) {
      state.stream.getTracks().forEach((t) => (t.enabled = false));
    } else if (!document.hidden && state.stream) {
      state.stream.getTracks().forEach((t) => (t.enabled = true));
    }
  });
})();
