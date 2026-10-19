/* ============================================================
   bridge.js — 与原生壳的 Promise 式桥接
   JS → 原生：window.webkit.messageHandlers.native.postMessage({id, cmd, args})
   原生 → JS：window.__nativeResolve(id, {ok, data|error}) / window.__nativeEvent(name, data)
   ============================================================ */
(function () {
  'use strict';

  const pending = new Map();
  let seq = 0;
  const listeners = Object.create(null);

  const hasNative = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native);

  window.__nativeResolve = function (id, payload) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (payload && payload.ok) p.resolve(payload.data);
    else p.reject(new Error((payload && payload.error) || 'native call failed'));
  };

  window.__nativeEvent = function (name, data) {
    const arr = listeners[name];
    if (!arr) return;
    for (const fn of arr) {
      try { fn(data); } catch (e) { console.error('[native event]', name, e); }
    }
  };

  function on(name, fn) {
    (listeners[name] || (listeners[name] = [])).push(fn);
  }

  function invoke(cmd, args) {
    return new Promise((resolve, reject) => {
      if (!hasNative) { reject(new Error('原生桥不可用（在浏览器中打开？）')); return; }
      const id = 'r' + (++seq);
      pending.set(id, { resolve, reject });
      try {
        window.webkit.messageHandlers.native.postMessage({ id: id, cmd: cmd, args: args || {} });
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  window.native = { invoke: invoke, on: on, available: hasNative };
})();
