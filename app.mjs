// Wink Wink — wink-controlled rhythm game. Greybox v1.
const $ = (id) => document.getElementById(id);
const video = $('cam'), canvas = $('scene'), ctx = canvas.getContext('2d');
const W = 390; let H = 693, DPR = 1;
const BPM = 88, BEAT = 60 / BPM, SONG = 15, LEAD = 1.8;
const PERFECT = 0.15, GOOD = 0.3;
const LANE_X = [W * 0.28, W * 0.72], HIT_Y = 0.74;

let mode = 'idle'; // idle | setup | countdown | playing | result
let practice = false, bothMode = false;
let notes = [], effects = [], startAt = 0, songTime = 0;
let stats = { perfect: 0, good: 0, miss: 0, combo: 0, maxCombo: 0, score: 0 };
let landmarker = null, stream = null, lastVideoTime = -1;
let eye = { L: false, R: false, both: false, pendingAt: 0, armed: true };
let calib = { L: false, R: false, startedAt: 0 };
let faceBest = null, faceWorst = null, confetti = [], confettiAt = 0;
let audioCtx = null, schedulerId = 0, nextBeat = 0, beatIndex = 0;

// ---------- people (one walk image + reaction images per character) ----------
const PEOPLE = [{ walk: 'assets/people/p01-walk.png', good: 'assets/people/p01-good.png', down: 'assets/people/p01-down.png' }];
const IMG = {};
function loadImg(src) { if (IMG[src]) return IMG[src]; const i = new Image(); i.src = src; IMG[src] = i; return i; }
PEOPLE.forEach((p) => Object.values(p).forEach(loadImg));
const ready = (src) => { const i = IMG[src]; return i && i.complete && i.naturalWidth > 0; };
const PERSON_H = 170;
function sprite(src, x, baseY, opts = {}) {
  const img = loadImg(src); if (!ready(src)) return false;
  const h = PERSON_H * (opts.scale || 1), w = h * img.naturalWidth / img.naturalHeight;
  ctx.save(); ctx.translate(x, baseY); ctx.rotate(opts.rot || 0); ctx.globalAlpha = opts.alpha ?? 1;
  ctx.drawImage(img, -w / 2, -h, w, h); ctx.restore(); return true;
}

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
const MELODY = [523, 659, 784, 659, 587, 523, 659, 0, 523, 784, 880, 784, 659, 587, 523, 0];
function scheduleBeats() {
  const now = audioCtx.currentTime;
  while (nextBeat < now + 0.25) {
    const i = beatIndex;
    tone(150, nextBeat, 0.18, 'sine', 0.5, 45);                 // kick
    noise(nextBeat + BEAT / 2, 0.05);                             // hat
    if (i % 2 === 1) noise(nextBeat, 0.12, 0.12);                 // snare-ish
    tone(BASS[i % 8], nextBeat, BEAT * 0.9, 'square', 0.06);      // bass
    const m = MELODY[i % 16]; if (m) tone(m, nextBeat, 0.25, 'triangle', 0.07); const m2 = MELODY[(i * 2 + 1) % 16]; if (m2 && i % 2) tone(m2 * 0.5, nextBeat + BEAT / 2, 0.18, 'triangle', 0.04);
    nextBeat += BEAT; beatIndex++;
  }
  schedulerId = setTimeout(scheduleBeats, 60);
}
function sfx(kind) {
  if (!audioCtx) return; const t = audioCtx.currentTime;
  if (kind === 'perfect') { [784, 988, 1319, 1568].forEach((f, i) => tone(f, t + i * 0.05, 0.22, 'triangle', 0.18)); tone(1200, t + 0.2, 0.5, 'sine', 0.12, 300); } // sparkle + swoon slide
  if (kind === 'good') { tone(600, t, 0.08, 'triangle', 0.2, 900); tone(900, t + 0.06, 0.12, 'sine', 0.12); }                            // pop
  if (kind === 'miss') { tone(220, t, 0.18, 'sawtooth', 0.1, 160); tone(160, t + 0.16, 0.25, 'sawtooth', 0.08, 90); }                    // womp womp
  if (kind === 'count') tone(660, t, 0.1, 'square', 0.12);
  if (kind === 'go') tone(990, t, 0.3, 'square', 0.14);
  if (kind === 'win') [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.12, 0.4, 'triangle', 0.16));
}

// ---------- chart ----------
function makeChart() {
  const list = []; let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const beats = Math.floor(SONG / BEAT);
  let lane = 0, lastDouble = -9;
  for (let b = 2; b < beats - 1; b++) {
    const t = b * BEAT;
    if (b % 8 === 7) { list.push({ t, lane: 2 }); continue; }                       // a couple every 8 beats: both eyes
    if (b >= 12 && b - lastDouble > 3 && rnd() < 0.3) {                             // an occasional quick pair, late in the round
      lastDouble = b; list.push({ t, lane }); lane = 1 - lane; list.push({ t: t + BEAT / 2, lane }); lane = 1 - lane; continue;
    }
    if (rnd() < 0.65) lane = 1 - lane;
    list.push({ t, lane });
  }
  return list.map((n, i) => ({ ...n, id: i, hit: null, who: i % PEOPLE.length, who2: (i + 1) % PEOPLE.length }));
}

// ---------- flow ----------
function show(id, on = true) { $(id).classList.toggle('hidden', !on); }
function setMode(m) { mode = m; $('phone').classList.toggle('setup', m === 'setup'); show('startPanel', m === 'idle'); show('setupPanel', m === 'setup'); show('hud', ['playing', 'countdown', 'setup', 'howto'].includes(m)); show('resultPanel', m === 'result'); show('countdown', m === 'countdown'); show('howto', m === 'howto'); }

$('play').onclick = () => { ensureAudio(); practice = false; startSetup(); };
$('practice').onclick = () => { ensureAudio(); practice = true; bothMode = false; stopCamera(); beginCountdown(); };
$('startRound').onclick = () => beginCountdown();
$('bothMode').onclick = () => { bothMode = true; beginCountdown(); };
$('replay').onclick = () => beginCountdown();
$('home').onclick = () => { clearTimeout(beginCountdown.t); stopCamera(); setMode('idle'); };

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
  ensureAudio(); setMode('howto');
  clearTimeout(beginCountdown.t); beginCountdown.t = setTimeout(startCountdown, 2000);
}
function startCountdown() {
  notes = makeChart(); effects = []; faceBest = faceWorst = null; confetti = [];
  stats = { perfect: 0, good: 0, miss: 0, combo: 0, maxCombo: 0, score: 0 }; updateHud();
  setMode('countdown'); let n = 3; $('countdown').textContent = n; sfx('count');
  const iv = setInterval(() => { n--; if (n > 0) { $('countdown').textContent = n; sfx('count'); } else { clearInterval(iv); $('countdown').textContent = ''; sfx('go'); startRound(); } }, 700);
}
function startRound() {
  setMode('playing'); startAt = audioCtx.currentTime + 0.1; nextBeat = startAt; beatIndex = 0; clearTimeout(schedulerId); scheduleBeats();
}
function endRound() {
  clearTimeout(schedulerId); setMode('result'); sfx('win');
  const total = notes.length, hits = stats.perfect + stats.good, acc = total ? Math.round(hits / total * 100) : 0;
  $('rAcc').textContent = acc + '%'; $('rCombo').textContent = stats.maxCombo; $('rDown').textContent = hits; confetti = Array.from({ length: 90 }, () => ({ x: Math.random() * W, y: -Math.random() * H, vx: (Math.random() - .5) * 40, vy: 80 + Math.random() * 120, r: 4 + Math.random() * 5, c: ['#ff5c8a', '#ffb3c8', '#b58cff', '#ffe052', '#fff7fb'][Math.floor(Math.random() * 5)], a: Math.random() * TAU })); confettiAt = performance.now();
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

// eye state machine. Wink = one eye clearly more closed than the other; both = both closed together.
// Scores are smoothed a little; thresholds are relative so people with "lazy" winks still register.
let smL = 0, smR = 0, faceAt = 0;
function handleEyes(rawL, rawR) {
  faceAt = performance.now();
  smL += (rawL - smL) * 0.5; smR += (rawR - smR) * 0.5;
  const l = smL, r = smR;
  const both = l > 0.38 && r > 0.38 && Math.abs(l - r) < 0.3;
  const L = !both && l > 0.3 && l - r > 0.18;
  const R = !both && r > 0.3 && r - l > 0.18;
  $('eyeL').classList.toggle('on', L || both); $('eyeR').classList.toggle('on', R || both);
  if (mode === 'setup') { $('setupTitle').textContent = 'Wink at me.'; $('setupText').textContent = `left ${l.toFixed(2)} · right ${r.toFixed(2)} — close one eye at a time, keep the other open.`; }
  const now = performance.now();
  const closed = L || R || both;
  if (!closed) { eye.armed = true; eye.pendingAt = 0; eye.L = eye.R = false; eye.both = false; return; }
  if (!eye.armed) return;
  if (!eye.pendingAt) eye.pendingAt = now;
  eye.L = eye.L || L; eye.R = eye.R || R; eye.both = eye.both || both;
  if (now - eye.pendingAt >= 70) {
    eye.armed = false;
    const isBoth = eye.both || (eye.L && eye.R);
    if (mode === 'setup') { if (!isBoth && eye.L) { calib.L = true; $('calL').classList.add('ok'); } if (!isBoth && eye.R) { calib.R = true; $('calR').classList.add('ok'); } if (calib.L && calib.R) show('startRound'); }
    else if (mode === 'playing') fire(bothMode ? 2 : isBoth ? 2 : eye.L ? 0 : 1);
    eye.L = eye.R = false; eye.both = false;
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
  if (mode === 'result' && confetti.length) { const dt = (performance.now() - confettiAt) / 1000; for (const c of confetti) { const y = c.y + c.vy * dt, x = c.x + c.vx * dt + Math.sin(dt * 3 + c.a) * 12; if (y > H + 10) continue; ctx.save(); ctx.translate(x, y); ctx.rotate(c.a + dt * 4); ctx.fillStyle = c.c; ctx.fillRect(-c.r / 2, -c.r, c.r, c.r * 2); ctx.restore(); } return; }
  if (!['playing', 'countdown', 'howto'].includes(mode)) return;
  // lanes
  ctx.fillStyle = 'rgba(26,15,46,.22)'; ctx.fillRect(0, 0, W, H);
  for (const x of LANE_X) { ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 2; ctx.setLineDash([6, 10]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.setLineDash([]); }
  // judge targets
  const hy = H * HIT_Y;
  for (const x of LANE_X) { ctx.beginPath(); ctx.arc(x, hy, 34, 0, TAU); ctx.strokeStyle = '#ffb3c8'; ctx.lineWidth = 4; ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = '700 11px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('LEFT EYE', LANE_X[0], hy + 56); ctx.fillText('RIGHT EYE', LANE_X[1], hy + 56);
  if (mode !== 'playing') return;
  ctx.font = '44px system-ui'; ctx.textBaseline = 'middle';
  const walkAnim = (n, k) => { const step = songTime * 7 + n.id; return { rot: Math.sin(step) * 0.06, bob: Math.abs(Math.sin(step)) * 8, scale: 0.72 + 0.28 * k }; };
  const drawWalker = (n, x, y, k, alpha = 1) => { const a = walkAnim(n, k); if (!sprite(PEOPLE[n.who].walk, x, y + 70 - a.bob, { rot: a.rot, scale: a.scale, alpha })) { ctx.globalAlpha = alpha; ctx.fillText(n.lane === 1 ? '😐' : '🙂', x, y); ctx.globalAlpha = 1; } };
  for (const n of notes) {
    const dt = n.t - songTime; if (dt > LEAD || dt < -1.1) continue;
    const k = 1 - dt / LEAD, y = hy - (dt / LEAD) * (hy + 60);
    const lanes = n.lane === 2 ? [0, 1] : [n.lane];
    if (n.hit === 'miss') { const m = Math.min(1, (songTime - n.t) / 0.7); for (const l of lanes) drawWalker(n, LANE_X[l], hy + m * 120, 1, 1 - m); continue; }
    if (n.hit) {
      const m = Math.min(1, (songTime - n.hitAt) / 0.8);
      for (const l of lanes) {
        const x = LANE_X[l], dir = l === 0 ? -1 : 1;
        if (n.hit === 'perfect') { // swoon and topple sideways, face to the floor
          const rot = dir * Math.min(1, m * 1.6) * Math.PI / 2;
          if (!sprite(PEOPLE[n.who].down, x + dir * m * 26, hy + 70 + m * 10, { rot, alpha: 1 - Math.max(0, m - 0.75) * 4 })) { ctx.globalAlpha = 1 - m; ctx.fillText('😍', x, hy - m * 60); ctx.globalAlpha = 1; }
        } else { // good: blush, wobble, fade
          if (!sprite(PEOPLE[n.who].good, x, hy + 70, { rot: Math.sin(m * 12) * 0.08 * (1 - m), alpha: 1 - Math.max(0, m - 0.5) * 2 })) { ctx.globalAlpha = 1 - m; ctx.fillText('☺️', x, hy - m * 40); ctx.globalAlpha = 1; }
        }
      }
      continue;
    }
    if (n.lane === 2) { ctx.fillStyle = 'rgba(181,140,255,.22)'; roundRect(LANE_X[0] - 60, y - 40, LANE_X[1] - LANE_X[0] + 120, 110, 40); ctx.fill(); }
    for (const l of lanes) drawWalker(n, LANE_X[l], y, k);
  }
  // hearts and sparks
  for (const e of effects) {
    const k = (songTime - e.at) / 0.7; if (k > 1) continue;
    const xs = e.lane === 2 ? LANE_X : [LANE_X[e.lane]];
    for (const x of xs) {
      ctx.globalAlpha = 1 - k;
      if (e.kind === 'miss') { ctx.font = '36px system-ui'; ctx.fillText('💢', x + 40, hy - 100 - k * 40); }
      else { const n = e.kind === 'perfect' ? 7 : 3; for (let i = 0; i < n; i++) { const a = i * TAU / n + k * 2 + e.at; ctx.font = (14 + (i % 3) * 6) + 'px system-ui'; ctx.fillText('💗', x + Math.cos(a) * (30 + k * 80), hy - 60 - k * 120 + Math.sin(a) * 20); } }
      ctx.globalAlpha = 1;
    }
  }
  effects = effects.filter((e) => songTime - e.at < 0.7);
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
      else if (mode === 'setup' && performance.now() - faceAt > 600) { $('setupTitle').textContent = 'Looking for your face…'; $('setupText').textContent = 'Hold the phone at arm\'s length, face in the middle.'; $('eyeL').classList.remove('on'); $('eyeR').classList.remove('on'); }
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
