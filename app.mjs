// Wink Wink — wink-controlled rhythm game. Greybox v1.
const $ = (id) => document.getElementById(id);
const video = $('cam'), canvas = $('scene'), ctx = canvas.getContext('2d');
const W = 390; let H = 693, DPR = 1;
const BPM = 100, BEAT = 60 / BPM, SONG = 20, LEAD = 1.7;
const PERFECT = 0.15, GOOD = 0.3;
const LANE_X = [W * 0.28, W * 0.72], HIT_Y = 0.74;

let mode = 'idle'; // idle | setup | countdown | playing | result
let practice = false, bothMode = false;
let notes = [], effects = [], startAt = 0, songTime = 0;
let stats = { perfect: 0, good: 0, miss: 0, combo: 0, maxCombo: 0, score: 0 };
let landmarker = null, stream = null, lastVideoTime = -1;
let eye = { L: false, R: false, pendingAt: 0, armed: true };
let calib = { L: false, R: false, startedAt: 0 };
let faceBest = null, faceWorst = null;
let audioCtx = null, schedulerId = 0, nextBeat = 0, beatIndex = 0;

// ---------- sizing ----------
function resize() {
  const r = $('phone').getBoundingClientRect();
  DPR = Math.min(2, window.devicePixelRatio || 1);
  H = Math.round(W * r.height / r.width);
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize); resize();

// ---------- audio (synthesized) ----------
function ensureAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); }
function tone(freq, t, dur, type = 'sine', gain = 0.2, slide = 0) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + dur + 0.02);
}
function noise(t, dur, gain = 0.08) {
  const b = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const s = audioCtx.createBufferSource(), g = audioCtx.createGain(), f = audioCtx.createBiquadFilter();
  f.type = 'highpass'; f.frequency.value = 6000; s.buffer = b; g.gain.value = gain;
  s.connect(f).connect(g).connect(audioCtx.destination); s.start(t);
}
const BASS = [55, 55, 82, 73, 55, 55, 98, 82];
function scheduleBeats() {
  const now = audioCtx.currentTime;
  while (nextBeat < now + 0.25) {
    const i = beatIndex;
    tone(150, nextBeat, 0.18, 'sine', 0.5, 45);                 // kick
    noise(nextBeat + BEAT / 2, 0.05);                             // hat
    if (i % 2 === 1) noise(nextBeat, 0.12, 0.12);                 // snare-ish
    tone(BASS[i % 8], nextBeat, BEAT * 0.9, 'square', 0.06);      // bass
    if (i % 4 === 0) tone(523 * (i % 8 === 0 ? 1 : 1.25), nextBeat, 0.3, 'triangle', 0.08);
    nextBeat += BEAT; beatIndex++;
  }
  schedulerId = setTimeout(scheduleBeats, 60);
}
function sfx(kind) {
  if (!audioCtx) return; const t = audioCtx.currentTime;
  if (kind === 'perfect') { tone(880, t, 0.12, 'triangle', 0.25); tone(1320, t + 0.06, 0.16, 'triangle', 0.2); }
  if (kind === 'good') tone(660, t, 0.12, 'triangle', 0.2);
  if (kind === 'miss') tone(200, t, 0.25, 'sawtooth', 0.12, 120);
  if (kind === 'count') tone(660, t, 0.1, 'square', 0.12);
  if (kind === 'go') tone(990, t, 0.3, 'square', 0.14);
}

// ---------- chart ----------
function makeChart() {
  const list = []; let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const beats = Math.floor(SONG / BEAT);
  let lane = 0;
  for (let b = 2; b < beats - 1; b++) {
    const t = b * BEAT;
    if (b % 8 === 7) { list.push({ t, lane: 2 }); continue; }           // both eyes on the 8th beat
    if (b >= 16 && b % 2 === 0 && rnd() < 0.5) {                        // some off-beats later on
      list.push({ t, lane }); lane = 1 - lane; list.push({ t: t + BEAT / 2, lane }); lane = 1 - lane; continue;
    }
    if (rnd() < 0.7) { lane = 1 - lane; }
    list.push({ t, lane });
  }
  return list.map((n, i) => ({ ...n, id: i, hit: null }));
}

// ---------- flow ----------
function show(id, on = true) { $(id).classList.toggle('hidden', !on); }
function setMode(m) { mode = m; show('startPanel', m === 'idle'); show('setupPanel', m === 'setup'); show('hud', m === 'playing' || m === 'countdown'); show('resultPanel', m === 'result'); show('countdown', m === 'countdown'); }

$('play').onclick = () => { ensureAudio(); practice = false; startSetup(); };
$('practice').onclick = () => { ensureAudio(); practice = true; bothMode = false; stopCamera(); beginCountdown(); };
$('startRound').onclick = () => beginCountdown();
$('bothMode').onclick = () => { bothMode = true; beginCountdown(); };
$('replay').onclick = () => beginCountdown();
$('home').onclick = () => { stopCamera(); setMode('idle'); };

async function startSetup() {
  setMode('setup'); show('calib', false); show('startRound', false); show('bothMode', false);
  $('setupKicker').textContent = 'CAMERA'; $('setupTitle').textContent = 'Loading the face tracker…'; $('setupText').textContent = 'One second.';
  try {
    await Promise.all([loadLandmarker(), startCamera()]);
  } catch (e) {
    $('setupTitle').textContent = 'Camera blocked'; $('setupText').textContent = 'Allow the camera in your browser, then reload. Or try tap practice.'; return;
  }
  $('setupKicker').textContent = 'QUICK CHECK'; $('setupTitle').textContent = 'Wink at me.'; $('setupText').textContent = 'Close one eye at a time. Keep the other open.';
  calib = { L: false, R: false, startedAt: performance.now() }; $('calL').classList.remove('ok'); $('calR').classList.remove('ok');
  show('calib'); bothMode = false;
  setTimeout(() => { if (mode === 'setup' && !(calib.L && calib.R)) show('bothMode'); }, 6000);
}
async function loadLandmarker() {
  if (landmarker) return;
  const { FilesetResolver, FaceLandmarker } = await import('./vendor/vision_bundle.mjs');
  const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
  landmarker = await FaceLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: './vendor/face_landmarker.task' }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true });
}
async function startCamera() {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 1280 } }, audio: false });
  video.srcObject = stream; await video.play();
}
function stopCamera() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; video.srcObject = null; } }

function beginCountdown() {
  ensureAudio(); notes = makeChart(); effects = []; faceBest = faceWorst = null;
  stats = { perfect: 0, good: 0, miss: 0, combo: 0, maxCombo: 0, score: 0 }; updateHud();
  setMode('countdown'); let n = 3; $('countdown').textContent = n; sfx('count');
  const iv = setInterval(() => { n--; if (n > 0) { $('countdown').textContent = n; sfx('count'); } else { clearInterval(iv); $('countdown').textContent = ''; sfx('go'); startRound(); } }, 700);
}
function startRound() {
  setMode('playing'); startAt = audioCtx.currentTime + 0.1; nextBeat = startAt; beatIndex = 0; clearTimeout(schedulerId); scheduleBeats();
}
function endRound() {
  clearTimeout(schedulerId); setMode('result');
  const total = notes.length, hits = stats.perfect + stats.good, acc = total ? Math.round(hits / total * 100) : 0;
  $('rAcc').textContent = acc + '%'; $('rCombo').textContent = stats.maxCombo; $('rDown').textContent = stats.perfect;
  const title = acc >= 90 ? 'Heartbreaker' : acc >= 70 ? 'Smooth operator' : acc >= 40 ? 'Still trying' : 'Someone called security';
  $('resultTitle').textContent = title;
  paintFace($('faceBest'), faceBest); paintFace($('faceWorst'), faceWorst);
}

// ---------- input ----------
function fire(lane) {
  if (mode !== 'playing') return;
  const t = songTime; let best = null, bestD = GOOD + 1e-9;
  for (const n of notes) {
    if (n.hit) continue;
    if (!bothMode && !(n.lane === lane || (n.lane === 2 && lane === 2))) continue;
    if (!bothMode && n.lane === 2 && lane !== 2) continue;
    const d = Math.abs(n.t - t); if (d < bestD) { bestD = d; best = n; }
  }
  if (!best) return;
  const grade = bestD <= PERFECT ? 'perfect' : 'good';
  best.hit = grade; best.hitAt = t;
  stats[grade]++; stats.combo++; stats.maxCombo = Math.max(stats.maxCombo, stats.combo); stats.score += grade === 'perfect' ? 100 : 60;
  effects.push({ kind: grade, lane: best.lane, at: t });
  judge(grade === 'perfect' ? 'PERFECT' : 'GOOD'); sfx(grade);
  if (grade === 'perfect' && (!faceBest || Math.random() < 0.4)) faceBest = grabFace();
  updateHud();
}
function missNote(n) { n.hit = 'miss'; stats.miss++; stats.combo = 0; effects.push({ kind: 'miss', lane: n.lane, at: songTime }); judge('MISS'); sfx('miss'); if (!faceWorst || Math.random() < 0.5) faceWorst = grabFace(); updateHud(); }
let judgeTimer = 0;
function judge(text) { const j = $('judge'); j.textContent = text; j.classList.add('show'); clearTimeout(judgeTimer); judgeTimer = setTimeout(() => j.classList.remove('show'), 350); }
function updateHud() { $('score').textContent = stats.score; $('combo').textContent = stats.combo; }

// eye state machine: classify a closure ~70 ms after it starts so double blinks read as "both"
function handleEyes(l, r) {
  const L = l > 0.5, R = r > 0.5;
  $('eyeL').classList.toggle('on', L); $('eyeR').classList.toggle('on', R);
  const now = performance.now();
  if (!L && !R) { eye.armed = true; eye.pendingAt = 0; eye.L = eye.R = false; return; }
  if (!eye.armed) return;
  if (!eye.pendingAt) eye.pendingAt = now;
  eye.L = eye.L || L; eye.R = eye.R || R;
  if (now - eye.pendingAt >= 70) {
    eye.armed = false;
    const both = eye.L && eye.R;
    if (mode === 'setup') { if (!both && eye.L) { calib.L = true; $('calL').classList.add('ok'); } if (!both && eye.R) { calib.R = true; $('calR').classList.add('ok'); } if (calib.L && calib.R) show('startRound'); }
    else if (mode === 'playing') fire(bothMode ? 2 : both ? 2 : eye.L ? 0 : 1);
    eye.L = eye.R = false;
  }
}
// tap practice: left third = left eye, right third = right eye, middle = both
$('phone').addEventListener('pointerdown', (e) => {
  if (!practice || mode !== 'playing') return;
  const r = $('phone').getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
  const lane = x < 0.38 ? 0 : x > 0.62 ? 1 : 2;
  $('eyeL').classList.toggle('on', lane !== 1); $('eyeR').classList.toggle('on', lane !== 0);
  setTimeout(() => { $('eyeL').classList.remove('on'); $('eyeR').classList.remove('on'); }, 120);
  fire(lane);
});

// ---------- face capture ----------
function grabFace() {
  if (!stream || video.readyState < 2) return null;
  const c = document.createElement('canvas'); c.width = 160; c.height = 200; const g = c.getContext('2d');
  const vw = video.videoWidth, vh = video.videoHeight, cw = vw * 0.5, ch = cw * 1.25, sx = (vw - cw) / 2, sy = Math.max(0, vh * 0.42 - ch / 2);
  g.translate(160, 0); g.scale(-1, 1); g.drawImage(video, sx, sy, cw, ch, 0, 0, 160, 200); return c;
}
function paintFace(target, src) {
  const g = target.getContext('2d'); g.clearRect(0, 0, 160, 200);
  if (src) g.drawImage(src, 0, 0); else { g.fillStyle = '#f3e8ff'; g.fillRect(0, 0, 160, 200); g.font = '64px system-ui'; g.textAlign = 'center'; g.fillText(practice ? '😉' : '🫥', 80, 120); }
}

// ---------- render ----------
const TAU = Math.PI * 2;
function draw() {
  ctx.clearRect(0, 0, W, H);
  if (mode !== 'playing' && mode !== 'countdown' && mode !== 'result') return;
  // lanes
  ctx.fillStyle = 'rgba(26,15,46,.22)'; ctx.fillRect(0, 0, W, H);
  for (const x of LANE_X) { ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 2; ctx.setLineDash([6, 10]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.setLineDash([]); }
  // judge targets
  const hy = H * HIT_Y;
  for (const x of LANE_X) { ctx.beginPath(); ctx.arc(x, hy, 34, 0, TAU); ctx.strokeStyle = '#ffb3c8'; ctx.lineWidth = 4; ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = '700 11px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('LEFT EYE', LANE_X[0], hy + 56); ctx.fillText('RIGHT EYE', LANE_X[1], hy + 56);
  if (mode !== 'playing') return;
  // notes
  ctx.font = '44px system-ui'; ctx.textBaseline = 'middle';
  for (const n of notes) {
    const dt = n.t - songTime; if (dt > LEAD || dt < -0.5) continue;
    const y = hy - (dt / LEAD) * (hy + 40);
    if (n.hit === 'miss') { const k = Math.min(1, (songTime - n.t) / 0.4); const x = n.lane === 2 ? W / 2 : LANE_X[n.lane]; ctx.globalAlpha = 1 - k; ctx.fillText('🙄', x + (n.lane === 1 ? 1 : -1) * k * 60, y); ctx.globalAlpha = 1; continue; }
    if (n.hit) continue;
    if (n.lane === 2) { ctx.fillStyle = 'rgba(181,140,255,.35)'; roundRect(LANE_X[0] - 40, y - 30, LANE_X[1] - LANE_X[0] + 80, 60, 30); ctx.fill(); ctx.fillText('👫', W / 2, y); }
    else ctx.fillText(n.lane === 0 ? '🙂' : '😐', LANE_X[n.lane], y);
  }
  // effects
  for (const e of effects) {
    const k = (songTime - e.at) / 0.6; if (k > 1) continue;
    const x = e.lane === 2 ? W / 2 : LANE_X[e.lane];
    ctx.globalAlpha = 1 - k; ctx.font = (44 + k * 30) + 'px system-ui';
    ctx.fillText(e.kind === 'miss' ? '💢' : e.kind === 'perfect' ? '😍' : '☺️', x, hy - k * 90);
    if (e.kind === 'perfect') for (let i = 0; i < 4; i++) { const a = i * TAU / 4 + k * 3; ctx.font = '18px system-ui'; ctx.fillText('💗', x + Math.cos(a) * (40 + k * 60), hy + Math.sin(a) * (30 + k * 40)); }
    ctx.globalAlpha = 1;
  }
  effects = effects.filter((e) => songTime - e.at < 0.6);
  ctx.textBaseline = 'alphabetic';
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

// ---------- loop ----------
function loop() {
  requestAnimationFrame(loop);
  if (landmarker && stream && video.readyState >= 2 && video.currentTime !== lastVideoTime && (mode === 'setup' || mode === 'playing' || mode === 'countdown')) {
    lastVideoTime = video.currentTime;
    try {
      const res = landmarker.detectForVideo(video, performance.now());
      const bs = res.faceBlendshapes && res.faceBlendshapes[0];
      if (bs) { const get = (name) => (bs.categories.find((c) => c.categoryName === name) || {}).score || 0; handleEyes(get('eyeBlinkLeft'), get('eyeBlinkRight')); }
    } catch (e) { /* skip frame */ }
  }
  if (mode === 'playing') {
    songTime = audioCtx.currentTime - startAt;
    for (const n of notes) if (!n.hit && songTime - n.t > GOOD) missNote(n);
    $('time').textContent = Math.max(0, Math.ceil(SONG - songTime));
    if (songTime > SONG + 0.6) endRound();
  }
  draw();
}
setMode('idle'); loop();
