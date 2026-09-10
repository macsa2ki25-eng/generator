/*
 * FIND ME - スタッフ画面ロジック
 * モニター表示 / ゲーム開始・リセット / 設定の編集
 */
'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  phaseBadge: $('phaseBadge'),
  adminTimer: $('adminTimer'),
  startBtn: $('startBtn'),
  resetBtn: $('resetBtn'),
  cards: [$('genCard0'), $('genCard1'), $('genCard2')],
  repairValue: $('repairValue'),
  limitValue: $('limitValue'),
  saveBtn: $('saveBtn'),
  saveMsg: $('saveMsg'),
  soundToggle: $('soundToggle'),
  screamBtn: $('screamBtn'),
  connBanner: $('connBanner'),
};

const PHASE_LABEL = {
  idle: '待機中',
  running: 'ゲーム進行中',
  cleared: 'ゲート開放！',
  timeover: 'タイムオーバー',
};

let S = null;
let prevPhase = null;
let prevDone = [false, false, false];
let prevBoom = [0, 0, 0];
let first = true;
let soundOn = false;

/* ---------------- 設定の編集モデル ---------------- */

let edit = { repairSeconds: 90, limitSeconds: 300, skillCheck: 'normal', penaltyPercent: 10, regression: false };
let dirty = false;

function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function fmtJp(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m === 0) return `${s}秒`;
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

function renderSettings() {
  el.repairValue.textContent = `${edit.repairSeconds}秒`;
  el.limitValue.textContent = fmtJp(edit.limitSeconds);
  document.querySelectorAll('.preset').forEach((b) => {
    b.classList.toggle('selected', Number(b.dataset.value) === edit[b.dataset.key]);
  });
  document.querySelectorAll('#skillChoices .choice').forEach((b) => {
    b.classList.toggle('selected', b.dataset.value === edit.skillCheck);
  });
  document.querySelectorAll('#penaltyChoices .choice').forEach((b) => {
    b.classList.toggle('selected', Number(b.dataset.value) === edit.penaltyPercent);
  });
  document.querySelectorAll('#regressionChoices .choice').forEach((b) => {
    b.classList.toggle('selected', (b.dataset.value === 'true') === edit.regression);
  });
}

function markDirty() { dirty = true; el.saveMsg.classList.remove('show'); renderSettings(); }

$('repairMinus').addEventListener('click', () => { edit.repairSeconds = Math.max(10, edit.repairSeconds - 10); markDirty(); });
$('repairPlus').addEventListener('click', () => { edit.repairSeconds = Math.min(600, edit.repairSeconds + 10); markDirty(); });
$('limitMinus').addEventListener('click', () => { edit.limitSeconds = Math.max(30, edit.limitSeconds - 30); markDirty(); });
$('limitPlus').addEventListener('click', () => { edit.limitSeconds = Math.min(1800, edit.limitSeconds + 30); markDirty(); });

document.querySelectorAll('.preset').forEach((b) => {
  b.addEventListener('click', () => { edit[b.dataset.key] = Number(b.dataset.value); markDirty(); });
});
document.querySelectorAll('#skillChoices .choice').forEach((b) => {
  b.addEventListener('click', () => { edit.skillCheck = b.dataset.value; markDirty(); });
});
document.querySelectorAll('#penaltyChoices .choice').forEach((b) => {
  b.addEventListener('click', () => { edit.penaltyPercent = Number(b.dataset.value); markDirty(); });
});
document.querySelectorAll('#regressionChoices .choice').forEach((b) => {
  b.addEventListener('click', () => { edit.regression = b.dataset.value === 'true'; markDirty(); });
});

el.saveBtn.addEventListener('click', async () => {
  await Net.saveSettings(edit);
  // ひとりモード用にこの端末にも控えを保存しておく
  try { localStorage.setItem('findme.settings', JSON.stringify(edit)); } catch (_) {}
  dirty = false;
  el.saveMsg.classList.add('show');
  setTimeout(() => el.saveMsg.classList.remove('show'), 4000);
});

/* ---------------- 開始・リセット ---------------- */

el.startBtn.addEventListener('click', () => {
  if (dirty && !confirm('設定が保存されていません。保存せずにスタートしますか？')) return;
  if (S && S.phase === 'running') {
    if (!confirm('ゲーム進行中です。最初からやり直しますか？')) return;
  }
  Net.admin('start');
});

el.resetBtn.addEventListener('click', () => {
  if (S && S.phase === 'running' && !confirm('ゲーム進行中です。リセットして待機画面に戻しますか？')) return;
  Net.admin('reset');
});

/* ---------------- 殺人鬼の叫び声 (この端末からのみ鳴らす) ---------------- */
/* 押している間だけ再生する。効果音オン/オフの設定とは無関係に鳴らせるよう、
   押した時点で音声のロック解除も行う。 */

let screaming = false;

function screamStart(e) {
  if (e) e.preventDefault();
  if (screaming) return;
  screaming = true;
  Sfx.unlock();
  Sfx.setScreaming(true);
  el.screamBtn.classList.add('screaming');
}

function screamStop() {
  if (!screaming) return;
  screaming = false;
  Sfx.setScreaming(false);
  el.screamBtn.classList.remove('screaming');
}

el.screamBtn.addEventListener('pointerdown', screamStart);
/* 指がボタンの外に出て離された場合も確実に止める */
['pointerup', 'pointercancel'].forEach((ev) => window.addEventListener(ev, screamStop));
window.addEventListener('blur', screamStop);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') screamStop();
});
/* 長押しでの選択・コンテキストメニューを抑止 */
el.screamBtn.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------------- 効果音 (スタッフ端末でも鳴らせる) ---------------- */

el.soundToggle.addEventListener('click', () => {
  soundOn = !soundOn;
  if (soundOn) Sfx.unlock();
  else Sfx.stopAll();
  el.soundToggle.textContent = soundOn ? '🔊 効果音オン' : '🔇 効果音オフ';
});

/* ---------------- 状態の反映 ---------------- */

function onState(st) {
  S = st;

  el.phaseBadge.textContent = PHASE_LABEL[S.phase] || S.phase;
  el.phaseBadge.className = 'phase-badge ' + S.phase;

  const showTime = S.phase === 'idle' ? S.settings.limitSeconds : S.timeLeft;
  el.adminTimer.textContent = fmtTime(showTime);
  el.adminTimer.classList.toggle('low', S.phase === 'running' && S.timeLeft <= 30);

  S.gens.forEach((g, i) => {
    const card = el.cards[i];
    card.querySelector('.gc-pct').textContent = g.done ? '完了' : Math.floor(g.p) + '%';
    card.querySelector('.fill').style.width = g.p + '%';
    card.querySelector('.pbar').classList.toggle('done', g.done);
    card.classList.toggle('done', g.done);
    card.classList.toggle('touch', g.touch && !g.done);
    card.querySelector('.gc-status').textContent =
      g.done ? '💡 復旧完了' : (g.touch ? '⚡ 修理中…' : (S.phase === 'running' ? 'だれも触っていない' : '待機'));

    if (g.done && !prevDone[i] && !first && soundOn) Sfx.distantDone();
    prevDone[i] = g.done;

    if (g.boom > prevBoom[i] && !first) {
      card.classList.remove('boom'); void card.offsetWidth; card.classList.add('boom');
      if (soundOn) Sfx.explosion(true);
    }
    prevBoom[i] = g.boom;
  });

  if (S.phase !== prevPhase) {
    if (!first && soundOn) {
      if (S.phase === 'cleared') Sfx.gateOpen();
      else if (S.phase === 'timeover') Sfx.timeoverStart();
      else Sfx.stopAll();
    }
    if (S.phase !== 'timeover') Sfx.timeoverStop();
    prevPhase = S.phase;
  }

  // 設定は編集中でなければサーバーの値に合わせる
  if (!dirty) {
    edit = { ...S.settings };
    renderSettings();
  }

  first = false;
}

renderSettings();

let graceOver = false;
setTimeout(() => { graceOver = true; el.connBanner.hidden = Net.isConnected(); }, 4000);
Net.connect(onState, (connected) => {
  if (graceOver) el.connBanner.hidden = connected;
});
