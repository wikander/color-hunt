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

  // A modest palette of everyday color names, used only to give kids a
  // friendly label next to each swatch (nearest-neighbor by RGB distance).
  const NAMED_COLORS = [
    ['Red', [220, 20, 60]], ['Orange', [255, 140, 0]], ['Yellow', [255, 215, 0]],
    ['Lime', [180, 220, 40]], ['Green', [34, 139, 34]], ['Teal', [0, 150, 140]],
    ['Cyan', [0, 200, 220]], ['Sky Blue', [80, 170, 230]], ['Blue', [30, 80, 210]],
    ['Purple', [130, 60, 200]], ['Magenta', [220, 40, 190]], ['Pink', [255, 130, 180]],
    ['Brown', [140, 90, 50]], ['Beige', [230, 210, 170]], ['White', [245, 245, 245]],
    ['Gray', [130, 130, 130]], ['Black', [20, 20, 20]],
  ];

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
    targetName: document.getElementById('target-name'),
    liveThird: document.getElementById('live-third'),
    liveName: document.getElementById('live-name'),

    collectedHalf: document.getElementById('collected-half'),
    collectedName: document.getElementById('collected-name'),

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

  function nearestColorName({ r, g, b }) {
    let best = null;
    let bestDist = Infinity;
    for (const [name, [nr, ng, nb]] of NAMED_COLORS) {
      const d = (r - nr) ** 2 + (g - ng) ** 2 + (b - nb) ** 2;
      if (d < bestDist) { bestDist = d; best = name; }
    }
    return best;
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
    els.targetName.textContent = nearestColorName(state.target);
  }

  function renderLiveColor() {
    if (!state.liveColor) return;
    els.liveThird.style.background = rgbToCss(state.liveColor);
    els.liveThird.style.color = contrastingTextColor(state.liveColor);
    els.liveName.textContent = nearestColorName(state.liveColor);
  }

  function renderCollected() {
    if (state.collectedColor) {
      els.collectedHalf.style.background = rgbToCss(state.collectedColor);
      els.collectedHalf.style.color = contrastingTextColor(state.collectedColor);
      els.collectedName.textContent = nearestColorName(state.collectedColor);
    } else {
      els.collectedHalf.style.background = '';
      els.collectedHalf.style.color = '';
      els.collectedName.textContent = '—';
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
    renderStats();
    els.winOverlay.hidden = true;
  }

  function capture() {
    if (!state.liveColor || els.winOverlay.hidden === false) return;
    state.collectedColor = state.liveColor;
    state.attempts++;
    stats.totalAttempts++;
    renderCollected();
    renderStats();

    const dist = colorDistance(state.collectedColor, state.target);
    const threshold = DIFFICULTY_THRESHOLDS[state.difficulty];

    if (dist <= threshold) {
      onRoundWon();
    } else {
      els.liveThird.animate(
        [{ filter: 'brightness(1)' }, { filter: 'brightness(0.7)' }, { filter: 'brightness(1)' }],
        { duration: 220 }
      );
    }
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
  els.liveThird.addEventListener('click', capture);
  els.btnNext.addEventListener('click', newRound);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.stream) {
      state.stream.getTracks().forEach((t) => (t.enabled = false));
    } else if (!document.hidden && state.stream) {
      state.stream.getTracks().forEach((t) => (t.enabled = true));
    }
  });
})();
