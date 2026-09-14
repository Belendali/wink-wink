// Wink Wink — wink-controlled rhythm game. Greybox v1.
const $ = (id) => document.getElementById(id);
const video = $('cam'), canvas = $('scene'), ctx = canvas.getContext('2d');
const W = 390; let H = 693, DPR = 1;
const BPM = 88, BEAT = 60 / BPM, SONG = 15, LEAD = 1.8;
const PERFECT = 0.15, GOOD = 0.3;
const LANE_X = [W * 0.28, W * 0.72], HIT_Y = 0.68; // judge line: a whole character at the hit moment stays inside the visual zone (y ≤ 545/694)

let mode = 'idle'; // idle | setup | countdown | playing | result
let practice = false, bothMode = false;
let notes = [], effects = [], startAt = 0, songTime = 0;
let stats = { perfect: 0, good: 0, miss: 0, combo: 0, maxCombo: 0, score: 0 };
let landmarker = null, stream = null, lastVideoTime = -1;
let eye = { L: false, R: false, both: false, pendingAt: 0, armed: true };
let blinkStats = { both: 0, single: 0 }; // auto fallback: only double blinks → both-eyes mode
let faceBest = null, faceWorst = null, confetti = [], confettiAt = 0, pile = [], resultAt = 0;
let audioCtx = null, schedulerId = 0, nextBeat = 0, beatIndex = 0;

// ---------- people (one walk image + reaction images per character) ----------
const PEOPLE = Array.from({ length: 10 }, (_, i) => { const n = String(i + 1).padStart(2, '0'); return { walk: `assets/people/p${n}-walk.png`, down: `assets/people/p${n}-down.png` }; });
const IMG = {};
function loadImg(src) { if (IMG[src]) return IMG[src]; const i = new Image(); i.src = src; IMG[src] = i; return i; }
PEOPLE.forEach((p) => Object.values(p).forEach(loadImg));
const ready = (src) => { const i = IMG[src]; return i && i.complete && i.naturalWidth > 0; };
const PERSON_H = 145;
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
const BASS = [55, 0, 55, 82, 0, 55, 73, 98];          // per 8th note, two beats
const CHORDS = [[262, 330, 392], [294, 349, 440], [330, 392, 494], [294, 349, 440]];
const MELODY = [523, 0, 659, 784, 0, 659, 587, 0, 523, 659, 0, 784, 880, 0, 784, 659, 587, 0, 523, 0, 659, 0, 523, 0, 587, 659, 0, 587, 523, 0, 0, 0];
function scheduleBeats() {
  const now = audioCtx.currentTime, step = BEAT / 4; // 16th notes
  while (nextBeat < now + 0.25) {
    const i = beatIndex, beat = Math.floor(i / 4), sub = i % 4, eighth = Math.floor(i / 2);
    if (sub === 0) tone(150, nextBeat, 0.16, 'sine', 0.55, 40);                        // kick on every beat
    if (sub === 0 && beat % 2 === 1) { noise(nextBeat, 0.14, 0.16); tone(180, nextBeat, 0.08, 'triangle', 0.15); } // snare on 2 and 4
    noise(nextBeat, sub % 2 ? 0.03 : 0.05, sub === 2 ? 0.09 : 0.045);                 // 16th hats, open on the offbeat
    if (sub % 2 === 0) { const bnote = BASS[eighth % 8]; if (bnote) tone(bnote, nextBeat, step * 1.6, 'square', 0.07); }
    if (sub === 2 && beat % 2 === 0) CHORDS[Math.floor(beat / 2) % 4].forEach((f) => tone(f, nextBeat, 0.12, 'sawtooth', 0.025)); // offbeat stab
    if (sub % 2 === 0) { const m = MELODY[eighth % 32]; if (m) tone(m, nextBeat, 0.22, 'triangle', 0.075); }
    nextBeat += step; beatIndex++;
  }
  schedulerId = setTimeout(scheduleBeats, 60);
}
// character voices: a cartoon "aah" shaped by age and gender
const VOICES = { youngF: { f: 620, slide: 480, wob: 7, type: 'sine', dur: 0.5 }, adultF: { f: 480, slide: 380, wob: 5, type: 'sine', dur: 0.55 }, granny: { f: 400, slide: 330, wob: 11, type: 'triangle', dur: 0.6 }, youngM: { f: 260, slide: 200, wob: 5, type: 'triangle', dur: 0.45 }, bigM: { f: 170, slide: 120, wob: 4, type: 'sawtooth', dur: 0.6 }, grandpa: { f: 210, slide: 150, wob: 12, type: 'triangle', dur: 0.65 }, kid: { f: 760, slide: 640, wob: 9, type: 'sine', dur: 0.35 } };
const CAST_VOICE = ['youngF', 'granny', 'youngM', 'bigM', 'youngF', 'adultF', 'grandpa', 'youngM', 'kid', 'youngF']; // p01..p10
function voice(who, big = false) {
  if (!audioCtx) return; const v = VOICES[CAST_VOICE[who % CAST_VOICE.length]], t = audioCtx.currentTime;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain(), lfo = audioCtx.createOscillator(), lg = audioCtx.createGain(), f = audioCtx.createBiquadFilter();
  o.type = v.type; o.frequency.setValueAtTime(v.f * (big ? 1.15 : 1), t); o.frequency.exponentialRampToValueAtTime(v.slide, t + v.dur);
  lfo.frequency.value = v.wob; lg.gain.value = v.f * 0.04; lfo.connect(lg).connect(o.frequency);
  f.type = 'lowpass'; f.frequency.value = v.f * 4;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(big ? 0.22 : 0.14, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + v.dur);
  o.connect(f).connect(g).connect(audioCtx.destination); lfo.start(t); o.start(t); o.stop(t + v.dur + 0.05); lfo.stop(t + v.dur + 0.05);
}
function sfx(kind) {
  if (!audioCtx) return; const t = audioCtx.currentTime;
  if (kind === 'perfect') { [784, 988, 1319, 1568].forEach((f, i) => tone(f, t + i * 0.05, 0.22, 'triangle', 0.18)); tone(1200, t + 0.2, 0.5, 'sine', 0.12, 300); } // sparkle + swoon slide
  if (kind === 'good') { tone(600, t, 0.08, 'triangle', 0.2, 900); tone(900, t + 0.06, 0.12, 'sine', 0.12); }                            // pop
  if (kind === 'miss') { tone(220, t, 0.18, 'sawtooth', 0.1, 160); tone(160, t + 0.16, 0.25, 'sawtooth', 0.08, 90); }                    // womp womp
  if (kind === 'count') tone(660, t, 0.1, 'square', 0.12);
  if (kind === 'land') { tone(120, t, 0.08, 'sine', 0.2, 60); noise(t, 0.04, 0.05); }
  if (kind === 'go') tone(990, t, 0.3, 'square', 0.14);
  if (kind === 'win') [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.12, 0.4, 'triangle', 0.16));
}

// ---------- chart ----------
function makeChart() {
  const list = []; let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const beats = Math.floor(SONG / BEAT);
  let lane = 0, lastDouble = -9;
  for (let b = 4; b < beats - 1; b++) {   // first pedestrian arrives ~2.7 s after GO, a full walk down
    const t = b * BEAT;
    if (b % 8 === 7) { list.push({ t, lane: 2 }); continue; }                       // a couple every 8 beats: both eyes
    if (b >= 12 && b - lastDouble > 3 && rnd() < 0.3) {                             // an occasional quick pair, late in the round
      lastDouble = b; list.push({ t, lane }); lane = 1 - lane; list.push({ t: t + BEAT / 2, lane }); lane = 1 - lane; continue;
    }
    if (rnd() < 0.65) lane = 1 - lane;
    list.push({ t, lane });
  }
  let prev = -1;
  return list.map((n, i) => { let who; do { who = Math.floor(rnd() * PEOPLE.length); } while (who === prev); prev = who; let who2 = (who + 1 + Math.floor(rnd() * (PEOPLE.length - 1))) % PEOPLE.length; return { ...n, id: i, hit: null, who, who2 }; });
}

// ---------- flow ----------
function show(id, on = true) { $(id).classList.toggle('hidden', !on); }
function setMode(m) { mode = m; $('phone').classList.toggle('setup', m === 'setup'); show('startPanel', m === 'idle'); show('setupPanel', m === 'setup'); show('hud', ['playing', 'countdown', 'setup', 'howto'].includes(m)); show('resultPanel', m === 'result'); show('countdown', m === 'countdown'); show('howto', m === 'howto'); }

$('play').onclick = () => { ensureAudio(); practice = false; $('phone').classList.remove('practice'); startSetup(); };
$('practice').onclick = () => { ensureAudio(); practice = true; $('phone').classList.add('practice'); bothMode = false; stopCamera(); beginCountdown(); };
$('startRound').onclick = () => beginCountdown();
$('bothMode').onclick = () => { bothMode = true; beginCountdown(); };
$('replay').onclick = () => showHowto();
$('home').onclick = () => { clearTimeout(beginCountdown.t); clearTimeout(endRound.t); stopCamera(); setMode('idle'); };

async function startSetup() {
  setMode('setup'); show('calib', false); show('startRound', false); show('bothMode', false);
  $('setupKicker').textContent = 'CAMERA'; $('setupTitle').textContent = 'Loading the face tracker…'; $('setupText').textContent = 'One second.';
  try {
    await Promise.all([loadLandmarker(), startCamera()]);
  } catch (e) {
    $('setupTitle').textContent = 'Camera blocked'; $('setupText').textContent = 'Allow the camera in your browser, then reload. Or try tap practice.'; return;
  }
  $('setupTitle').textContent = 'Looking for your face…'; $('setupText').textContent = 'Hold the phone at arm\'s length.';
  bothMode = false; blinkStats = { both: 0, single: 0 };
  const started = performance.now();
  const wait = setInterval(() => { if (mode !== 'setup') { clearInterval(wait); return; } if (performance.now() - faceAt < 300 || performance.now() - started > 8000) { clearInterval(wait); showHowto(); } }, 100);
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

function showHowto() {
  ensureAudio(); setMode('howto'); clearTimeout(beginCountdown.t);
  $('howtoCta').textContent = practice ? 'Starting…' : 'Blink to start';
  if (practice) beginCountdown.t = setTimeout(startCountdown, 2000);   // no camera: just wait
  // camera: the first detected blink starts the round, which also proves tracking is live
}
function beginCountdown() { showHowto(); }
function startCountdown() {
  notes = makeChart(); effects = []; faceBest = faceWorst = null; confetti = [];
  stats = { perfect: 0, good: 0, miss: 0, combo: 0, maxCombo: 0, score: 0 }; updateHud();
  setMode('countdown'); let n = 3; $('countdown').textContent = n; sfx('count');
  const iv = setInterval(() => { n--; if (n > 0) { $('countdown').textContent = n; sfx('count'); } else { clearInterval(iv); $('countdown').textContent = ''; sfx('go'); startRound(); } }, 700);
}
function startRound() {
  if (DEBUG) dlog('round start'); setMode('playing'); startAt = audioCtx.currentTime + 0.1; nextBeat = startAt; beatIndex = 0; clearTimeout(schedulerId); scheduleBeats();
}
function endRound() {
  clearTimeout(schedulerId); setMode('result'); sfx('win');
  const total = notes.length, hits = stats.perfect + stats.good, pct = total ? Math.round(hits / total * 100) : 0;
  $('rPct').textContent = pct + '%'; $('rLine').textContent = hits + ' of ' + total + ' swept off their feet';
  $('resultTitle').textContent = pct >= 90 ? 'Irresistible.' : pct >= 70 ? 'Dangerous charm.' : pct >= 40 ? 'Getting there.' : 'They called security.';
  // everyone you swept off their feet tumbles in from the top and piles up (each character once)
  pile = []; const seen = new Set();
  for (const n of notes) { if (!(n.hit === 'perfect' || n.hit === 'good')) continue; const lanes = n.lane === 2 ? [0, 1] : [n.lane]; for (const l of lanes) { const who = l === 1 && n.lane === 2 ? n.who2 : n.who; if (!seen.has(who)) seen.add(who); } }
  [...seen].forEach((who, i) => pile.push({ who, x: 60 + Math.random() * (W - 120), y: -260 - Math.random() * 160, vy: 0, vx: (Math.random() - .5) * 60, rot: (Math.random() - .5) * 0.8, spin: (Math.random() - .5) * 5, delay: 0.5 + i * 0.28, landed: false, squash: 0, scale: 0.95 }));
  show('rbtns', false); clearTimeout(endRound.t); endRound.t = setTimeout(() => show('rbtns'), 5000);
  resultAt = performance.now();
  confetti = Array.from({ length: 90 }, () => ({ x: Math.random() * W, y: -Math.random() * H, vx: (Math.random() - .5) * 40, vy: 80 + Math.random() * 120, r: 4 + Math.random() * 5, c: ['#ff5c8a', '#ffb3c8', '#b58cff', '#ffe052', '#fff7fb'][Math.floor(Math.random() * 5)], a: Math.random() * TAU }));
  confettiAt = resultAt;
}

// ---------- input ----------
const DETECT_LAG = 0.04; // small camera + model latency, seconds
function fire(lane, at = songTime) {
  if (mode !== 'playing') return;
  const t = at, t2 = songTime; // closure start vs confirmation: judge by whichever is closer to the note
  let best = null, bestD = GOOD * 1.5 + 1e-9;
  for (const n of notes) {
    if (n.hit) continue;
    const win = n.id < 2 ? GOOD * 1.5 : GOOD; // warm-up: the first two are forgiving
    if (!bothMode && !(n.lane === lane || (n.lane === 2 && lane === 2))) continue;
    if (!bothMode && n.lane === 2 && lane !== 2) continue;
    const d = Math.min(Math.abs(n.t - t), Math.abs(n.t - t2)); if (d <= win && d < bestD) { bestD = d; best = n; }
  }
  if (!best) { if (DEBUG) dlog('no note in window'); return; }
  const grade = bestD <= PERFECT ? 'perfect' : 'good';
  best.hit = grade; best.hitAt = songTime;
  if (DEBUG) dlog(`hit ${grade} note#${best.id} d=${(t - best.t).toFixed(3)}`);
  stats[grade]++; stats.combo++; stats.maxCombo = Math.max(stats.maxCombo, stats.combo); stats.score += grade === 'perfect' ? 100 : 60;
  effects.push({ kind: grade, lane: best.lane, at: t });
  judge(grade === 'perfect' ? 'PERFECT' : 'GOOD'); sfx(grade); shootHearts(best.lane, grade === 'perfect' ? 8 : 4, true);
  voice(best.who, grade === 'perfect'); if (best.lane === 2) setTimeout(() => voice(best.who2, grade === 'perfect'), 90);
  if (grade === 'perfect' && (!faceBest || Math.random() < 0.4)) faceBest = grabFace();
  updateHud();
}
function missNote(n) { if (DEBUG) dlog(`miss note#${n.id} at ${songTime.toFixed(2)}`); n.hit = 'miss'; stats.miss++; stats.combo = 0; effects.push({ kind: 'miss', lane: n.lane, at: songTime }); judge('MISS'); sfx('miss'); if (!faceWorst || Math.random() < 0.5) faceWorst = grabFace(); updateHud(); }
let judgeTimer = 0;
function judge(text) { const j = $('judge'); j.textContent = text; j.classList.add('show'); clearTimeout(judgeTimer); judgeTimer = setTimeout(() => j.classList.remove('show'), 350); }
function updateHud() { $('score').textContent = stats.score; $('combo').textContent = stats.combo; }

// eye state machine. Wink = one eye clearly more closed than the other; both = both closed together.
// Scores are smoothed a little; thresholds are relative so people with "lazy" winks still register.
let smL = 0, smR = 0, faceAt = 0;
let eyePos = { L: null, R: null }; // canvas coords of the player's eyes
let hearts = [];
let pulse = [0, 0]; // seconds since the last wink on each lane, for the heartbeat rings
function handleEyes(rawL, rawR) {
  faceAt = performance.now();
  smL += (rawL - smL) * 0.5; smR += (rawR - smR) * 0.5;
  const l = smL, r = smR;
  const both = l > 0.38 && r > 0.38 && Math.abs(l - r) < 0.3;
  const L = !both && l > 0.3 && l - r > 0.18;
  const R = !both && r > 0.3 && r - l > 0.18;
  $('eyeL').classList.toggle('on', L || both); $('eyeR').classList.toggle('on', R || both);
  const now = performance.now();
  const closed = L || R || both;
  if (!closed) { eye.armed = true; eye.pendingAt = 0; eye.L = eye.R = false; eye.both = false; return; }
  if (!eye.armed) return;
  if (!eye.pendingAt) eye.pendingAt = now;
  eye.L = eye.L || L; eye.R = eye.R || R; eye.both = eye.both || both;
  if (now - eye.pendingAt >= 70) {
    eye.armed = false;
    const isBoth = eye.both || (eye.L && eye.R);
    if (mode === 'howto' && !practice) { startCountdown(); }
    else if (mode === 'playing') { if (isBoth) blinkStats.both++; else blinkStats.single++; if (!bothMode && blinkStats.both >= 4 && blinkStats.single === 0) { bothMode = true; judge('BOTH EYES MODE'); } const lane = bothMode ? 2 : isBoth ? 2 : eye.L ? 0 : 1; shootHearts(lane, 3); fire(lane); }
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
  if (lane === 2) pulse = [0, 0]; else pulse[lane] = 0;
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

// ---------- hearts from the eyes ----------
function shootHearts(lane, count, big = false) {
  const hy = H * HIT_Y;
  const srcs = lane === 2 ? [['L', 0], ['R', 1]] : [[lane === 0 ? 'L' : 'R', lane]];
  for (const [side, l] of srcs) {
    const from = eyePos[side] || { x: LANE_X[l], y: H * 0.3 };
    for (let i = 0; i < count; i++) hearts.push({ x: from.x + (Math.random() - .5) * 16, y: from.y, tx: LANE_X[l] + (Math.random() - .5) * 40, ty: hy - 40 + (Math.random() - .5) * 30, t: 0, dur: 0.45 + Math.random() * 0.25, size: (big ? 18 : 12) + Math.random() * 8, wob: Math.random() * TAU });
  }
}
function drawHearts(dt) {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const h of hearts) {
    h.t += dt; const k = Math.min(1, h.t / h.dur), e = 1 - Math.pow(1 - k, 2);
    const x = h.x + (h.tx - h.x) * e + Math.sin(h.wob + k * 6) * 10, y = h.y + (h.ty - h.y) * e - Math.sin(k * Math.PI) * 60;
    ctx.globalAlpha = k < 0.85 ? 1 : 1 - (k - 0.85) / 0.15; ctx.font = (h.size * (0.6 + 0.4 * k)) + 'px system-ui'; ctx.fillText('💗', x, y);
  }
  ctx.globalAlpha = 1; hearts = hearts.filter((h) => h.t < h.dur);
  // a little sparkle on the eye that is closed right now
  if (mode === 'playing' || mode === 'setup') for (const side of ['L', 'R']) { const on = $('eye' + side).classList.contains('on'), p = eyePos[side]; if (on && p) { ctx.font = '22px system-ui'; ctx.fillText('✨', p.x + (side === 'L' ? -18 : 18), p.y - 14); } }
}

// ---------- render ----------
const TAU = Math.PI * 2; let lastDraw = 0;
const SHOW_ZONES = new URLSearchParams(location.search).has('zones');
const DEBUG = new URLSearchParams(location.search).has('debug');
const dlines = [];
function dlog(m) { dlines.push(m); if (dlines.length > 14) dlines.shift(); }
function nearest(at) { let b = null, d = 9; for (const n of notes) { if (n.hit) continue; const x = Math.abs(n.t - at); if (x < d) { d = x; b = n; } } return b ? `#${b.id}(${['L','R','both'][b.lane]}) ${(b.t - at).toFixed(2)}` : 'none'; }
function drawDebug() { ctx.save(); ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(4, H * 0.3, W - 8, 14 * dlines.length + 8); ctx.fillStyle = '#9dff9d'; dlines.forEach((l, i) => ctx.fillText(l, 8, H * 0.3 + 12 + i * 14)); ctx.restore(); }
function drawZones() { // TikTok Effect safe zones on a 390×694 canvas, scaled to this canvas height
  const k = H / 694; ctx.save(); ctx.lineWidth = 1.5;
  ctx.fillStyle = 'rgba(255,0,80,.18)'; ctx.fillRect(0, 0, 19 * k, H); ctx.fillRect(W - 19 * k, 0, 19 * k, H);
  ctx.strokeStyle = '#4ec9b0'; ctx.setLineDash([6, 6]); ctx.strokeRect(19 * k, 83 * k, 352 * k, 258 * k); ctx.strokeRect(65 * k, 83 * k, 260 * k, 462 * k);
  ctx.setLineDash([]); ctx.strokeStyle = '#ffe052'; ctx.lineWidth = 2; ctx.strokeRect(65 * k, 82 * k, 260 * k, 451 * k);
  ctx.font = '700 10px system-ui'; ctx.textAlign = 'left'; ctx.fillStyle = '#ffe052'; ctx.fillText('CORE 260×451', 68 * k, 78 * k); ctx.fillStyle = '#4ec9b0'; ctx.fillText('VISUAL', 22 * k, 352 * k); ctx.fillStyle = '#ff5c8a'; ctx.fillText('CLIP', 2, H - 6);
  ctx.restore();
}
function draw() { drawInner(); if (SHOW_ZONES) drawZones(); if (DEBUG) drawDebug(); }
function drawInner() {
  const nowMs = performance.now(), dt = Math.min(0.05, (nowMs - lastDraw) / 1000 || 0); lastDraw = nowMs;
  ctx.clearRect(0, 0, W, H);
  if (mode === 'result') {
    const t = (performance.now() - resultAt) / 1000;
    const bodyW = PERSON_H * 0.55, bodyH = PERSON_H * 0.95; // rough box of a standing sprite at scale .95
    for (const p of pile) {
      if (t < p.delay) continue;
      if (!p.landed) {
        p.vy += 1500 * dt; p.y += p.vy * dt; p.x += p.vx * dt; p.rot += p.spin * dt;
        const tilt = Math.abs(Math.sin(p.rot)); const hNow = bodyH * (1 - tilt * 0.45); // a tilted body is shorter
        let floor = H * 0.985;
        for (const q of pile) { if (q === p || !q.landed) continue; const qw = bodyW * 1.1 + Math.abs(Math.sin(q.rot)) * bodyH * 0.5; if (Math.abs(q.x - p.x) < qw * 0.75) floor = Math.min(floor, q.top); }
        if (p.y >= floor) { p.y = floor; p.landed = true; p.top = floor - hNow * 0.9; p.squash = 1; p.rot = Math.max(-0.6, Math.min(0.6, p.rot + (Math.random() - .5) * 0.3)); sfx('land'); }
        if (p.x < 40) { p.x = 40; p.vx *= -0.5; } if (p.x > W - 40) { p.x = W - 40; p.vx *= -0.5; }
      } else p.squash = Math.max(0, p.squash - dt * 4);
      const sq = p.squash * 0.16; ctx.save(); ctx.translate(p.x, p.y); ctx.scale(1 + sq, 1 - sq); ctx.translate(-p.x, -p.y);
      sprite(PEOPLE[p.who].down, p.x, p.y, { scale: p.scale, rot: p.rot }); ctx.restore();
    }
    const dtc = (performance.now() - confettiAt) / 1000;
    for (const c of confetti) { const y = c.y + c.vy * dtc, x = c.x + c.vx * dtc + Math.sin(dtc * 3 + c.a) * 12; if (y > H + 10) continue; ctx.save(); ctx.translate(x, y); ctx.rotate(c.a + dtc * 4); ctx.fillStyle = c.c; ctx.fillRect(-c.r / 2, -c.r, c.r, c.r * 2); ctx.restore(); }
    return;
  }
  if (mode === 'setup') { drawHearts(dt); return; }
  if (!['playing', 'countdown', 'howto'].includes(mode)) return;
  // lanes
  ctx.fillStyle = 'rgba(26,15,46,.22)'; ctx.fillRect(0, 0, W, H);
  for (const x of LANE_X) { ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 2; ctx.setLineDash([6, 10]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.setLineDash([]); }
  // judge targets
  const hy = H * HIT_Y;
  LANE_X.forEach((x, i) => {
    pulse[i] += dt; const k = Math.min(1, pulse[i] / 0.5), beat = Math.sin(Math.min(1, pulse[i] / 0.18) * Math.PI); // quick swell then settle
    heartPath(x, hy, 36 * (1 + beat * 0.22)); ctx.strokeStyle = '#ffb3c8'; ctx.lineWidth = 3.5; ctx.stroke();
    if (k < 1) { ctx.globalAlpha = 1 - k; heartPath(x, hy, 36 * (1 + k * 1.1)); ctx.strokeStyle = '#ff5c8a'; ctx.lineWidth = 3 * (1 - k) + 0.5; ctx.stroke(); ctx.globalAlpha = 1; } // expanding echo, like a heartbeat
  });
  ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = '700 11px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('LEFT EYE', LANE_X[0], hy + 58); ctx.fillText('RIGHT EYE', LANE_X[1], hy + 58);
  if (mode !== 'playing') return;
  ctx.font = '44px system-ui'; ctx.textBaseline = 'middle';
  const walkAnim = (n, k) => { const step = songTime * 7 + n.id; return { rot: Math.sin(step) * 0.06, bob: Math.abs(Math.sin(step)) * 8, scale: 0.72 + 0.28 * k }; };
  const drawWalker = (n, x, y, k, alpha = 1, who = n.who) => { const a = walkAnim(n, k); if (!sprite(PEOPLE[who].walk, x, y + 70 - a.bob, { rot: a.rot, scale: a.scale, alpha })) { ctx.globalAlpha = alpha; ctx.fillText(n.lane === 1 ? '😐' : '🙂', x, y); ctx.globalAlpha = 1; } };
  for (const n of notes) {
    const dt = n.t - songTime; if (dt > LEAD || dt < -1.1) continue;
    const k = 1 - dt / LEAD, y = hy - (dt / LEAD) * (hy + 60);
    const lanes = n.lane === 2 ? [0, 1] : [n.lane];
    if (n.hit === 'miss') { const m = Math.min(1, (songTime - n.t) / 0.7); for (const l of lanes) drawWalker(n, LANE_X[l], hy + m * 120, 1, 1 - m, l === 1 && n.lane === 2 ? n.who2 : n.who); continue; }
    if (n.hit) {
      const m = Math.min(1, (songTime - n.hitAt) / 0.8);
      for (const l of lanes) {
        const x = LANE_X[l], dir = l === 0 ? -1 : 1, who = l === 1 && n.lane === 2 ? n.who2 : n.who;
        if (n.hit === 'perfect') { // swoon and topple sideways, face to the floor
          const rot = dir * Math.min(1, m * 1.6) * Math.PI / 2;
          if (!sprite(PEOPLE[who].down, x + dir * m * 26, hy + 70 + m * 10, { rot, alpha: 1 - Math.max(0, m - 0.75) * 4 })) { ctx.globalAlpha = 1 - m; ctx.fillText('😍', x, hy - m * 60); ctx.globalAlpha = 1; }
        } else { // good: blush, wobble, fade
          if (!sprite(PEOPLE[who].down, x, hy + 70, { rot: Math.sin(m * 12) * 0.08 * (1 - m), alpha: 1 - Math.max(0, m - 0.5) * 2 })) { ctx.globalAlpha = 1 - m; ctx.fillText('☺️', x, hy - m * 40); ctx.globalAlpha = 1; }
        }
      }
      continue;
    }
    if (n.lane === 2) { ctx.fillStyle = 'rgba(181,140,255,.22)'; roundRect(LANE_X[0] - 60, y - 40, LANE_X[1] - LANE_X[0] + 120, 110, 40); ctx.fill(); }
    for (const l of lanes) drawWalker(n, LANE_X[l], y, k, 1, l === 1 && n.lane === 2 ? n.who2 : n.who);
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
  drawHearts(dt);
  ctx.textBaseline = 'alphabetic';
}
function heartPath(cx, cy, r) { // simple heart outline, r ≈ half width
  ctx.beginPath(); const top = cy - r * 0.55;
  ctx.moveTo(cx, cy + r * 0.85);
  ctx.bezierCurveTo(cx - r * 1.35, cy - r * 0.05, cx - r * 0.95, top - r * 0.75, cx, top);
  ctx.bezierCurveTo(cx + r * 0.95, top - r * 0.75, cx + r * 1.35, cy - r * 0.05, cx, cy + r * 0.85);
  ctx.closePath();
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

// ---------- loop ----------
function loop() {
  requestAnimationFrame(loop);
  if (mode === 'playing') songTime = audioCtx.currentTime - startAt;
  if (landmarker && stream && video.readyState >= 2 && video.currentTime !== lastVideoTime && ['setup', 'howto', 'playing', 'countdown'].includes(mode)) {
    lastVideoTime = video.currentTime;
    try {
      const res = landmarker.detectForVideo(video, performance.now());
      const bs = res.faceBlendshapes && res.faceBlendshapes[0];
      const lm = res.faceLandmarks && res.faceLandmarks[0];
      if (lm) { const toC = (i) => { // video is mirrored and cover-fitted into the phone frame
          const vw = video.videoWidth, vh = video.videoHeight, s = Math.max(W / vw, H / vh), dw = vw * s, dh = vh * s;
          return { x: (W - dw) / 2 + (1 - lm[i].x) * dw, y: (H - dh) / 2 + lm[i].y * dh }; };
        const mid = (a, b) => { const p = toC(a), q = toC(b); return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; };
        eyePos = { L: mid(159, 145), R: mid(386, 374) }; }
      if (bs) { const get = (name) => (bs.categories.find((c) => c.categoryName === name) || {}).score || 0; handleEyes(get('eyeBlinkLeft'), get('eyeBlinkRight')); }

    } catch (e) { /* skip frame */ }
  }
  if (mode === 'playing') {
    songTime = audioCtx.currentTime - startAt;
    for (const n of notes) if (!n.hit && songTime - n.t > (n.id < 2 ? GOOD * 1.5 : GOOD)) missNote(n);
    $('time').textContent = Math.max(0, Math.ceil(SONG - songTime));
    if (songTime > SONG + 0.6) endRound();
  }
  draw();
}
setMode('idle'); loop();
