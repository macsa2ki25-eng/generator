/*
 * FIND ME - 通信ヘルパー
 * サーバーからは SSE で状態を受信し、操作は fetch で送る。
 *
 * ※ EventSource の自動再接続だけには頼らない。
 *   タブレットがスリープしたり通信が一瞬切れたりすると、接続が「開いたまま
 *   データだけ来ない」状態になることがあり、その時 onerror は発生しない。
 *   放っておくと画面が固まったまま(古い表示のまま)になるので、
 *   一定時間データが来なければ自分で張り直す見張り(ウォッチドッグ)を持つ。
 */
'use strict';

const Net = (() => {
  const clientId = 'c' + Math.random().toString(36).slice(2, 10);
  const STALE_MS = 8000;  // これだけデータが来なければ接続が死んだとみなす
                          // (サーバーは0.2秒ごとに送っているので8秒は異常)
  const WAKE_STALE_MS = 3000; // 画面復帰時に、これ以上古ければ即張り直す

  let es = null;
  let connected = false;
  let lastMsgAt = 0;
  let onStateCb = null;
  let onConnCb = null;

  function connect(onState, onConn) {
    onStateCb = onState;
    onConnCb = onConn;
    open();
  }

  function open() {
    if (es) { try { es.close(); } catch (_) {} }
    lastMsgAt = Date.now();
    es = new EventSource('/api/events?client=' + clientId);
    es.onopen = () => { lastMsgAt = Date.now(); setConn(true); };
    es.onerror = () => setConn(false); // EventSourceも自動再接続を試みる
    es.onmessage = (ev) => {
      lastMsgAt = Date.now();
      setConn(true);
      try {
        const st = JSON.parse(ev.data);
        if (onStateCb) onStateCb(st);
      } catch (_) {}
    };
  }

  function isStale(ms) { return Date.now() - lastMsgAt > ms; }

  /* 見張り: データが途絶えていたら接続を張り直す(画面が固まるのを防ぐ) */
  setInterval(() => {
    if (!es) return;
    if (isStale(STALE_MS)) {
      setConn(false); // 接続バナーを出して、止まっていることが分かるようにする
      open();
    }
  }, 3000);

  /* 画面復帰・再フォーカス・ネット復帰の時は、すぐ張り直す
     (スリープ中は上の見張りタイマー自体も止められるため) */
  function refreshIfStale() {
    if (es && isStale(WAKE_STALE_MS)) open();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshIfStale();
  });
  window.addEventListener('focus', refreshIfStale);
  window.addEventListener('online', () => { if (es) open(); });
  window.addEventListener('pageshow', refreshIfStale);

  function setConn(v) {
    if (connected === v) return;
    connected = v;
    if (onConnCb) onConnCb(v);
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).catch(() => {});
  }

  return {
    clientId,
    connect,
    isConnected: () => connected,
    touch: (gen, touching) => post('/api/touch', { client: clientId, gen, touching }),
    skill: (gen, result) => post('/api/skill', { gen, result }),
    admin: (action) => post('/api/admin', { action }),
    saveSettings: (settings) => post('/api/settings', settings),
  };
})();
