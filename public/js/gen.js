/*
 * FIND ME - 発電機画面ロジック
 *  ・長押しで修理が進む (サーバーが進行を管理)
 *  ・スキルチェック (DbD風の円形QTE)
 *  ・ピストンは進行度 25% ごとに動く本数が増える
 *  ・?solo=1 でサーバー無しの「ひとりモード」
 */
'use strict';

/* ---------------- 起動パラメータ ---------------- */

const params = new URLSearchParams(location.search);
const genNo = Math.min(3, Math.max(1, parseInt(params.get('g') || '0', 10) || 0));
if (!params.get('g')) location.replace('/');
const genIndex = genNo - 1;
const solo = params.get('solo') === '1';

const otherIndexes = [0, 1, 2].filter((i) => i !== genIndex);

/* ---------------- DOM ---------------- */

const $ = (id) => document.getElementById(id);
const el = {
  genNo: $('genNo'), timer: $('timer'), noiseWarn: $('noiseWarn'),
  machine: $('machine'), sparks: $('sparks'),
  mainBar: $('mainBar'), pct: $('pct'), hint: $('hint'),
  touchLayer: $('touchLayer'), vignette: $('vignette'), lightflood: $('lightflood'),
  overlayIdle: $('overlayIdle'), overlayCleared: $('overlayCleared'), overlayTimeover: $('overlayTimeover'),
  soloStartBtn: $('soloStartBtn'), connBanner: $('connBanner'), soloLink: $('soloLink'),
  skillcheck: $('skillcheck'), scZoneGood: $('scZoneGood'), scZoneGreat: $('scZoneGreat'),
  scNeedle: $('scNeedle'), scResult: $('scResult'), scCaption: $('scCaption'),
  lampLens: $('lampLens'), lampGlow: $('lampGlow'), lampCone: $('lampCone'),
  others: [$('other0'), $('other1')],
  pistons: [$('piston0'), $('piston1'), $('piston2'), $('piston3')],
};

el.genNo.textContent = String(genNo);
document.title = `発電機 ${genNo} - FIND ME`;
el.soloLink.href = `/gen.html?g=${genNo}&solo=1`;
el.lampGlow.style.transition = 'opacity 1.4s ease';
el.lampCone.style.transition = 'opacity 1.4s ease';
el.pistons.forEach((p, i) => { p.style.animationDelay = (-i * 0.12) + 's'; });

/* ---------------- 状態 ---------------- */

let S = null;              // サーバーから来た最新状態
let first = true;
let prevPhase = null;
let prevDone = [false, false, false];
let prevBoom = [0, 0, 0];
let prevSecond = null;
let lastLocalFail = 0;

const pointers = new Set();
let touching = false;
let keepaliveTimer = null;

/* 通信相手: サーバー or ローカルシミュレータ */
let link = null;

/* ---------------- ひとりモード (サーバー無し) ---------------- */

function createLocalSim(onState) {
  const DEFAULTS = { repairSeconds: 90, limitSeconds: 300, skillCheck: 'normal', penaltyPercent: 10, regression: false };
  let settings = { ...DEFAULTS };
  try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('findme.settings') || '{}') }; } catch (_) {}

  const st = {
    phase: 'idle',
    timeLeft: settings.limitSeconds,
    gens: [0, 1, 2].map(() => ({ p: 0, done: false, touch: false, boom: 0 })),
  };
  let isTouching = false;

  setInterval(() => {
    const dt = 0.1;
    const g = st.gens[genIndex];
    if (st.phase === 'running') {
      g.touch = isTouching;
      if (!g.done && isTouching) {
        g.p = Math.min(100, g.p + (100 / settings.repairSeconds) * dt);
        if (g.p >= 100) { g.done = true; }
      } else if (!g.done && settings.regression && g.p > 0) {
        g.p = Math.max(0, g.p - (100 / settings.repairSeconds) * 0.25 * dt);
      }
      if (g.done) {
        st.phase = 'cleared'; // ひとりモードは自分の1台で完了扱い
      } else {
        st.timeLeft = Math.max(0, st.timeLeft - dt);
        if (st.timeLeft <= 0) st.phase = 'timeover';
      }
    }
    onState(JSON.parse(JSON.stringify({ ...st, settings })));
  }, 100);

  return {
    solo: true,
    touch: (gen, t) => { isTouching = !!t; },
    skill: (gen, result) => {
      const g = st.gens[genIndex];
      if (st.phase !== 'running' || g.done) return;
      if (result === 'fail') { g.p = Math.max(0, g.p - settings.penaltyPercent); g.boom++; }
      if (result === 'great') { g.p = Math.min(100, g.p + 1); }
    },
    admin: (action) => {
      if (action === 'start') {
        st.phase = 'running';
        st.timeLeft = settings.limitSeconds;
        st.gens.forEach((g) => { g.p = 0; g.done = false; g.boom = 0; });
      }
    },
  };
}

/* ---------------- 画面ロック解除・スリープ防止 ---------------- */

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && (!wakeLock || wakeLock.released)) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

let fsTried = false;
function tryFullscreenOnce() {
  if (fsTried) return;
  fsTried = true;
  const root = document.documentElement;
  try {
    if (root.requestFullscreen) root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
  } catch (_) {}
}

/* ---------------- スキルチェック ---------------- */

const SC_CONF = {
  easy:   { speed: 220, zone: 68, great: 15 },
  normal: { speed: 290, zone: 50, great: 14 },
  hard:   { speed: 350, zone: 36, great: 12 },
};
const SC_CIRC = 490.1; // r=78 の円周

let sc = null;               // null | {stage, angle, zoneStart, conf, ...}
let touchAccum = 0;          // 修理していた累計秒
let nextCheckAt = 5 + Math.random() * 7;

function ownDone() { return S && S.gens[genIndex].done; }
function skillEnabled() {
  return S && S.settings.skillCheck !== 'off' && !ownDone() && S.phase === 'running';
}

function scheduleNext() {
  nextCheckAt = touchAccum + 7 + Math.random() * 9;
}

function startSkillWarn() {
  sc = { stage: 'warn', until: performance.now() + 450 };
  Sfx.skillWarn();
}

function startSkillActive() {
  const conf = SC_CONF[S.settings.skillCheck] || SC_CONF.normal;
  sc = {
    stage: 'active',
    conf,
    startTime: performance.now(),
    zoneStart: 120 + Math.random() * 140,
  };
  const goodLen = (conf.zone / 360) * SC_CIRC;
  const greatLen = (conf.great / 360) * SC_CIRC;
  const offset = -(sc.zoneStart / 360) * SC_CIRC;
  el.scZoneGood.setAttribute('stroke-dasharray', `${goodLen} ${SC_CIRC}`);
  el.scZoneGood.setAttribute('stroke-dashoffset', String(offset));
  el.scZoneGreat.setAttribute('stroke-dasharray', `${greatLen} ${SC_CIRC}`);
  el.scZoneGreat.setAttribute('stroke-dashoffset', String(offset));
  el.scResult.setAttribute('opacity', '0');
  el.scCaption.style.visibility = 'visible';
  el.skillcheck.hidden = false;
}

function needleAngle() {
  return (performance.now() - sc.startTime) / 1000 * sc.conf.speed;
}

function resolveSkill(kind) {
  // kind: 'great' | 'good' | 'fail'
  const label = { great: 'GREAT!!', good: 'OK', fail: 'MISS' }[kind];
  const color = { great: '#ffffff', good: '#e8a33d', fail: '#ff3b30' }[kind];
  el.scResult.textContent = label;
  el.scResult.setAttribute('fill', color);
  el.scResult.setAttribute('opacity', '1');
  el.scCaption.style.visibility = 'hidden';
  sc = { stage: 'result', until: performance.now() + 500 };

  if (kind === 'great') { Sfx.skillGreat(); link.skill(genIndex, 'great'); }
  else if (kind === 'good') { Sfx.skillGood(); }
  else {
    lastLocalFail = Date.now();
    Sfx.explosion();
    link.skill(genIndex, 'fail');
    explodeFx();
  }
  scheduleNext();
}

function cancelSkill() {
  sc = null;
  el.skillcheck.hidden = true;
  scheduleNext();
}

function attemptSkill() {
  if (!sc || sc.stage !== 'active') return;
  const a = needleAngle();
  const { zoneStart, conf } = sc;
  if (a >= zoneStart && a <= zoneStart + conf.great) resolveSkill('great');
  else if (a >= zoneStart && a <= zoneStart + conf.zone) resolveSkill('good');
  else resolveSkill('fail');
}

/* ---------------- 火花エフェクト ---------------- */

const ctx2d = el.sparks.getContext('2d');
let particles = [];

function resizeSparks() {
  const wrap = el.sparks.parentElement;
  el.sparks.width = wrap.clientWidth;
  el.sparks.height = wrap.clientHeight;
}
window.addEventListener('resize', resizeSparks);
resizeSparks();

function spawnSpark(burst) {
  const w = el.sparks.width, h = el.sparks.height;
  const x = w * (0.38 + Math.random() * 0.24);
  const y = h * (0.3 + Math.random() * 0.3);
  const n = burst ? 46 : 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = burst ? 140 + Math.random() * 420 : 60 + Math.random() * 160;
    particles.push({
      x, y,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp - (burst ? 60 : 110),
      life: 0.45 + Math.random() * 0.5,
      max: 1,
      hue: burst ? 8 + Math.random() * 30 : 35 + Math.random() * 15,
    });
  }
}

function explodeFx() {
  spawnSpark(true);
  el.machine.classList.remove('exploded');
  void el.machine.offsetWidth;
  el.machine.classList.add('exploded');
  setTimeout(() => el.machine.classList.remove('exploded'), 600);
}

function drawSparks(dt) {
  const w = el.sparks.width, h = el.sparks.height;
  ctx2d.clearRect(0, 0, w, h);
  if (particles.length === 0) return;
  const next = [];
  for (const p of particles) {
    p.life -= dt;
    if (p.life <= 0) continue;
    p.vy += 620 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const a = Math.max(0, Math.min(1, p.life / 0.5));
    ctx2d.strokeStyle = `hsla(${p.hue}, 95%, ${55 + a * 25}%, ${a})`;
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(p.x, p.y);
    ctx2d.lineTo(p.x - p.vx * 0.022, p.y - p.vy * 0.022);
    ctx2d.stroke();
    next.push(p);
  }
  particles = next;
}

/* ---------------- タッチ処理 ---------------- */

function canRepair() {
  return S && S.phase === 'running' && !S.gens[genIndex].done;
}

function sendTouch(t) { link.touch(genIndex, t); }

function setTouching(t) {
  if (touching === t) return;
  touching = t;
  if (t) {
    sendTouch(true);
    Sfx.setRepairing(true);
    el.noiseWarn.style.visibility = 'visible';
    el.machine.classList.add('working');
    keepaliveTimer = setInterval(() => sendTouch(true), 2000);
  } else {
    sendTouch(false);
    Sfx.setRepairing(false);
    el.noiseWarn.style.visibility = 'hidden';
    el.machine.classList.remove('working');
    clearInterval(keepaliveTimer);
    if (sc && sc.stage === 'active') resolveSkill('fail'); // 手を離した = 失敗
    else if (sc && sc.stage === 'warn') cancelSkill();
  }
  if (S) updatePistons();
}

function refreshTouching() {
  setTouching(pointers.size > 0 && canRepair());
}

el.touchLayer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  Sfx.unlock();
  tryFullscreenOnce();
  requestWakeLock();
  if (sc && sc.stage === 'active') { attemptSkill(); return; } // 2本目の指のタップ
  pointers.add(e.pointerId);
  refreshTouching();
});
['pointerup', 'pointercancel'].forEach((ev) => {
  window.addEventListener(ev, (e) => {
    pointers.delete(e.pointerId);
    refreshTouching();
  });
});
window.addEventListener('blur', () => { pointers.clear(); refreshTouching(); });
document.addEventListener('contextmenu', (e) => e.preventDefault());

/* キーボードでも試せるように (PCテスト用: スペース長押し / Enterでスキルチェック) */
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) {
    Sfx.unlock();
    if (sc && sc.stage === 'active') { attemptSkill(); return; }
    pointers.add('kb');
    refreshTouching();
  }
  if (e.code === 'Enter' && !e.repeat && sc && sc.stage === 'active') attemptSkill();
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { pointers.delete('kb'); refreshTouching(); }
});

/* ---------------- 状態の反映 ---------------- */

function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function setLamp(on) {
  el.lampLens.style.fill = on ? '#ffedb3' : '#2b2a24';
  el.lampLens.setAttribute('filter', on ? 'url(#glow)' : '');
  el.lampGlow.style.opacity = on ? '0.95' : '0';
  el.lampCone.style.opacity = on ? '0.4' : '0';
}

function updatePistons() {
  const g = S.gens[genIndex];
  el.pistons.forEach((p, i) => {
    p.classList.remove('pumping', 'idlepump');
    if (g.done) p.classList.add('idlepump');
    else if (touching && S.phase === 'running') {
      const count = 1 + Math.min(3, Math.floor(g.p / 25));
      if (i < count) p.classList.add('pumping');
    }
  });
}

function updateOthers() {
  otherIndexes.forEach((gi, k) => {
    const card = el.others[k];
    const g = S.gens[gi];
    card.querySelector('.og-name').textContent = `発電機 ${gi + 1}` + (g.touch && !g.done ? ' ⚡' : '');
    card.querySelector('.og-pct').textContent = link.solo ? '—' : (g.done ? '完了' : Math.floor(g.p) + '%');
    card.querySelector('.fill').style.width = (link.solo ? 0 : g.p) + '%';
    card.classList.toggle('done', !link.solo && g.done);
  });
}

function onState(st) {
  S = st;
  const own = S.gens[genIndex];

  /* --- フェーズの変わり目 --- */
  if (S.phase !== prevPhase) {
    el.overlayIdle.hidden = S.phase !== 'idle';
    el.overlayCleared.hidden = S.phase !== 'cleared';
    el.overlayTimeover.hidden = S.phase !== 'timeover';

    if (!first) {
      if (S.phase === 'cleared') {
        Sfx.gateOpen();
        el.lightflood.classList.add('on');
        Sfx.heartbeat(false);
      } else if (S.phase === 'timeover') {
        Sfx.timeoverStart();
        cancelSkill(); el.skillcheck.hidden = true;
      } else if (S.phase === 'running') {
        Sfx.stopAll();
        el.lightflood.classList.remove('on');
        setLamp(false);
        touchAccum = 0;
        nextCheckAt = 5 + Math.random() * 7;
        prevDone = [false, false, false];
        prevBoom = S.gens.map((g) => g.boom);
        cancelSkill(); el.skillcheck.hidden = true;
      } else if (S.phase === 'idle') {
        Sfx.stopAll();
        el.lightflood.classList.remove('on');
        setLamp(false);
        cancelSkill(); el.skillcheck.hidden = true;
      }
    }
    prevPhase = S.phase;
  }

  /* --- 発電機の完了の変わり目 --- */
  S.gens.forEach((g, i) => {
    if (g.done && !prevDone[i]) {
      if (!first) {
        if (i === genIndex) {
          Sfx.genDone();
          if (sc) { sc = null; el.skillcheck.hidden = true; }
        } else {
          Sfx.distantDone();
        }
      }
      prevDone[i] = true;
    } else if (!g.done) {
      prevDone[i] = false;
    }
  });

  /* --- 爆発 (スキルチェック失敗) の検知 --- */
  S.gens.forEach((g, i) => {
    if (g.boom > prevBoom[i]) {
      if (!first) {
        if (i === genIndex) {
          if (Date.now() - lastLocalFail > 1500) { Sfx.explosion(); explodeFx(); }
        } else {
          Sfx.explosion(true); // 遠くでくぐもった爆発音
          const card = el.others[otherIndexes.indexOf(i)];
          if (card) { card.classList.remove('boom'); void card.offsetWidth; card.classList.add('boom'); }
        }
      }
      prevBoom[i] = g.boom;
    } else {
      prevBoom[i] = g.boom;
    }
  });

  /* --- 自分の発電機まわりの表示 --- */
  if (own.done) {
    setLamp(true);
    el.lightflood.classList.add('on');
    if (Sfx.ready()) Sfx.humOn();
  }
  el.mainBar.querySelector('.fill').style.width = own.p + '%';
  el.mainBar.classList.toggle('done', own.done);
  el.pct.innerHTML = own.done
    ? '復旧'
    : Math.floor(own.p) + '<span style="font-size:0.5em">%</span>';
  el.pct.classList.toggle('done', own.done);

  /* --- タイマー --- */
  const showTime = S.phase === 'idle' ? S.settings.limitSeconds : S.timeLeft;
  el.timer.textContent = fmtTime(showTime);
  const low = S.phase === 'running' && S.timeLeft <= 30;
  el.timer.classList.toggle('low', low);
  el.vignette.classList.toggle('danger', S.phase === 'running' && S.timeLeft <= 60);

  if (S.phase === 'running' && S.timeLeft <= 45) {
    Sfx.heartbeat(true, 1 - S.timeLeft / 45);
  } else {
    Sfx.heartbeat(false);
  }
  const sec = Math.ceil(S.timeLeft);
  if (S.phase === 'running' && sec !== prevSecond && sec <= 10 && sec > 0) Sfx.tick();
  prevSecond = sec;

  /* --- その他 --- */
  updateOthers();
  el.hint.hidden = !(S.phase === 'running' && !own.done && !touching);
  el.soloStartBtn.hidden = !link.solo;

  if (!canRepair() && touching) setTouching(false);
  if (canRepair() && pointers.size > 0 && !touching) setTouching(true);

  updatePistons();
  first = false;
}

/* ---------------- メインループ (描画・スキルチェック進行) ---------------- */

let lastFrame = performance.now();
function frame(t) {
  const dt = Math.min(0.05, (t - lastFrame) / 1000);
  lastFrame = t;

  if (touching && S && S.phase === 'running' && !S.gens[genIndex].done) {
    touchAccum += dt;
    if (Math.random() < dt * 7) spawnSpark(false);
    // スキルチェック発動
    if (!sc && skillEnabled() && touchAccum >= nextCheckAt) startSkillWarn();
  }

  if (sc) {
    if (sc.stage === 'warn' && performance.now() >= sc.until) {
      if (touching && skillEnabled()) startSkillActive();
      else cancelSkill();
    } else if (sc.stage === 'active') {
      const a = needleAngle();
      el.scNeedle.setAttribute('transform', `rotate(${a} 100 100)`);
      if (a > sc.zoneStart + sc.conf.zone) resolveSkill('fail'); // ゾーン通過 = 失敗
    } else if (sc.stage === 'result' && performance.now() >= sc.until) {
      sc = null;
      el.skillcheck.hidden = true;
    }
  }

  drawSparks(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------------- 接続 ---------------- */

function startSoloBadge() {
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:80;font-size:12px;color:#7a6f60;border:1px solid #2c241d;border-radius:6px;padding:5px 10px;background:rgba(10,8,6,0.8)';
  badge.innerHTML = `ひとりモードで動作中　<a href="/gen.html?g=${genNo}" style="color:#ffd76e">サーバーに接続する</a>`;
  document.body.appendChild(badge);
}

if (solo) {
  link = createLocalSim(onState);
  el.connBanner.hidden = true;
  startSoloBadge();
  el.soloStartBtn.addEventListener('click', () => {
    Sfx.unlock();
    Sfx.click();
    tryFullscreenOnce();
    requestWakeLock();
    link.admin('start');
  });
} else {
  link = Net;
  let graceOver = false;
  setTimeout(() => {
    graceOver = true;
    el.connBanner.hidden = Net.isConnected();
  }, 4000);
  Net.connect(onState, (connected) => {
    if (graceOver) el.connBanner.hidden = connected;
  });
}
