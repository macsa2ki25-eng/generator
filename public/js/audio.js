/*
 * FIND ME - サウンドエンジン
 * 効果音は Web Audio API で合成。修理中の音だけは音声ファイル(/sound/repair.mp3)を
 * ループ再生する。ファイルが読めない時は合成のピストン音にフォールバックする。
 */
'use strict';

const Sfx = (() => {
  let ctx = null;
  let master = null;
  let reverb = null;      // 空間の残響 (合成インパルス)
  let unlocked = false;

  let noiseBuf = null;

  /* ---- 修理音のファイル(ループ再生) ---- */
  const REPAIR_URL = '/sound/repair.mp3';
  const REPAIR_GAIN = 0.75;      // 修理音の音量(大きめ)。小さすぎ/大きすぎならここを調整
  let repairBuffer = null;       // デコード済み音声。読めたらこれをループ再生
  let repairLoadFailed = false;  // 読み込み/デコードに失敗したら合成音に切替
  // ページ表示と同時にファイルの取得だけ先に始めておく(初回タッチの遅延を減らす)
  let repairBytesPromise = null;
  try {
    repairBytesPromise = fetch(REPAIR_URL).then((r) => {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.arrayBuffer();
    });
  } catch (_) { repairBytesPromise = null; }

  /* ---- 継続音のノード ---- */
  let repair = null;      // 修理ループ(再生中のノード群)
  let wantRepair = false; // 修理音を鳴らしたい状態か(コンテキスト再開後に開始するため)
  let hum = null;         // 完了後のエンジン音
  let heartbeatTimer = null;
  let droneNodes = null;  // タイムオーバーの持続音

  function now() { return ctx.currentTime; }

  function makeNoiseBuffer() {
    const len = ctx.sampleRate * 1.2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function makeReverbImpulse(seconds, decay) {
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 1;
      // 最大音量で鳴らすための「ドライブ + tanhサチュレーター」。
      // 信号を大きく増幅して tanh で天井(±1)まで潰す＝実質フルボリューム。
      // ガヤガヤした会場向けに、音割れより「聞こえること」を優先している。
      // もっと大きく/小さくしたい時は、この pre.gain(ドライブ量)を上げ下げする。
      const pre = ctx.createGain();
      pre.gain.value = 1.3; // ドライブ量(大きいほど爆音)。1.0で±1入力→tanh(4)相当
      const shaper = ctx.createWaveShaper();
      const N = 2048;
      const curve = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1)) * 2 - 1;
        curve[i] = Math.tanh(4 * x); // 天井を超えない(=デジタル的なプチッという歪みは出ない)
      }
      shaper.curve = curve;
      shaper.oversample = 'none';
      master.connect(pre);
      pre.connect(shaper);
      shaper.connect(ctx.destination);

      // 教室っぽい残響のセンドバス
      reverb = ctx.createConvolver();
      reverb.buffer = makeReverbImpulse(1.6, 3.2);
      const revGain = ctx.createGain();
      revGain.gain.value = 0.25;
      reverb.connect(revGain);
      revGain.connect(master);

      noiseBuf = makeNoiseBuffer();
      loadRepairSound(); // 修理音ファイルをデコード(コンテキストが出来てから)

      // コンテキストが再開したら、鳴らしたかった修理音を開始する
      ctx.onstatechange = () => {
        if (ctx.state === 'running' && wantRepair && !repair) startRepair();
      };
    }
    if (ctx.state === 'suspended') ctx.resume();
    // iOS/一部端末のロック解除: 無音バッファを1回鳴らして音声出力を有効化する
    try {
      const b = ctx.createBufferSource();
      b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      b.connect(ctx.destination);
      b.start(0);
    } catch (_) {}
    unlocked = true;
    return true;
  }

  function ready() { return unlocked && ctx && ctx.state === 'running'; }

  /* 音を鳴らす前の保険: コンテキストがあれば(一時停止でも)再開を試みて true を返す。
     一時停止中でも予約した音は再開時に鳴るので、ready()で捨てずにこれで通す。 */
  function ensure() {
    if (!ctx) return false;
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  /* ---- 部品: ノイズ一発 ---- */
  function noiseHit({ when = 0, dur = 0.08, type = 'bandpass', freq = 1200, q = 5,
                      gain = 0.3, freqEnd = null, toReverb = 0 }) {
    const t = now() + when;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t);
    if (freqEnd !== null) filt.frequency.exponentialRampToValueAtTime(Math.max(30, freqEnd), t + dur);
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(master);
    if (toReverb > 0) {
      const rg = ctx.createGain(); rg.gain.value = toReverb;
      g.connect(rg); rg.connect(reverb);
    }
    src.start(t, Math.random() * 0.5, dur + 0.05);
    src.stop(t + dur + 0.1);
  }

  /* ---- 部品: トーン一発 ---- */
  function tone({ when = 0, dur = 0.15, type = 'sine', freq = 440, freqEnd = null,
                  gain = 0.2, toReverb = 0 }) {
    const t = now() + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd !== null) o.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master);
    if (toReverb > 0) {
      const rg = ctx.createGain(); rg.gain.value = toReverb;
      g.connect(rg); rg.connect(reverb);
    }
    o.start(t); o.stop(t + dur + 0.05);
  }

  /* ================================================================ */
  /* 修理音ループ: 往復するピストン + 金属のこすれ + 低いエンジン音     */
  /*   ※ ピッチのある電子音は使わず、すべてノイズから機械音を作る      */
  /* ================================================================ */

  /* 金属の当たる「カチャッ」(倍音のあるノイズ。単一トーンにしない) */
  function metalClank(when, gain, bright) {
    noiseHit({ when, dur: 0.045, type: 'bandpass', freq: bright ? 3200 : 2100,
               q: 2.2, gain: gain, toReverb: 0.3 });
    noiseHit({ when: when + 0.004, dur: 0.06, type: 'bandpass',
               freq: 1150 + Math.random() * 250, q: 3, gain: gain * 0.7, toReverb: 0.25 });
  }

  /* 修理音ファイルを取得→デコード。成功したら、すでに修理したい状態なら鳴らし始める。
     失敗したら合成のピストン音にフォールバックする。 */
  function loadRepairSound() {
    if (repairBuffer || repairLoadFailed || !ctx || !repairBytesPromise) return;
    repairBytesPromise
      .then((bytes) => new Promise((resolve, reject) => {
        // 促進のため slice(0) でコピーを渡す(decodeでバッファが無効化されるため)
        const p = ctx.decodeAudioData(bytes.slice(0), resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      }))
      .then((buf) => {
        repairBuffer = buf;
        // すでに鳴らしたい状態なら(読み込み待ちで保留されていたら)開始する
        if (wantRepair && !repair && ctx.state === 'running') startRepair();
      })
      .catch(() => { repairLoadFailed = true; }); // 合成音に切替
  }

  function startRepair() {
    if (repair || !ctx) return;
    if (repairBuffer) startRepairFile();
    else if (repairLoadFailed) startRepairSynth();
    // まだ読み込み中: 何もしない。読み込み完了時に自動で開始する(loadRepairSound内)
  }

  /* 音声ファイルをループ再生 */
  function startRepairFile() {
    const src = ctx.createBufferSource();
    src.buffer = repairBuffer;
    src.loop = true;                 // 40秒ほどのファイルを継ぎ目なくループ
    const g = ctx.createGain();
    g.gain.value = REPAIR_GAIN;
    src.connect(g); g.connect(master);
    src.start();
    repair = { type: 'file', src, gain: g };
  }

  /* フォールバック: 合成のピストン音(ファイルが読めない時) */
  function startRepairSynth() {
    const rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = noiseBuf;
    rumbleSrc.loop = true;
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 170;
    rumbleLp.Q.value = 0.7;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.26;
    rumbleSrc.connect(rumbleLp); rumbleLp.connect(rumbleGain); rumbleGain.connect(master);
    rumbleSrc.start();

    const period = 0.24;
    let nextAt = now() + 0.05;
    let stroke = 0;
    const timer = setInterval(() => {
      if (!repair) return;
      const horizon = now() + 0.4;
      while (nextAt < horizon) {
        const jitter = (Math.random() - 0.5) * 0.02;
        const w = Math.max(0, nextAt - now() + jitter);
        const up = (stroke % 2 === 0);
        noiseHit({ when: w, dur: up ? 0.11 : 0.09, type: 'lowpass',
                   freq: up ? 240 : 320, freqEnd: up ? 65 : 85, q: 1.2,
                   gain: up ? 0.6 : 0.5, toReverb: 0.22 });
        metalClank(w + 0.012, up ? 0.2 : 0.15, up);
        if (Math.random() < 0.5) {
          noiseHit({ when: w + 0.05 + Math.random() * 0.06, dur: 0.05,
                     type: 'highpass', freq: 2000, q: 0.8, gain: 0.09, toReverb: 0.15 });
        }
        stroke++;
        nextAt += period + (Math.random() - 0.5) * 0.025;
      }
    }, 110);

    repair = { type: 'synth', rumbleSrc, rumbleGain, timer };
  }

  function stopRepair() {
    if (!repair) return;
    const r = repair;
    repair = null;
    if (r.type === 'file') {
      r.gain.gain.setTargetAtTime(0, now(), 0.04); // 軽くフェードアウト
      setTimeout(() => { try { r.src.stop(); } catch (_) {} }, 200);
    } else {
      clearInterval(r.timer);
      r.rumbleGain.gain.setTargetAtTime(0, now(), 0.05);
      setTimeout(() => { try { r.rumbleSrc.stop(); } catch (_) {} }, 300);
    }
  }

  /* 修理音のオン/オフ。まだコンテキストが再開していなくても、
     wantRepair を立てておけば onstatechange(再開時)に自動で鳴り始める。 */
  function setRepairing(on) {
    wantRepair = on;
    if (!ctx) return;
    if (on) {
      if (ctx.state === 'suspended') ctx.resume();
      if (ctx.state === 'running') startRepair();
    } else {
      stopRepair();
    }
  }

  /* ================================================================ */
  /* 完了後のエンジン稼働音                                            */
  /* ================================================================ */

  function humOn() {
    if (!ensure() || hum) return;
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 55;
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 55.7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 150;
    const g = ctx.createGain(); g.gain.value = 0;
    o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(master);
    o1.start(); o2.start();
    g.gain.setTargetAtTime(0.055, now(), 0.5);
    hum = { o1, o2, g };
  }

  function humOff() {
    if (!hum) return;
    const h = hum; hum = null;
    h.g.gain.setTargetAtTime(0, now(), 0.1);
    setTimeout(() => { try { h.o1.stop(); h.o2.stop(); } catch (_) {} }, 500);
  }

  /* ================================================================ */
  /* 単発の効果音                                                      */
  /* ================================================================ */

  /* スキルチェック警告 (トゥン・トゥン) */
  function skillWarn() {
    if (!ensure()) return;
    tone({ dur: 0.12, freq: 1150, gain: 0.30, toReverb: 0.5 });
    tone({ when: 0.16, dur: 0.14, freq: 870, gain: 0.30, toReverb: 0.5 });
  }

  /* スキルチェック成功 */
  function skillGood() {
    if (!ensure()) return;
    noiseHit({ dur: 0.05, freq: 2400, q: 3, gain: 0.25 });
    tone({ dur: 0.08, type: 'triangle', freq: 520, gain: 0.2 });
  }

  /* グレイト成功 */
  function skillGreat() {
    if (!ensure()) return;
    tone({ dur: 0.16, freq: 1318, gain: 0.24, toReverb: 0.5 });
    tone({ when: 0.05, dur: 0.22, freq: 1760, gain: 0.2, toReverb: 0.5 });
    noiseHit({ dur: 0.04, freq: 3200, q: 2, gain: 0.15 });
  }

  /* スキルチェック失敗 = 発電機爆発 (大きく・迫力重視) */
  function explosion(quiet) {
    if (!ensure()) return;
    const v = quiet ? 0.32 : 1;
    // 立ち上がりの鋭い「バリッ」(高め。タブレットの小さいスピーカーでもよく通る)
    noiseHit({ dur: 0.06, type: 'highpass', freq: 1900, q: 0.7, gain: 1.6 * v, toReverb: 0.35 });
    // 本体の轟音(中域中心・高→低へスイープ)
    noiseHit({ dur: 0.85, type: 'lowpass', freq: 4000, freqEnd: 120, q: 0.8,
               gain: 2.2 * v, toReverb: 0.9 });
    noiseHit({ when: 0.015, dur: 0.5, type: 'bandpass', freq: 900, q: 1.0,
               gain: 1.6 * v, toReverb: 0.7 });
    noiseHit({ when: 0.02, dur: 0.45, type: 'bandpass', freq: 2200, q: 0.9,
               gain: 1.1 * v, toReverb: 0.6 });
    // ズドンという低音(大きいスピーカー用の重み)
    tone({ dur: 0.6, type: 'sine', freq: 165, freqEnd: 30, gain: 1.4 * v, toReverb: 0.4 });
    tone({ dur: 0.5, type: 'square', freq: 82, freqEnd: 27, gain: 0.7 * v, toReverb: 0.3 });
    // 破片が飛び散る
    for (let i = 0; i < 8; i++) {
      noiseHit({ when: 0.16 + i * 0.06 + Math.random() * 0.05, dur: 0.05,
                 freq: 1800 + Math.random() * 3000, q: 8, gain: 0.18 * v, toReverb: 0.5 });
    }
  }

  /* 自分の発電機が完了 (ガチャン + エンジン始動) */
  function genDone() {
    if (!ensure()) return;
    // ガチャンッ
    noiseHit({ dur: 0.18, freq: 700, q: 3, gain: 0.5, toReverb: 0.7 });
    tone({ dur: 0.3, type: 'triangle', freq: 220, freqEnd: 90, gain: 0.4, toReverb: 0.5 });
    // エンジンが回りだす
    tone({ when: 0.15, dur: 1.3, type: 'sawtooth', freq: 38, freqEnd: 95, gain: 0.35 });
    // 明かりが灯る「ヴンッ」
    tone({ when: 1.1, dur: 0.5, type: 'sine', freq: 660, gain: 0.12, toReverb: 0.6 });
    tone({ when: 1.1, dur: 0.7, type: 'sine', freq: 1320, gain: 0.07, toReverb: 0.6 });
    setTimeout(humOn, 1200);
  }

  /* 他の発電機が完了 (遠くの鐘のような音) */
  function distantDone() {
    if (!ensure()) return;
    tone({ dur: 0.9, type: 'sine', freq: 392, gain: 0.14, toReverb: 0.9 });
    tone({ when: 0.02, dur: 1.1, type: 'sine', freq: 587, gain: 0.1, toReverb: 0.9 });
  }

  /* ゲート開放 (クラクション風の勝利音) */
  function gateOpen() {
    if (!ensure()) return;
    for (let i = 0; i < 3; i++) {
      const t = i * 0.55;
      tone({ when: t, dur: 0.45, type: 'square', freq: 392, gain: 0.16, toReverb: 0.7 });
      tone({ when: t, dur: 0.45, type: 'square', freq: 311, gain: 0.13, toReverb: 0.7 });
    }
    tone({ when: 1.7, dur: 1.8, type: 'sawtooth', freq: 196, gain: 0.14, toReverb: 0.8 });
    tone({ when: 1.7, dur: 1.8, type: 'sawtooth', freq: 261, gain: 0.12, toReverb: 0.8 });
    tone({ when: 1.7, dur: 2.2, type: 'sawtooth', freq: 392, gain: 0.1, toReverb: 0.8 });
    noiseHit({ when: 1.65, dur: 0.4, freq: 500, q: 2, gain: 0.4, toReverb: 0.8 });
  }

  /* タイムオーバー (重い低音ドローン) */
  function timeoverStart() {
    if (!ensure() || droneNodes) return;
    setRepairing(false);
    humOff();
    heartbeat(false);
    tone({ dur: 1.2, type: 'sine', freq: 120, freqEnd: 25, gain: 0.7, toReverb: 0.6 });
    noiseHit({ dur: 1.5, type: 'lowpass', freq: 900, freqEnd: 60, q: 1, gain: 0.5, toReverb: 0.9 });
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 38;
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 38.6;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 85;
    const g = ctx.createGain(); g.gain.value = 0;
    o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(master);
    o1.start(); o2.start();
    g.gain.setTargetAtTime(0.16, now() + 0.8, 1.2);
    droneNodes = { o1, o2, g };
  }

  function timeoverStop() {
    if (!droneNodes) return;
    const d = droneNodes; droneNodes = null;
    d.g.gain.setTargetAtTime(0, now(), 0.2);
    setTimeout(() => { try { d.o1.stop(); d.o2.stop(); } catch (_) {} }, 800);
  }

  /* 心音 (残り時間わずか)。intensity 0-1 で速くなる */
  let hbIntensity = 0;
  function heartbeat(on, intensity = 0) {
    hbIntensity = intensity;
    if (on && !heartbeatTimer && ensure()) {
      const beat = () => {
        if (!heartbeatTimer) return;
        tone({ dur: 0.14, type: 'sine', freq: 58, freqEnd: 36, gain: 0.5 });
        tone({ when: 0.22, dur: 0.12, type: 'sine', freq: 52, freqEnd: 34, gain: 0.38 });
        const interval = 1050 - hbIntensity * 520; // 速くなる
        heartbeatTimer = setTimeout(beat, interval);
      };
      heartbeatTimer = setTimeout(beat, 10);
    } else if (!on && heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /* 秒読みのカチッという音 */
  function tick() {
    if (!ensure()) return;
    noiseHit({ dur: 0.03, freq: 3000, q: 10, gain: 0.12 });
  }

  /* UIボタン */
  function click() {
    if (!ensure()) return;
    noiseHit({ dur: 0.04, freq: 1800, q: 6, gain: 0.1 });
  }

  /* 全停止 (リセット時) */
  function stopAll() {
    setRepairing(false);
    humOff();
    heartbeat(false);
    timeoverStop();
  }

  return {
    unlock, ready,
    setRepairing, humOn, humOff,
    skillWarn, skillGood, skillGreat, explosion,
    genDone, distantDone, gateOpen,
    timeoverStart, timeoverStop,
    heartbeat, tick, click, stopAll,
  };
})();
