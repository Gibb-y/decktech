/*
 * deck-runtime.js: the script the host inlines into every code component frame (arc42 §8.3).
 * It defines the global `deck`, completes the handshake (posts `ready`, receives a dedicated
 * MessagePort, then `init`), runs the component's module and forwards what the component asks
 * for over the port. It is a static asset: edit it here, keep it free of a closing script tag,
 * and bump API_VERSION (here and in host/protocol.ts) for a breaking change.
 */
(function () {
  'use strict';

  var API_VERSION = 1;
  var MAX_LOG_ARGS = 10;
  var MAX_STRING = 2000;
  var HEARTBEAT_MS = 1000;
  var hooks = window.__deckHooks || {};

  var port = null;
  var initialised = false;
  var context = null;
  var readyCallbacks = [];
  var propsCallbacks = [];
  var stepCallbacks = [];
  var state = new Map();
  var assetRequests = new Map();
  var assetCache = new Map();
  var fetchRequests = new Map();
  var nextId = 1;
  var fetchEnabled = false;

  function post(message, transfer) {
    if (!port) return;
    try {
      port.postMessage(message, transfer || []);
    } catch (e) {
      /* a message the host cannot take is the component's problem, not the runtime's */
    }
  }

  function clip(text) {
    return text.length > MAX_STRING ? text.slice(0, MAX_STRING) : text;
  }

  function printable(value) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return isFinite(value) ? value : String(value);
    if (typeof value === 'string') return clip(value);
    if (value instanceof Error) return clip(value.stack || value.message || String(value));
    try {
      var json = JSON.stringify(value);
      return clip(json === undefined ? String(value) : json);
    } catch (e) {
      return clip(String(value));
    }
  }

  function log(level, args) {
    post({ type: 'log', level: level, args: Array.prototype.slice.call(args, 0, MAX_LOG_ARGS).map(printable) });
  }

  function reportError(message, stack) {
    var report = { type: 'error', message: clip(String(message)) };
    if (stack) report.stack = clip(String(stack));
    post(report);
  }

  function copyJson(value) {
    var text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
  }

  function applyTheme(vars) {
    var root = document.documentElement.style;
    Object.keys(vars || {}).forEach(function (name) {
      if (/^--deck-[a-z]+-[A-Za-z0-9_-]+$/.test(name)) root.setProperty(name, String(vars[name]));
    });
  }

  function callAll(list, arg) {
    list.slice().forEach(function (callback) {
      try {
        callback(arg);
      } catch (e) {
        reportError(e && e.message ? e.message : e, e && e.stack);
      }
    });
  }

  function requestAsset(assetId) {
    var cached = assetCache.get(assetId);
    if (cached) return cached;
    var promise = new Promise(function (resolve, reject) {
      var id = nextId++;
      assetRequests.set(id, { resolve: resolve, reject: reject, assetId: assetId });
      post({ type: 'asset-request', id: id, assetId: String(assetId) });
    });
    promise.catch(function () {
      assetCache.delete(assetId);
    });
    assetCache.set(assetId, promise);
    return promise;
  }

  function hostFetch(url, init) {
    return new Promise(function (resolve, reject) {
      if (!fetchEnabled) return reject(new TypeError('deck.fetch needs the network permission'));
      var options = {};
      if (init && init.method) options.method = String(init.method);
      if (init && init.body !== undefined && init.body !== null) {
        if (typeof init.body !== 'string') return reject(new TypeError('deck.fetch bodies must be strings'));
        options.body = init.body;
      }
      if (init && init.headers) {
        var headers = {};
        if (typeof init.headers.forEach === 'function' && !Array.isArray(init.headers)) {
          init.headers.forEach(function (value, name) {
            headers[name] = String(value);
          });
        } else {
          Object.keys(init.headers).forEach(function (name) {
            headers[name] = String(init.headers[name]);
          });
        }
        options.headers = headers;
      }
      var id = nextId++;
      fetchRequests.set(id, { resolve: resolve, reject: reject });
      post({ type: 'fetch', id: id, url: String(url), init: options });
    });
  }

  var deck = {
    apiVersion: API_VERSION,
    mode: 'edit',
    size: { w: 0, h: 0 },
    ready: function (callback) {
      if (typeof callback !== 'function') throw new TypeError('deck.ready needs a function');
      if (initialised) queueMicrotask(function () { callOne(callback, readyContext()); });
      else readyCallbacks.push(callback);
    },
    onProps: function (callback) {
      if (typeof callback !== 'function') throw new TypeError('deck.onProps needs a function');
      propsCallbacks.push(callback);
    },
    steps: function (count) {
      if (!Number.isInteger(count) || count < 0 || count > 1000) throw new RangeError('deck.steps needs a whole number from 0 to 1000');
      post({ type: 'steps', count: count });
    },
    onStep: function (callback) {
      if (typeof callback !== 'function') throw new TypeError('deck.onStep needs a function');
      stepCallbacks.push(callback);
    },
    state: {
      get: function (key) {
        return state.has(key) ? copyJson(state.get(key)) : undefined;
      },
      set: function (key, value) {
        key = String(key);
        var copy = copyJson(value);
        if (copy === undefined) return deck.state.remove(key);
        state.set(key, copy);
        post({ type: 'state-set', key: key, value: copy });
      },
      remove: function (key) {
        key = String(key);
        state.delete(key);
        post({ type: 'state-remove', key: key });
      },
    },
    navigate: {
      next: function () { post({ type: 'navigate', action: 'next' }); },
      prev: function () { post({ type: 'navigate', action: 'prev' }); },
      goTo: function (slideId) { post({ type: 'navigate', action: 'goTo', slideId: String(slideId) }); },
    },
    assets: {
      url: function (assetId) { return requestAsset(String(assetId)); },
    },
    log: function () { log('log', arguments); },
    snapshot: function (blob) {
      if (!(blob instanceof Blob)) throw new TypeError('deck.snapshot needs a Blob');
      post({ type: 'snapshot', blob: blob });
    },
  };

  function callOne(callback, arg) {
    try {
      callback(arg);
    } catch (e) {
      reportError(e && e.message ? e.message : e, e && e.stack);
    }
  }

  function readyContext() {
    return context;
  }

  function startUserCode(js, libs) {
    var imports = {};
    libs.forEach(function (lib) {
      imports[lib.id] = URL.createObjectURL(new Blob([lib.data], { type: 'text/javascript' }));
    });
    if (Object.keys(imports).length > 0) {
      var map = document.createElement('script');
      map.type = 'importmap';
      map.textContent = JSON.stringify({ imports: imports });
      document.head.appendChild(map);
    }
    if (js.trim() === '') return;
    var script = document.createElement('script');
    script.type = 'module';
    script.src = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
    script.onerror = function () { reportError('The component script could not be loaded'); };
    document.body.appendChild(script);
  }

  function userSource() {
    var element = document.getElementById('deck-user-js');
    try {
      var js = element ? JSON.parse(element.textContent || '""') : '';
      return typeof js === 'string' ? js : '';
    } catch (e) {
      return '';
    }
  }

  function onInit(data) {
    if (initialised) return;
    initialised = true;
    deck.mode = data.mode === 'present' ? 'present' : 'edit';
    deck.size = { w: Number(data.size && data.size.w) || 0, h: Number(data.size && data.size.h) || 0 };
    applyTheme(data.theme);
    Object.keys(data.state || {}).forEach(function (key) { state.set(key, data.state[key]); });
    context = { props: data.props || {}, theme: data.theme || {}, mode: deck.mode, size: deck.size };
    if (data.permissions && data.permissions.network === true) {
      fetchEnabled = true;
      deck.fetch = hostFetch;
    }
    callAll(readyCallbacks, context);
    readyCallbacks = [];
    var libs = Array.isArray(data.libs) ? data.libs : [];
    (hooks.loadModule || startUserCode)(userSource(), libs);
  }

  function onPortMessage(event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'init':
        onInit(data);
        break;
      case 'props':
        if (context) context.props = data.props || {};
        callAll(propsCallbacks, data.props || {});
        break;
      case 'theme':
        applyTheme(data.theme);
        break;
      case 'size':
        deck.size = { w: Number(data.size && data.size.w) || 0, h: Number(data.size && data.size.h) || 0 };
        break;
      case 'step':
        callAll(stepCallbacks, data.index);
        break;
      case 'asset': {
        var pending = assetRequests.get(data.id);
        if (!pending) break;
        assetRequests.delete(data.id);
        if (data.data) pending.resolve(URL.createObjectURL(new Blob([data.data], { type: data.mime || 'application/octet-stream' })));
        else pending.reject(new Error('Asset "' + pending.assetId + '" is not available to this component'));
        break;
      }
      case 'fetch-result': {
        var request = fetchRequests.get(data.id);
        if (!request) break;
        fetchRequests.delete(data.id);
        if (data.error && !data.status) request.reject(new TypeError(data.error));
        else request.resolve(new Response(data.body, { status: data.status, statusText: data.statusText, headers: data.headers }));
        break;
      }
    }
  }

  function onWindowMessage(event) {
    // Only the parent may hand over the port, and only once.
    if (port || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'port' || !event.ports || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = onPortMessage;
    window.removeEventListener('message', onWindowMessage);
    post({ type: 'heartbeat' });
    setInterval(function () { post({ type: 'heartbeat' }); }, HEARTBEAT_MS);
  }

  function handshake() {
    window.addEventListener('message', onWindowMessage);
    window.parent.postMessage({ type: 'ready', apiVersion: API_VERSION }, '*');
  }

  // Navigation never happens inside the frame: links go to the host, which asks the user first.
  document.addEventListener(
    'click',
    function (event) {
      var node = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!node) return;
      var href = node.getAttribute('href') || '';
      if (href.charAt(0) === '#') return;
      event.preventDefault();
      if (/^(https?:|mailto:)/i.test(node.href)) post({ type: 'link', url: node.href });
    },
    true,
  );
  document.addEventListener('submit', function (event) { event.preventDefault(); }, true);
  window.open = function (url) {
    if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) post({ type: 'link', url: url });
    return null;
  };

  ['log', 'info', 'warn', 'error'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      log(level, arguments);
      if (original) original.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (event) {
    reportError(event.message || 'Script error', event.error && event.error.stack);
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    reportError(reason && reason.message ? reason.message : String(reason), reason && reason.stack);
  });

  Object.defineProperty(window, 'deck', { value: deck, writable: false, configurable: false });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', handshake);
  else handshake();
})();
