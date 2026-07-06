/*
 * FIND ME - 通信ヘルパー
 * サーバーからは SSE で状態を受信し、操作は fetch で送る。
 * 接続が切れても EventSource が自動で再接続する。
 */
'use strict';

const Net = (() => {
  const clientId = 'c' + Math.random().toString(36).slice(2, 10);
  let es = null;
  let connected = false;
  let onStateCb = null;
  let onConnCb = null;

  function connect(onState, onConn) {
    onStateCb = onState;
    onConnCb = onConn;
    open();
  }

  function open() {
    if (es) es.close();
    es = new EventSource('/api/events?client=' + clientId);
    es.onopen = () => setConn(true);
    es.onerror = () => setConn(false); // EventSourceが自動再接続する
    es.onmessage = (ev) => {
      setConn(true);
      try {
        const st = JSON.parse(ev.data);
        if (onStateCb) onStateCb(st);
      } catch (_) {}
    };
  }

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
