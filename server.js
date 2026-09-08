#!/usr/bin/env node
/*
 * FIND ME - 発電機サーバー
 * 依存パッケージゼロ。Node.js が入っていれば `node server.js` だけで動く。
 * タブレットとは SSE (Server-Sent Events) + fetch で同期する。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

/* ------------------------------------------------------------------ */
/* 設定                                                                */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  repairSeconds: 90,      // 発電機1台の修理にかかる秒数
  limitSeconds: 300,      // 制限時間(秒)
  skillCheck: 'easy',     // off / easy / normal / hard (初期値はやさしめ)
  penaltyPercent: 8,      // スキルチェック失敗で減る%
  regression: false,      // 触っていない間ゲージが少しずつ下がる
};

let settings = { ...DEFAULT_SETTINGS };
try {
  settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
} catch (_) { /* 初回起動などファイルが無ければデフォルトを使う */ }

function sanitizeSettings(input) {
  const s = {};
  const num = (v, min, max, fallback) => {
    v = Number(v);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.round(v)));
  };
  s.repairSeconds = num(input.repairSeconds, 10, 600, settings.repairSeconds);
  s.limitSeconds = num(input.limitSeconds, 30, 1800, settings.limitSeconds);
  s.skillCheck = ['off', 'easy', 'normal', 'hard'].includes(input.skillCheck)
    ? input.skillCheck : settings.skillCheck;
  s.penaltyPercent = num(input.penaltyPercent, 0, 50, settings.penaltyPercent);
  s.regression = !!input.regression;
  return s;
}

function saveSettingsToDisk() {
  fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), () => {});
}

/* ------------------------------------------------------------------ */
/* ゲーム状態                                                          */
/* ------------------------------------------------------------------ */

function newGen() {
  return {
    progress: 0,          // 0-100
    done: false,
    touchers: new Map(),  // clientId -> 最後にタッチ信号を受けた時刻
    boomCount: 0,         // スキルチェック失敗回数(クライアントはこの増加で爆発を検知)
  };
}

const state = {
  phase: 'idle',          // idle / running / cleared / timeover
  timeLeft: settings.limitSeconds,
  gens: [newGen(), newGen(), newGen()],
};

function startGame() {
  state.phase = 'running';
  state.timeLeft = settings.limitSeconds;
  state.gens = [newGen(), newGen(), newGen()];
  broadcast();
}

function resetGame() {
  state.phase = 'idle';
  state.timeLeft = settings.limitSeconds;
  state.gens = [newGen(), newGen(), newGen()];
  broadcast();
}

/* メインループ: 20Hzで進行、5Hzで全端末へ配信 */
const TICK_MS = 50;
let tickCount = 0;
setInterval(() => {
  tickCount++;
  const dt = TICK_MS / 1000;

  if (state.phase === 'running') {
    const now = Date.now();
    const rate = 100 / Math.max(5, settings.repairSeconds); // %/秒

    for (const g of state.gens) {
      // 通信が切れた端末のタッチを自動解除
      for (const [id, t] of g.touchers) {
        if (now - t > 5000) g.touchers.delete(id);
      }
      if (g.done) continue;
      if (g.touchers.size > 0) {
        g.progress = Math.min(100, g.progress + rate * dt);
        if (g.progress >= 100) { g.progress = 100; g.done = true; }
      } else if (settings.regression && g.progress > 0) {
        g.progress = Math.max(0, g.progress - rate * 0.25 * dt);
      }
    }

    if (state.gens.every((g) => g.done)) {
      state.phase = 'cleared';
    } else {
      state.timeLeft = Math.max(0, state.timeLeft - dt);
      if (state.timeLeft <= 0) state.phase = 'timeover';
    }
  }

  if (tickCount % 4 === 0) broadcast();
}, TICK_MS);

/* ------------------------------------------------------------------ */
/* SSE (リアルタイム配信)                                              */
/* ------------------------------------------------------------------ */

const sseClients = new Map(); // res -> clientId

function statePayload() {
  return JSON.stringify({
    phase: state.phase,
    timeLeft: Math.round(state.timeLeft * 10) / 10,
    gens: state.gens.map((g) => ({
      p: Math.round(g.progress * 10) / 10,
      done: g.done,
      touch: g.touchers.size > 0,
      boom: g.boomCount,
    })),
    settings,
  });
}

function broadcast() {
  const chunk = 'data: ' + statePayload() + '\n\n';
  for (const res of sseClients.keys()) {
    try { res.write(chunk); } catch (_) { /* 切断済みは close イベントで掃除される */ }
  }
}

/* SSEが切れないようにコメント行を定期送信 */
setInterval(() => {
  for (const res of sseClients.keys()) {
    try { res.write(': ping\n\n'); } catch (_) {}
  }
}, 15000);

function handleSse(req, res, url) {
  const clientId = url.searchParams.get('client') || 'anon';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write('data: ' + statePayload() + '\n\n');
  sseClients.set(res, clientId);

  req.on('close', () => {
    sseClients.delete(res);
    // その端末が押していたタッチを解除
    for (const g of state.gens) g.touchers.delete(clientId);
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10240) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function genAt(index) {
  const i = Number(index);
  return (i >= 0 && i <= 2) ? state.gens[i] : null;
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/events') return handleSse(req, res, url);
  if (req.method === 'GET' && p === '/api/state') return json(res, 200, JSON.parse(statePayload()));
  if (req.method === 'GET' && p === '/api/ping') return json(res, 200, { ok: true });

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  let body;
  try { body = await readBody(req); } catch (_) { return json(res, 400, { error: 'bad body' }); }

  if (p === '/api/touch') {
    const g = genAt(body.gen);
    const client = String(body.client || 'anon');
    if (!g) return json(res, 400, { error: 'bad gen' });
    if (body.touching && state.phase === 'running' && !g.done) {
      g.touchers.set(client, Date.now());
    } else {
      g.touchers.delete(client);
    }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/skill') {
    const g = genAt(body.gen);
    if (!g) return json(res, 400, { error: 'bad gen' });
    if (state.phase === 'running' && !g.done) {
      if (body.result === 'fail') {
        g.progress = Math.max(0, g.progress - settings.penaltyPercent);
        g.boomCount++;
        broadcast();
      } else if (body.result === 'great') {
        g.progress = Math.min(100, g.progress + 4); // 成功ボーナス(大)
        if (g.progress >= 100) { g.done = true; }
        broadcast();
      } else if (body.result === 'good') {
        g.progress = Math.min(100, g.progress + 2); // 成功ボーナス(小)
        if (g.progress >= 100) { g.done = true; }
        broadcast();
      }
    }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/admin') {
    if (body.action === 'start') startGame();
    else if (body.action === 'reset') resetGame();
    else return json(res, 400, { error: 'bad action' });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/settings') {
    settings = sanitizeSettings(body || {});
    saveSettingsToDisk();
    if (state.phase === 'idle') state.timeLeft = settings.limitSeconds;
    broadcast();
    return json(res, 200, { ok: true, settings });
  }

  return json(res, 404, { error: 'not found' });
}

/* ------------------------------------------------------------------ */
/* 静的ファイル配信                                                    */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

function serveStatic(req, res, url) {
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/') filePath = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* サーバー起動                                                        */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(() => json(res, 500, { error: 'server error' }));
  } else {
    serveStatic(req, res, url);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`ポート ${PORT} は既に使われています。`);
    console.error('先に起動しているサーバーを閉じるか、別ポートで起動してください:');
    console.error(`  PORT=3001 node server.js`);
    console.error('');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log('');
  console.log('==================================================');
  console.log('   FIND ME  発電機サーバー 起動！');
  console.log('==================================================');
  console.log('');
  console.log(' タブレットのブラウザで、下のどれかのURLを開いてください:');
  console.log('');
  if (addrs.length === 0) {
    console.log('   (Wi-Fiに接続されていないようです。接続してから再起動してください)');
  }
  for (const a of addrs) {
    console.log(`   http://${a}:${PORT}`);
  }
  console.log('');
  console.log(` このPCで試すとき:  http://localhost:${PORT}`);
  console.log(' 止めるとき:        Ctrl + C');
  console.log('');
});
