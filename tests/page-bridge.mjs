import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const pageSource = await readFile(new URL('../page.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('../bridge.js', import.meta.url), 'utf8');
const placeholderSource = await readFile(new URL('../placeholder.js', import.meta.url), 'utf8');
const channel = 'full-screen-assistant/v1';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function styleDeclaration() {
  const values = new Map();
  const groups = { margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'], inset: ['top', 'right', 'bottom', 'left'], overflow: ['overflow-x', 'overflow-y'] };
  const cssName = key => key === 'webkitBackdropFilter' ? '-webkit-backdrop-filter' : key.replace(/[A-Z]/g, x => '-' + x.toLowerCase());
  const api = {
    setProperty(name, value, priority = '') {
      value = String(value);
      if (groups[name]) {
        const tokens = value.trim().split(/\s+/);
        const sides = groups[name].length === 2 ? [tokens[0], tokens[1] || tokens[0]] : [tokens[0], tokens[1] || tokens[0], tokens[2] || tokens[0], tokens[3] || tokens[1] || tokens[0]];
        groups[name].forEach((key, i) => values.set(key, { value: sides[i], priority }));
      } else if (name === 'background') {
        values.set('background-color', { value, priority });
        values.set('background-image', { value: 'none', priority });
      } else values.set(name, { value, priority });
    },
    getPropertyValue(name) {
      if (groups[name]) {
        const entries = groups[name].map(key => values.get(key));
        if (entries.some(x => !x) || new Set(entries.map(x => x.priority)).size !== 1) return '';
        const [a, b, c, d] = entries.map(x => x.value);
        if (entries.length === 2) return a === b ? a : `${a} ${b}`;
        return a === b && a === c && a === d ? a : a === c && b === d ? `${a} ${b}` : `${a} ${b} ${c} ${d}`;
      }
      if (name === 'background') {
        const color = values.get('background-color'), image = values.get('background-image');
        if (!color) return '';
        return image && image.value !== 'none' ? color.value + ' ' + image.value : color.value;
      }
      return values.get(name)?.value || '';
    },
    getPropertyPriority(name) {
      if (groups[name]) {
        const priorities = groups[name].map(key => values.get(key)?.priority);
        return new Set(priorities).size === 1 ? priorities[0] || '' : '';
      }
      return values.get(name)?.priority || '';
    },
    removeProperty(name) {
      const old = this.getPropertyValue(name);
      if (groups[name]) groups[name].forEach(key => values.delete(key));
      else values.delete(name);
      return old;
    },
  };
  return new Proxy(api, {
    get(target, key) {
      if (key === 'cssText') return [...values].map(([name, item]) => `${name}:${item.value}${item.priority ? ' !' + item.priority : ''}`).join(';');
      if (key in target) return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      return typeof key === 'string' ? target.getPropertyValue(cssName(key)) : undefined;
    },
    set(target, key, value) {
      if (key === 'cssText') {
        values.clear();
        for (const entry of String(value).split(';')) {
          const colon = entry.indexOf(':');
          if (colon < 0) continue;
          const name = entry.slice(0, colon).trim();
          const raw = entry.slice(colon + 1).trim();
          target.setProperty(name, raw.replace(/\s*!important$/, ''), /!important$/.test(raw) ? 'important' : '');
        }
      } else target.setProperty(cssName(key), value);
      return true;
    },
  });
}

function harness({ page = true, bridge = false, reduced = false, runtimeHandler, sourceUrl = 'https://example.test/video' } = {}) {
  let time = 100000, timerId = 0, requestId = 0;
  const timers = new Map(), posted = [], runtimeSent = [], errors = [], observers = [];
  const calls = { native: [], exits: 0, clones: 0, captures: 0, peers: 0, snapshots: [], popovers: [] };
  const settings = { nativeReject: false, nextRequest: null, nextExit: null, reduced, nativeChanged: null };
  const setTimer = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { due: time + delay, fn }); return id; };
  class Target {
    listeners = new Map();
    addEventListener(type, fn, options = {}) { const entries = this.listeners.get(type) || []; entries.push({ fn, once: options.once }); this.listeners.set(type, entries); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x.fn !== fn)); }
    dispatch(type, event = {}) {
      event.type ||= type;
      event.preventDefault ||= () => { event.defaultPrevented = true; };
      event.stopImmediatePropagation ||= () => { event.stopped = true; };
      for (const entry of [...this.listeners.get(type) || []]) {
        if (entry.once) this.removeEventListener(type, entry.fn);
        try { const result = entry.fn.call(this, event); result?.catch?.(error => errors.push(error)); }
        catch (error) { errors.push(error); }
        if (event.stopped) break;
      }
    }
    dispatchEvent(event) { event.target ||= this; this.dispatch(event.type, event); return !event.defaultPrevented; }
  }
  const window = new Target();
  window.parent = window;
  window.top = window;
  window.location = { href: sourceUrl };
  let document;
  class Element extends Target {
    constructor(name = 'div') { super(); this.localName = name; this.children = []; this.parentElement = null; this.style = styleDeclaration(); this.attributes = new Map(); this.rect = { left: 32, top: 64, width: 640, height: 360 }; }
    get isConnected() { return this === document.documentElement || !!this.parentElement?.isConnected; }
    append(...elements) { for (const element of elements) { element.remove(); element.parentElement = this; this.children.push(element); } }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    querySelectorAll(selector) {
      const result = [];
      const match = node => selector === '*' || selector === node.localName || selector === 'button,[role=button]' && (node.localName === 'button' || node.getAttribute('role') === 'button');
      const walk = node => { for (const child of node.children) { if (match(child)) result.push(child); walk(child); } };
      walk(this); return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
    attachShadow({ mode }) { const shadow = new Element('#shadow-root'); shadow.host = this; this._shadow = shadow; if (mode === 'open') this.shadowRoot = shadow; return shadow; }
    showPopover() { calls.popovers.push({ host: this, fullscreen: document.fullscreenElement }); }
    hidePopover() {}
    dispatchEvent(event) {
      super.dispatchEvent(event);
      if (event.bubbles && !event.stopped) (this.parentElement || (this === document.documentElement ? document : null))?.dispatchEvent(event);
      return !event.defaultPrevented;
    }
    cloneNode() { calls.clones++; throw new Error('A source video/player must not be cloned'); }
    async requestFullscreen(...args) {
      calls.native.push({ target: this, args });
      const pending = settings.nextRequest; settings.nextRequest = null;
      if (pending) await pending;
      if (settings.nativeReject) throw new Error('Transient activation unavailable');
      document.fullscreenElement = this;
      window.dispatch('fullscreenchange');
      settings.nativeChanged?.(true);
    }
  }
  Element.prototype.webkitRequestFullscreen = Element.prototype.requestFullscreen;
  Element.prototype.webkitRequestFullScreen = Element.prototype.requestFullscreen;
  const nativeRequest = Element.prototype.requestFullscreen;
  class Document extends Target {
    constructor() { super(); this.title = 'Original video page'; this._fullscreenElement = null; this.documentElement = new Element('html'); this.body = new Element('body'); this.documentElement.append(this.body); }
    get fullscreenElement() { return this._fullscreenElement; }
    set fullscreenElement(value) { this._fullscreenElement = value; }
    get webkitFullscreenElement() { return this._fullscreenElement; }
    get webkitCurrentFullScreenElement() { return this._fullscreenElement; }
    get fullscreen() { return !!this._fullscreenElement; }
    get webkitIsFullScreen() { return !!this._fullscreenElement; }
    dispatchEvent(event) { super.dispatchEvent(event); if (event.bubbles && !event.stopped) window.dispatchEvent(event); return !event.defaultPrevented; }
    querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
    createElement(name) {
      const element = new Element(name);
      if (name === 'canvas') {
        element.getContext = () => ({ drawImage: source => calls.snapshots.push(source) });
        element.toDataURL = () => 'data:image/jpeg;base64,c25hcHNob3Q=';
      }
      return element;
    }
    exitFullscreen() {
      calls.exits++;
      document.fullscreenElement = null;
      window.dispatch('fullscreenchange');
      settings.nativeChanged?.(false);
      const pending = settings.nextExit; settings.nextExit = null;
      return pending || Promise.resolve();
    }
  }
  document = new Document();
  const wrapper = new Element('section'), video = new Element('video'), controls = new Element('button');
  Object.assign(video, { videoWidth: 3840, videoHeight: 2160, readyState: 4, paused: false, currentTime: 44.5, currentSrc: 'blob:original-media', controls: true });
  wrapper.append(video, controls); document.body.append(wrapper);
  video.captureStream = () => { calls.captures++; throw new Error('No media capture in original-tab architecture'); };
  const runtimeListeners = [];
  const chrome = { runtime: {
    id: 'extension-id',
    onMessage: { addListener: fn => runtimeListeners.push(fn) },
    sendMessage: async message => { runtimeSent.push(structuredClone(message)); return runtimeHandler ? runtimeHandler(message) : { sessionId: 'moved-original-tab', ok: true }; },
  } };
  window.postMessage = message => { posted.push(structuredClone(message)); queueMicrotask(() => window.dispatch('message', { source: window, data: structuredClone(message) })); };
  class TestDate extends Date { static now() { return time; } }
  const context = vm.createContext({
    window, document, location: window.location, URL, Element, Document,
    Event: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); this.isTrusted = false; } }, innerWidth: 1280, innerHeight: 800,
    crypto: { randomUUID: () => `request-${++requestId}` }, chrome, console,
    setTimeout: setTimer, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => setTimer(fn, 16), Date: TestDate,
    cancelAnimationFrame: id => timers.delete(id),
    matchMedia: () => ({ matches: settings.reduced }),
    getComputedStyle: element => new Proxy(element.style, { get: (style, key) => style[key] || ({ visibility: 'visible', display: 'block', borderRadius: '0px', transform: 'none', filter: 'none', perspective: 'none', contain: 'none', contentVisibility: 'visible', clipPath: 'none' })[key] || '' }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; this.disconnected = false; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    RTCPeerConnection: function () { calls.peers++; throw new Error('No RTC re-encoding in original-tab architecture'); },
  });
  if (bridge) vm.runInContext(bridgeSource, context, { filename: 'bridge.js' });
  if (page) vm.runInContext(pageSource, context, { filename: 'page.js' });
  async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); if (errors.length) throw errors.shift(); }
  async function advance(milliseconds) {
    const end = time + milliseconds;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      time = next[1].due; timers.delete(next[0]); next[1].fn(); await flush();
    }
    time = end; await flush();
  }
  async function message(data, direction = 'extension') { window.dispatch('message', { source: window, data: { channel, direction, ...data } }); await flush(); }
  function runtime(message, sender = { id: 'extension-id' }) { const responses = []; const returns = runtimeListeners.map(fn => fn(message, sender, response => responses.push(response))); return { responses, returns }; }
  const startMessage = () => posted.findLast(message => message.direction === 'page' && message.type === 'start');
  const covers = () => document.documentElement.children.filter(element => element.attributes.has('data-full-screen-assistant'));
  return { window, document, wrapper, video, controls, calls, settings, posted, runtimeSent, observers, timers, Element, Document,
    flush, advance, message, runtime, startMessage, covers, nativeRequest,
    setTimer,
    frameMessage: async (data, source) => { window.dispatch('message', { source, data: structuredClone({ channel, direction: 'frame', ...data }) }); await flush(); },
    gesture: () => window.dispatch('pointerdown', { isTrusted: true }),
    node: name => new Element(name),
  };
}

async function moved(h, request = h.startMessage()) { await h.message({ type: 'started', requestId: request.requestId, sessionId: 'moved-original-tab' }); }

async function confirmUnmanaged(h) {
  const query = h.posted.findLast(message => message.direction === 'page' && message.type === 'tab-state');
  assert.ok(query, 'A raw native fullscreen candidate must query tab ownership before recovery');
  await h.message({ type: 'tab-state', requestId: query.requestId, known: true, sessionId: null });
}

function attachFrame(parent, child, container = parent.wrapper) {
  const frame = parent.node('iframe');
  frame.contentWindow = child.window;
  container.append(frame);
  child.window.parent = { postMessage: message => {
    queueMicrotask(() => parent.window.dispatch('message', { source: child.window, data: structuredClone(message) }));
  } };
  child.window.top = parent.window.top;
  child.settings.nativeChanged = entered => {
    parent.document.fullscreenElement = entered ? frame : null;
    parent.window.dispatch('fullscreenchange');
    parent.settings.nativeChanged?.(entered);
  };
  return frame;
}

async function flushFrames(...frames) {
  for (let i = 0; i < 4; i++) for (const frame of frames) await frame.flush();
}

function frameRuntime(message) {
  if (message.type === 'FSA_START') return { sessionId: 'moved-original-tab', expandToken: 'private-expansion-token' };
  if (message.type === 'FSA_EXPAND_ALLOWED') return { ok: message.sessionId === 'moved-original-tab' && message.token === 'private-expansion-token' };
  return { ok: true };
}

function placeholderHarness({ hash = '#a1234567-abcd-4abc-8def-0123456789ab', runtimeHandler = () => ({ ok: true }), historyState = null } = {}) {
  const h = harness({ page: false });
  const exit = h.node('button'), preview = h.node('img'), favicon = h.node('link'), classes = new Set(), sent = [], runtimeListeners = [];
  exit.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  exit.hidden = true;
  preview.hidden = true;
  Object.defineProperty(preview, 'src', { get: () => preview.getAttribute('src') || '', set: value => preview.setAttribute('src', value) });
  h.document.querySelector = selector => selector === '#exit' ? exit : selector === '#preview' ? preview : selector === '#favicon' ? favicon : null;
  const replacements = [], historyWrites = [];
  const history = {
    state: historyState,
    replaceState(state, title, url) { this.state = structuredClone(state); historyWrites.push({ state: structuredClone(state), title, url }); },
    pushState() { throw new Error('Recovery must not add history entries'); },
  };
  const location = { hash, replace: url => replacements.push(url) };
  const context = vm.createContext({
    window: h.window, document: h.document, location, history, URL, console,
    setTimeout: h.setTimer,
    clearTimeout: id => h.timers.delete(id),
    requestAnimationFrame: fn => h.setTimer(fn, 16),
    cancelAnimationFrame: id => h.timers.delete(id),
    chrome: { runtime: { id: 'extension-id', getURL: path => `chrome-extension://extension-id/${path}`, onMessage: { addListener: fn => runtimeListeners.push(fn) }, sendMessage: async message => { sent.push(structuredClone(message)); return runtimeHandler(message); } } },
  });
  vm.runInContext(placeholderSource, context, { filename: 'placeholder.js' });
  return { ...h, exit, preview, favicon, sent, classes, history, historyWrites, replacements,
    runtime(message, sender = { id: 'extension-id' }) {
      const responses = [], returns = runtimeListeners.map(fn => fn(message, sender, response => responses.push(response)));
      return { responses, returns };
    },
  };
}


test('page: the original target/options enter only after the original tab is moved; no player clone, capture or RTC', async () => {
  const h = harness();
  const options = { navigationUI: 'hide', screen: { id: 'chosen-screen' } };
  const promise = h.wrapper.requestFullscreen(options);
  await h.flush();
  assert.equal(h.calls.native.length, 0);
  assert.equal(h.startMessage().preview.startsWith('data:image/jpeg;base64,'), true);
  await moved(h); await promise;
  assert.equal(h.calls.native.length, 1);
  assert.equal(h.calls.native[0].target, h.wrapper);
  assert.equal(h.calls.native[0].args[0], options);
  assert.equal(h.video.parentElement, h.wrapper);
  assert.equal(h.wrapper.querySelector('button'), h.controls);
  assert.equal(h.video.currentSrc, 'blob:original-media');
  assert.equal(h.video.videoWidth, 3840);
  assert.equal(h.video.currentTime, 44.5);
  assert.equal(h.calls.clones + h.calls.captures + h.calls.peers, 0);
  assert.deepEqual(h.calls.snapshots, [h.video]);
});

test('page: pending retargeting cannot fullscreen the main window before started', async () => {
  const h = harness();
  const first = h.video.requestFullscreen({ navigationUI: 'auto' });
  const options = { navigationUI: 'hide' };
  const second = h.wrapper.requestFullscreen(options);
  await h.flush();
  assert.equal(h.calls.native.length, 0);
  assert.equal(h.posted.filter(x => x.type === 'start').length, 1);
  await moved(h); await Promise.all([first, second]);
  assert.equal(h.calls.native[0].target, h.wrapper);
  assert.equal(h.calls.native[0].args[0], options);
});

test('page: failed movement preserves the page, and late old messages/timeouts do not affect a new session', async () => {
  const h = harness();
  h.wrapper.style.width = '70%';
  const first = h.wrapper.requestFullscreen(); await h.flush();
  const old = h.startMessage();
  await h.message({ type: 'started', requestId: old.requestId, error: 'Unable to move tab' });
  await first;
  assert.equal(h.calls.native.length, 0);
  assert.equal(h.wrapper.style.width, '70%');
  await h.advance(1000);
  const next = h.wrapper.requestFullscreen(); await h.flush();
  const current = h.startMessage();
  assert.notEqual(current.requestId, old.requestId);
  await moved(h, current); await next;
  await h.message({ type: 'started', requestId: old.requestId, error: 'Late old failure' });
  await h.advance(15000);
  assert.equal(h.document.fullscreenElement, h.wrapper);
  assert.equal(h.posted.filter(x => x.type === 'stop').length, 0);
});

test('page: CSS fallback exposes the selected fullscreen target and bubbles entry/exit events after state changes', async () => {
  const h = harness(); h.settings.nativeReject = true;
  const states = [], webkit = [];
  h.document.addEventListener('fullscreenchange', event => states.push({ target: event.target, element: h.document.fullscreenElement, trusted: event.isTrusted }));
  h.window.addEventListener('webkitfullscreenchange', () => webkit.push(h.document.webkitFullscreenElement));
  const source = h.video.currentSrc, controls = h.controls;
  const pending = h.wrapper.requestFullscreen(); await h.flush(); const request = h.startMessage();
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(states.length, 0, 'The original browser must not expose a fake fullscreen target before the tab moves');
  await moved(h); await pending;
  assert.equal(h.document.fullscreenElement, h.wrapper);
  assert.equal(h.document.webkitFullscreenElement, h.wrapper);
  assert.equal(h.document.webkitCurrentFullScreenElement, h.wrapper);
  assert.equal(h.document.fullscreen, true);
  assert.equal(h.document.webkitIsFullScreen, true);
  assert.deepEqual(states.map(x => x.element), [h.wrapper]);
  assert.equal(states[0].target, h.wrapper); assert.equal(states[0].trusted, false);
  assert.deepEqual(webkit, [h.wrapper]);
  assert.equal(h.posted.some(x => x.type === 'exit' || x.type === 'stop'), false, 'A synthetic entry must not trigger native recovery or an automatic return');
  await h.message({ type: 'prepare-restore', requestId: request.requestId, prepareId: 'fallback-exit', animate: false });
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.document.webkitFullscreenElement, null);
  assert.equal(h.document.fullscreen, false);
  assert.deepEqual(states.map(x => x.element), [h.wrapper, null]);
  assert.deepEqual(webkit, [h.wrapper, null]);
  assert.equal(h.calls.exits, 0, 'Ending CSS fullscreen must not call the native exit API');
  await h.message({ type: 'restored', requestId: request.requestId, animate: false });
  assert.equal(states.length, 2); assert.equal(h.video.currentSrc, source); assert.equal(h.controls, controls);
});

test('page: fallback getters preserve actual native state, other documents, and disconnected targets', async () => {
  const h = harness(); h.settings.nativeReject = true;
  const pending = h.wrapper.requestFullscreen(); await h.flush(); const request = h.startMessage(); await moved(h); await pending;
  const real = h.node('aside'); h.document.body.append(real);
  h.document.fullscreenElement = real;
  assert.equal(h.document.fullscreenElement, real);
  assert.equal(h.document.webkitFullscreenElement, real);
  const other = new h.Document();
  assert.equal(other.fullscreenElement, null); assert.equal(other.fullscreen, false);
  other.fullscreenElement = real;
  assert.equal(other.fullscreenElement, real);
  h.document.fullscreenElement = null;
  assert.equal(h.document.fullscreenElement, h.wrapper);
  h.wrapper.remove();
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.document.webkitIsFullScreen, false);
  assert.equal(Object.hasOwn(h.Document.prototype, 'webkitFullScreen'), false, 'Unavailable aliases must not be invented');
  await h.message({ type: 'prepare-restore', requestId: request.requestId, prepareId: 'disconnected-exit', animate: false });
  await h.message({ type: 'restored', requestId: request.requestId, animate: false });
});

test('page: fallback restores untouched longhands and preserves concurrent website style edits', async () => {
  const h = harness(); h.settings.nativeReject = true;
  h.wrapper.style.position = 'relative';
  h.wrapper.style.setProperty('width', '70%', 'important');
  h.wrapper.style.margin = '8px 12px';
  h.wrapper.style.backgroundColor = 'navy';
  h.wrapper.style.backgroundImage = 'url(original-player-image)';
  const frame = h.node('iframe'); frame.style.width = '640px'; frame.style.setProperty('height', '360px', 'important'); h.wrapper.append(frame);
  const pending = h.wrapper.requestFullscreen(); await h.flush(); const start = h.startMessage();
  await moved(h); await pending;
  assert.equal(h.wrapper.style.position, 'fixed');
  h.wrapper.style.marginLeft = '17px';
  h.wrapper.style.setProperty('top', '99px', 'important');
  h.wrapper.style.setProperty('width', '83%', 'important');
  h.wrapper.style.backgroundColor = 'rebeccapurple';
  h.wrapper.style.transform = 'rotate(1deg)';
  frame.style.width = '75%';
  await h.message({ type: 'prepare-restore', requestId: start.requestId, prepareId: 'prepare-1', animate: false });
  await h.message({ type: 'restored', requestId: start.requestId, animate: false });
  assert.equal(h.wrapper.style.position, 'relative');
  assert.equal(h.wrapper.style.marginTop, '8px');
  assert.equal(h.wrapper.style.marginRight, '12px');
  assert.equal(h.wrapper.style.marginBottom, '8px');
  assert.equal(h.wrapper.style.marginLeft, '17px');
  assert.equal(h.wrapper.style.getPropertyPriority('margin-left'), '');
  assert.equal(h.wrapper.style.top, '99px');
  assert.equal(h.wrapper.style.getPropertyPriority('top'), 'important');
  assert.equal(h.wrapper.style.width, '83%');
  assert.equal(h.wrapper.style.backgroundImage, 'url(original-player-image)');
  assert.equal(h.wrapper.style.backgroundColor, 'rebeccapurple');
  assert.equal(h.wrapper.style.transform, 'rotate(1deg)');
  assert.equal(frame.style.width, '75%');
  assert.equal(frame.style.height, '360px');
  assert.equal(frame.style.getPropertyPriority('height'), 'important');
});

test('page: same-document fallback escapes transformed and clipped ancestors without losing concurrent website edits', async () => {
  const h = harness(); h.settings.nativeReject = true;
  const scope = h.node('div');
  scope.style.transform = 'translateZ(0)'; scope.style.filter = 'blur(1px)';
  scope.style.contain = 'layout paint'; scope.style.overflow = 'hidden auto';
  h.document.body.append(scope); scope.append(h.wrapper);
  const pending = h.wrapper.requestFullscreen(); await h.flush(); const start = h.startMessage();
  await moved(h); await pending;
  assert.equal(scope.style.transform, 'none');
  assert.equal(scope.style.filter, 'none');
  assert.equal(scope.style.contain, 'none');
  assert.equal(scope.style.overflowX, 'visible');
  assert.equal(scope.style.overflowY, 'visible');
  scope.style.transform = 'rotate(2deg)'; scope.style.overflowY = 'scroll';
  await h.message({ type: 'prepare-restore', requestId: start.requestId, prepareId: 'prepare-1', animate: false });
  await h.message({ type: 'restored', requestId: start.requestId, animate: false });
  assert.equal(scope.style.transform, 'rotate(2deg)');
  assert.equal(scope.style.filter, 'blur(1px)');
  assert.equal(scope.style.contain, 'layout paint');
  assert.equal(scope.style.overflowX, 'hidden');
  assert.equal(scope.style.overflowY, 'scroll');
  assert.equal(scope.style.getPropertyPriority('overflow-x'), '');
});

test('page: restoration creates one ordinary cover only after native exit, then reveals the same live video', async () => {
  const h = harness(); const pending = h.wrapper.requestFullscreen(); await h.flush(); const start = h.startMessage(); await moved(h); await pending;
  const nativeExit = deferred(); h.settings.nextExit = nativeExit.promise;
  await h.message({ type: 'prepare-restore', requestId: start.requestId, prepareId: 'prepare-1', animate: true });
  assert.equal(h.calls.exits, 1);
  assert.equal(h.covers().length, 0, 'No blur or top-layer overlay is added while native exit is pending');
  nativeExit.resolve(); await h.flush();
  const [host] = h.covers(); assert.ok(host);
  assert.equal(host.getAttribute('popover'), null);
  assert.equal(h.calls.popovers.length, 0);
  const layer = host._shadow.children[0];
  assert.equal(layer.textContent, '点按以退出全屏幕');
  assert.equal(layer.style.backdropFilter, 'blur(64px)');
  assert.equal(h.posted.some(x => x.type === 'restore-prepared' && x.prepareId === 'prepare-1'), false);
  await h.advance(32);
  assert.ok(h.posted.some(x => x.type === 'restore-prepared' && x.prepareId === 'prepare-1'));
  await h.message({ type: 'restored', requestId: start.requestId, animate: true });
  assert.equal(layer.style.backdropFilter, 'blur(64px)');
  await h.advance(16);
  assert.equal(layer.style.backdropFilter, 'blur(64px)', 'The first frame must keep the blur while the returned layout settles');
  await h.advance(16);
  assert.equal(layer.style.backdropFilter, 'blur(0px)');
  assert.equal(layer.style.webkitBackdropFilter, 'blur(0px)');
  assert.match(layer.style.transition, /480ms/);
  assert.equal(h.video.currentTime, 44.5);
  assert.equal(h.video.paused, false);
  assert.equal(h.calls.popovers.length, 0, 'Layout updates must not hide and recreate a top-layer surface');
  await h.advance(750);
  assert.equal(h.covers().length, 0);
  assert.equal(h.observers.every(observer => observer.disconnected), true);
});

test('page: reduced motion restores immediately without creating a blur cover', async () => {
  const h = harness({ reduced: true }); const pending = h.video.requestFullscreen(); await h.flush(); const start = h.startMessage(); await moved(h); await pending;
  await h.message({ type: 'prepare-restore', requestId: start.requestId, prepareId: 'prepare-1', animate: true });
  await h.message({ type: 'restored', requestId: start.requestId, animate: true });
  assert.equal(h.covers().length, 0);
  assert.equal(h.observers.length, 0);
});

test('page: entry leaves the original layout and video clear until the real tab is moved, without popovers or an entry reveal', async () => {
  for (const nativeReject of [false, true]) {
    const h = harness(); h.settings.nativeReject = nativeReject;
    const pending = h.wrapper.requestFullscreen(); await h.flush(); const start = h.startMessage();
    await h.message({ type: 'prepare-move', requestId: start.requestId, prepareId: 'obsolete-move' });
    await h.advance(500);
    assert.equal(h.wrapper.style.position, '');
    assert.equal(h.covers().length, 0);
    assert.equal(h.calls.native.length, 0);
    assert.equal(h.posted.some(x => x.type === 'restore-prepared'), false);
    await moved(h); await pending;
    assert.equal(h.calls.native.length, 1);
    assert.equal(h.wrapper.style.position, nativeReject ? 'fixed' : '');
    assert.equal(h.covers().length, 0);
    assert.equal(h.calls.popovers.length, 0);
    assert.equal(h.video.currentSrc, 'blob:original-media');
    assert.equal(h.video.currentTime, 44.5);
    assert.equal(h.wrapper.children[1], h.controls);
  }
});

test('page: movement failure and a new request remove return reveal callbacks without changing the media', async () => {
  const h = harness(); const pending = h.wrapper.requestFullscreen(); await h.flush(); const old = h.startMessage();
  await h.message({ type: 'started', requestId: old.requestId, error: 'Window creation failed' }); await pending;
  assert.equal(h.wrapper.style.position, '');
  assert.equal(h.covers().length, 0);
  assert.equal(h.timers.size, 0);
  const next = h.wrapper.requestFullscreen(); await h.flush(); await moved(h); await next;
  const current = h.startMessage();
  await h.message({ type: 'prepare-restore', requestId: current.requestId, prepareId: 'return', animate: true });
  await h.advance(32);
  await h.message({ type: 'restored', requestId: current.requestId, animate: true });
  assert.equal(h.covers().length, 1);
  const third = h.wrapper.requestFullscreen(); await h.flush();
  assert.equal(h.covers().length, 0, 'Starting a fresh request cancels the previous reveal before its deferred frames run');
  await moved(h); await third; await h.advance(1000);
  assert.equal(h.document.fullscreenElement, h.wrapper);
  assert.equal(h.covers().length, 0);
  assert.equal(h.timers.size, 0);
});

test('page+bridge: obsolete move preparation cannot change the original layout or start an overlay', async () => {
  const gate = deferred();
  const h = harness({ bridge: true, runtimeHandler: message => message.type === 'FSA_START' ? gate.promise : { ok: true } });
  h.gesture(); const pending = h.wrapper.requestFullscreen(); await h.flush(); const start = h.startMessage();
  const before = h.runtimeSent.length;
  const preparation = h.runtime({ type: 'FSA_PREPARE_MOVE', requestId: start.requestId });
  await h.flush(); await h.advance(500);
  assert.equal(preparation.returns[0], undefined);
  assert.equal(preparation.responses.length, 0);
  assert.equal(h.wrapper.style.position, '');
  assert.equal(h.covers().length, 0);
  assert.equal(h.runtimeSent.length, before);
  assert.equal(h.calls.native.length, 0);
  gate.resolve({ sessionId: 'moved-original-tab' }); await h.flush(); await pending;
  assert.equal(h.calls.native.length, 1);
});

test('page: a failed restore can be retried without swallowing the second exit request', async () => {
  const h = harness(); const pending = h.wrapper.requestFullscreen(); await h.flush(); const start = h.startMessage(); await moved(h); await pending;
  const first = h.document.exitFullscreen(); await h.flush();
  await h.message({ type: 'restore-failed', requestId: start.requestId }); await first;
  const second = h.document.exitFullscreen(); await h.flush();
  assert.notEqual(first, second);
  assert.equal(h.posted.filter(x => x.type === 'exit').length, 2);
  await h.message({ type: 'prepare-restore', requestId: start.requestId, prepareId: 'prepare-2', animate: false });
  await h.message({ type: 'restored', requestId: start.requestId, animate: false }); await second;
  assert.equal(h.document.fullscreenElement, null);
});

test('page: a fullscreen click after a partial restore retries the old return before a fresh move can enter natively', async () => {
  const h = harness();
  const first = h.wrapper.requestFullscreen(); await h.flush(); const old = h.startMessage(); await moved(h); await first;
  await h.message({ type: 'prepare-restore', requestId: old.requestId, prepareId: 'partial-return', animate: false });
  await h.message({ type: 'restore-failed', requestId: old.requestId });
  assert.equal(h.document.fullscreenElement, null);
  const options = { navigationUI: 'hide' };
  const failedRetry = h.video.requestFullscreen(options); await h.flush();
  assert.equal(h.calls.native.length, 1, 'The old moved permission cannot fullscreen a tab already back in the original browser');
  assert.equal(h.posted.filter(message => message.type === 'start').length, 1);
  assert.equal(h.posted.filter(message => message.type === 'exit').length, 1);
  await h.message({ type: 'restore-failed', requestId: old.requestId }); await failedRetry;
  assert.equal(h.calls.native.length, 1);
  const successfulRetry = h.video.requestFullscreen(options); await h.flush();
  assert.equal(h.posted.filter(message => message.type === 'exit').length, 2);
  await h.message({ type: 'prepare-restore', requestId: old.requestId, prepareId: 'second-return', animate: false });
  await h.message({ type: 'restored', requestId: old.requestId, animate: false });
  const next = h.startMessage(); assert.notEqual(next.requestId, old.requestId);
  assert.equal(h.calls.native.length, 1, 'A new move acknowledgement is still required after the old return succeeds');
  await moved(h, next); await successfulRetry;
  assert.equal(h.calls.native.length, 2);
  assert.equal(h.calls.native.at(-1).target, h.video);
  assert.equal(h.calls.native.at(-1).args[0], options);
  assert.equal(h.posted.filter(message => message.type === 'start').length, 2);
  assert.equal(h.timers.size, 0);
});

test('page: requests for the same or a different target during prepare-restore cannot reuse the old moved permission', async () => {
  const h = harness();
  const first = h.wrapper.requestFullscreen(); await h.flush(); const old = h.startMessage(); await moved(h); await first;
  const exit = deferred(); h.settings.nextExit = exit.promise;
  await h.message({ type: 'prepare-restore', requestId: old.requestId, prepareId: 'pending-native-exit', animate: false });
  const same = h.wrapper.requestFullscreen();
  const other = h.video.requestFullscreen({ navigationUI: 'hide' });
  await h.flush(); await Promise.all([same, other]);
  assert.equal(h.calls.native.length, 1);
  assert.equal(h.posted.filter(message => message.type === 'start').length, 1);
  exit.resolve(); await h.flush();
  assert.equal(h.calls.native.length, 1);
  assert.equal(h.posted.some(message => message.type === 'restore-prepared' && message.prepareId === 'pending-native-exit'), true);
  await h.message({ type: 'restored', requestId: old.requestId, animate: false });
  assert.equal(h.calls.native.length, 1);
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.timers.size, 0);
});

test('page: a native rejection arriving after a failed partial return cannot reapply fullscreen fallback or report entered', async () => {
  const h = harness(); const native = deferred(); h.settings.nextRequest = native.promise;
  h.wrapper.style.position = 'relative';
  const first = h.wrapper.requestFullscreen(); await h.flush(); const old = h.startMessage();
  await moved(h);
  assert.equal(h.calls.native.length, 1);
  await h.message({ type: 'prepare-restore', requestId: old.requestId, prepareId: 'return-before-entry-result', animate: false });
  await h.message({ type: 'restore-failed', requestId: old.requestId });
  native.reject(new Error('The pending native fullscreen was cancelled by tab restoration')); await h.flush();
  assert.equal(h.wrapper.style.position, 'relative');
  assert.equal(h.posted.some(message => message.type === 'entered'), false);
  assert.equal(h.posted.some(message => message.type === 'expand'), false);
  await h.message({ type: 'restored', requestId: old.requestId, animate: false }); await first;
  assert.equal(h.timers.size, 0);
});

test('page: a late native success after partial return is revoked and cannot reactivate the main browser window', async () => {
  const h = harness(); const native = deferred(); h.settings.nextRequest = native.promise;
  const first = h.wrapper.requestFullscreen(); await h.flush(); const old = h.startMessage(); await moved(h);
  await h.message({ type: 'prepare-restore', requestId: old.requestId, prepareId: 'return-before-entry-success', animate: false });
  await h.message({ type: 'restore-failed', requestId: old.requestId });
  native.resolve(); await h.flush();
  assert.equal(h.calls.exits, 1, 'The browser completing an old request after moved was revoked must be exited immediately');
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.posted.some(message => message.type === 'entered'), false);
  assert.equal(h.posted.some(message => message.type === 'expand'), false);
  await h.message({ type: 'restored', requestId: old.requestId, animate: false }); await first;
  assert.equal(h.timers.size, 0);
});

test('page: a cached native entry during movement is revoked and awaited before entering the moved tab', async () => {
  const h = harness(); const exit = deferred();
  const pending = h.wrapper.requestFullscreen(); await h.flush();
  h.settings.nextExit = exit.promise;
  await h.nativeRequest.call(h.video); await h.flush();
  assert.equal(h.document.fullscreenElement, null);
  await moved(h);
  assert.equal(h.calls.native.length, 1, 'Only the externally cached native invocation has occurred');
  exit.resolve(); await h.flush(); await pending;
  assert.equal(h.calls.native.length, 2);
  assert.equal(h.calls.native[1].target, h.wrapper);
});

test('page: old native recovery does not replace a newer website-selected target', async () => {
  const h = harness(); const exit = deferred(); h.settings.nextExit = exit.promise;
  await h.nativeRequest.call(h.video); await h.flush();
  await confirmUnmanaged(h);
  const options = { navigationUI: 'hide' };
  const pending = h.wrapper.requestFullscreen(options); await h.flush();
  await moved(h);
  assert.equal(h.calls.native.length, 1);
  exit.resolve(); await h.flush(); await pending;
  assert.equal(h.calls.native.length, 2);
  assert.equal(h.calls.native[1].target, h.wrapper);
  assert.equal(h.calls.native[1].args[0], options);
  assert.equal(h.posted.filter(x => x.type === 'start').length, 1);
});

test('page: a rejected older native exit cannot reject or strand a newer fullscreen request', async () => {
  const h = harness(); const exit = deferred(); h.settings.nextExit = exit.promise;
  await h.nativeRequest.call(h.video); await h.flush();
  await confirmUnmanaged(h);
  const pending = h.wrapper.requestFullscreen(); await h.flush();
  await moved(h);
  exit.reject(new Error('The browser already ended native fullscreen'));
  await h.flush(); await pending;
  assert.equal(h.calls.native.length, 2);
  assert.equal(h.calls.native[1].target, h.wrapper);
  assert.equal(h.posted.filter(x => x.type === 'start').length, 1);
});

test('page: a tab-wide child session keeps ancestor fullscreenchange from revoking or replacing the original player', async () => {
  const top = harness(), middle = harness(), child = harness();
  const upper = attachFrame(top, middle), lower = attachFrame(middle, child);
  for (const h of [top, middle, child]) await h.message({ type: 'tab-active', sessionId: 'moved-original-tab' });
  const pending = child.wrapper.requestFullscreen(); await child.flush();
  await moved(child); await pending; await flushFrames(top, middle, child);
  assert.equal(top.document.fullscreenElement, upper);
  assert.equal(middle.document.fullscreenElement, lower);
  assert.equal(child.document.fullscreenElement, child.wrapper);
  assert.equal(top.calls.exits + middle.calls.exits, 0);
  assert.equal(top.posted.filter(x => x.type === 'start').length + middle.posted.filter(x => x.type === 'start').length, 0);
  assert.equal(child.calls.native.length, 1);
});

test('page+bridge: descendant native fullscreen arriving before MAIN tab-active cannot revoke or replace that child session', async () => {
  const parent = harness({ bridge: true, runtimeHandler: frameRuntime }), child = harness();
  const frame = attachFrame(parent, child);
  parent.runtime({ type: 'FSA_TAB_ACTIVE', sessionId: 'moved-original-tab' });
  // Runtime IPC reached the isolated bridge. Its MAIN postMessage is still queued,
  // while the browser can already notify this ancestor about the child's entry.
  parent.document.fullscreenElement = frame;
  parent.window.dispatch('fullscreenchange');
  await parent.flush();
  assert.equal(parent.calls.exits, 0, 'A descendant session must not be exited during the MAIN delivery gap');
  assert.equal(parent.startMessage(), undefined, 'The ancestor must not launch a replacement session');
  assert.equal(parent.document.fullscreenElement, frame);
  assert.equal(parent.runtimeSent.some(message => message.type === 'FSA_TAB_STATE'), false, 'The isolated bridge can answer its already known session without worker IPC');
  assert.equal(parent.timers.size, 0);
});

test('page+bridge: worker-owned sessions protect native fullscreen before any tab-active broadcast reaches this frame', async () => {
  const h = harness({ bridge: true, runtimeHandler: message => message.type === 'FSA_TAB_STATE' ? { sessionId: 'another-frame-session', phase: 'playing' } : { ok: true } });
  await h.nativeRequest.call(h.video); await h.flush();
  assert.equal(h.runtimeSent.filter(message => message.type === 'FSA_TAB_STATE').length, 1);
  assert.equal(h.calls.exits, 0);
  assert.equal(h.startMessage(), undefined);
  assert.equal(h.document.fullscreenElement, h.video);
  await h.advance(2500);
  assert.equal(h.calls.exits, 0);
  assert.equal(h.timers.size, 0);
});

test('page+bridge: confirmed unmanaged native fullscreen recovers its exact original target once after the query response', async () => {
  const state = deferred();
  const h = harness({ bridge: true, runtimeHandler: message => message.type === 'FSA_TAB_STATE' ? state.promise : frameRuntime(message) });
  h.gesture(); await h.nativeRequest.call(h.video); await h.flush();
  assert.equal(h.calls.exits, 0);
  assert.equal(h.startMessage(), undefined);
  state.resolve({ sessionId: null }); await h.flush();
  assert.equal(h.calls.exits, 1);
  assert.equal(h.posted.filter(message => message.type === 'start').length, 1);
  assert.equal(h.calls.native.length, 2);
  assert.equal(h.calls.native[1].target, h.video);
  assert.equal(h.document.fullscreenElement, h.video);
  assert.equal(h.timers.size, 0);
});

test('page+bridge: worker query failure preserves native fullscreen and does not lock out the next successful recovery', async () => {
  let queries = 0;
  const h = harness({ bridge: true, runtimeHandler: message => {
    if (message.type === 'FSA_TAB_STATE') {
      if (++queries === 1) throw new Error('Extension worker is temporarily unavailable');
      return { sessionId: null };
    }
    return frameRuntime(message);
  } });
  await h.nativeRequest.call(h.video); await h.flush();
  assert.equal(h.calls.exits, 0); assert.equal(h.document.fullscreenElement, h.video);
  assert.equal(h.startMessage(), undefined); assert.equal(h.timers.size, 0);
  h.document.fullscreenElement = null; h.window.dispatch('fullscreenchange');
  h.gesture(); await h.nativeRequest.call(h.wrapper); await h.flush();
  assert.equal(queries, 2); assert.equal(h.calls.exits, 1);
  assert.equal(h.posted.filter(message => message.type === 'start').length, 1);
  assert.equal(h.calls.native.at(-1).target, h.wrapper);
  assert.equal(h.timers.size, 0);
});

test('page+bridge: a query that never responds times out safely and its late reply cannot recover an older target', async () => {
  let queries = 0; const late = deferred();
  const h = harness({ bridge: true, runtimeHandler: message => {
    if (message.type === 'FSA_TAB_STATE') return ++queries === 1 ? late.promise : { sessionId: null };
    return frameRuntime(message);
  } });
  await h.nativeRequest.call(h.video); await h.flush();
  await h.advance(2000);
  assert.equal(h.calls.exits, 0); assert.equal(h.document.fullscreenElement, h.video);
  assert.equal(h.startMessage(), undefined); assert.equal(h.timers.size, 0);
  h.document.fullscreenElement = null; h.window.dispatch('fullscreenchange');
  h.gesture(); await h.nativeRequest.call(h.wrapper); await h.flush();
  assert.equal(queries, 2); assert.equal(h.calls.exits, 1);
  late.resolve({ sessionId: null }); await h.flush();
  assert.equal(h.calls.exits, 1);
  assert.equal(h.posted.filter(message => message.type === 'start').length, 1);
  assert.equal(h.calls.native.at(-1).target, h.wrapper);
  assert.equal(h.document.fullscreenElement, h.wrapper);
  assert.equal(h.timers.size, 0);
});

test('page+bridge: a stale ownership reply cannot exit a replacement native target', async () => {
  const state = deferred();
  const h = harness({ bridge: true, runtimeHandler: message => message.type === 'FSA_TAB_STATE' ? state.promise : frameRuntime(message) });
  await h.nativeRequest.call(h.video); await h.flush();
  h.document.fullscreenElement = h.wrapper; h.window.dispatch('fullscreenchange');
  state.resolve({ sessionId: null }); await h.flush();
  assert.equal(h.calls.exits, 0);
  assert.equal(h.startMessage(), undefined);
  assert.equal(h.document.fullscreenElement, h.wrapper);
  assert.equal(h.timers.size, 0);
});

test('page: starting a newer managed request during ownership lookup cannot let the old lookup exit its player', async () => {
  const h = harness(); await h.nativeRequest.call(h.video); await h.flush();
  const query = h.posted.findLast(message => message.type === 'tab-state');
  const pending = h.wrapper.requestFullscreen(); await h.flush(); await moved(h); await pending;
  await h.message({ type: 'tab-state', requestId: query.requestId, known: true, sessionId: null });
  assert.equal(h.calls.exits, 0);
  assert.equal(h.posted.filter(message => message.type === 'start').length, 1);
  assert.equal(h.calls.native.at(-1).target, h.wrapper);
  assert.equal(h.document.fullscreenElement, h.wrapper);
  assert.equal(h.timers.size, 0);
});

test('page: frame expansion rejects an unrelated source and an inactive session before changing website styles', async () => {
  const parent = harness({ bridge: true, runtimeHandler: frameRuntime }), child = harness();
  const frame = attachFrame(parent, child);
  frame.style.position = 'relative'; frame.style.width = '640px';
  parent.wrapper.style.transform = 'scale(.9)';
  parent.runtime({ type: 'FSA_TAB_ACTIVE', sessionId: 'moved-original-tab' }); await parent.flush();
  await parent.frameMessage({ type: 'expand', sessionId: 'moved-original-tab', token: 'private-expansion-token' }, { name: 'not-an-iframe-window' });
  await parent.frameMessage({ type: 'expand', sessionId: 'other-session', token: 'private-expansion-token' }, child.window);
  assert.equal(parent.runtimeSent.length, 0, 'Unrelated sources and sessions cannot ask the worker to authorize expansion');
  await parent.frameMessage({ type: 'expand', sessionId: 'moved-original-tab', token: 'guessed-sibling-token' }, child.window);
  assert.equal(frame.style.position, 'relative');
  assert.equal(frame.style.width, '640px');
  assert.equal(parent.wrapper.style.transform, 'scale(.9)');
  assert.equal(parent.calls.exits, 0);
  assert.equal(parent.startMessage(), undefined);
  assert.equal(parent.runtimeSent.length, 1);
  assert.equal(parent.runtimeSent[0].type, 'FSA_EXPAND_ALLOWED');
  assert.equal(parent.posted.some(x => x.type === 'expand-authorized'), false);
});

test('page: nested iframe fallback expands the real ancestor chain and restores only its own unchanged styles', async () => {
  const options = { bridge: true, runtimeHandler: frameRuntime };
  const top = harness(options), middle = harness(options), child = harness(options);
  const upper = attachFrame(top, middle), lower = attachFrame(middle, child);
  upper.style.position = 'relative'; upper.style.width = '720px'; upper.style.height = '405px';
  lower.style.position = 'absolute'; lower.style.width = '640px'; lower.style.height = '360px';
  middle.wrapper.style.transform = 'scale(.8)'; middle.wrapper.style.filter = 'blur(2px)';
  top.wrapper.style.contain = 'layout paint'; top.wrapper.style.clipPath = 'circle(40%)';
  for (const h of [top, middle, child]) { h.runtime({ type: 'FSA_TAB_ACTIVE', sessionId: 'moved-original-tab' }); await h.flush(); }
  child.settings.nativeReject = true;
  child.gesture();
  const pending = child.wrapper.requestFullscreen(); await child.flush();
  await pending; await flushFrames(top, middle, child);
  for (const frame of [upper, lower]) {
    assert.equal(frame.style.position, 'fixed');
    assert.equal(frame.style.width, '100vw');
    assert.equal(frame.style.height, '100vh');
  }
  assert.equal(middle.wrapper.style.transform, 'none');
  assert.equal(middle.wrapper.style.filter, 'none');
  assert.equal(top.wrapper.style.contain, 'none');
  assert.equal(top.wrapper.style.clipPath, 'none');
  const started = child.posted.findLast(x => x.type === 'started');
  assert.equal('expandToken' in started, false, 'The private expansion token never enters the website MAIN world');
  assert.equal('token' in started, false);
  assert.equal(middle.runtimeSent.filter(x => x.type === 'FSA_EXPAND_ALLOWED').length, 1);
  assert.equal(top.runtimeSent.filter(x => x.type === 'FSA_EXPAND_ALLOWED').length, 1);
  lower.style.width = '85%';
  middle.wrapper.style.transform = 'rotate(1deg)';
  top.wrapper.style.clipPath = 'inset(3px)';
  for (const h of [top, middle, child]) { h.runtime({ type: 'FSA_TAB_RESTORED', sessionId: 'moved-original-tab' }); await h.flush(); }
  assert.equal(upper.style.position, 'relative'); assert.equal(upper.style.width, '720px'); assert.equal(upper.style.height, '405px');
  assert.equal(lower.style.position, 'absolute'); assert.equal(lower.style.width, '85%'); assert.equal(lower.style.height, '360px');
  assert.equal(middle.wrapper.style.transform, 'rotate(1deg)');
  assert.equal(middle.wrapper.style.filter, 'blur(2px)');
  assert.equal(top.wrapper.style.contain, 'layout paint');
  assert.equal(top.wrapper.style.clipPath, 'inset(3px)');
  assert.equal(upper.style.getPropertyPriority('width'), '');
  assert.equal(middle.wrapper.style.getPropertyPriority('filter'), '');
});

test('page: a stale tab-restored message cannot tear down a newer iframe expansion', async () => {
  const parent = harness({ bridge: true, runtimeHandler: frameRuntime }), child = harness(); const frame = attachFrame(parent, child);
  frame.style.width = '640px'; parent.wrapper.style.transform = 'translateX(2px)';
  parent.runtime({ type: 'FSA_TAB_ACTIVE', sessionId: 'moved-original-tab' }); await parent.flush();
  await parent.frameMessage({ type: 'expand', sessionId: 'moved-original-tab', token: 'private-expansion-token' }, child.window);
  parent.runtime({ type: 'FSA_TAB_RESTORED', sessionId: 'old-session' }); await parent.flush();
  assert.equal(frame.style.width, '100vw');
  assert.equal(parent.wrapper.style.transform, 'none');
  parent.runtime({ type: 'FSA_TAB_RESTORED', sessionId: 'moved-original-tab' }); await parent.flush();
  assert.equal(frame.style.width, '640px');
  assert.equal(parent.wrapper.style.transform, 'translateX(2px)');
});

test('page: iframe restoration handles overflow per axis so a website change cannot strand another important override', async () => {
  const parent = harness({ bridge: true, runtimeHandler: frameRuntime }), child = harness(); attachFrame(parent, child);
  parent.wrapper.style.overflow = 'hidden auto';
  parent.runtime({ type: 'FSA_TAB_ACTIVE', sessionId: 'moved-original-tab' }); await parent.flush();
  await parent.frameMessage({ type: 'expand', sessionId: 'moved-original-tab', token: 'private-expansion-token' }, child.window);
  assert.equal(parent.wrapper.style.overflowX, 'visible');
  assert.equal(parent.wrapper.style.overflowY, 'visible');
  parent.wrapper.style.overflowY = 'scroll';
  parent.runtime({ type: 'FSA_TAB_RESTORED', sessionId: 'moved-original-tab' }); await parent.flush();
  assert.equal(parent.wrapper.style.overflowX, 'hidden');
  assert.equal(parent.wrapper.style.overflowY, 'scroll');
  assert.equal(parent.wrapper.style.getPropertyPriority('overflow-x'), '');
  assert.equal(parent.wrapper.style.getPropertyPriority('overflow-y'), '');
});

test('page+bridge: pagehide restores iframe layout and BFCache return queries ownership instead of retaining the old tab session', async () => {
  const parent = harness({ bridge: true, runtimeHandler: message => message.type === 'FSA_TAB_STATE' ? { sessionId: null } : frameRuntime(message) });
  const child = harness(), frame = attachFrame(parent, child);
  frame.style.width = '640px'; parent.wrapper.style.transform = 'scale(.9)';
  parent.runtime({ type: 'FSA_TAB_ACTIVE', sessionId: 'moved-original-tab' }); await parent.flush();
  await parent.frameMessage({ type: 'expand', sessionId: 'moved-original-tab', token: 'private-expansion-token' }, child.window);
  assert.equal(frame.style.width, '100vw'); assert.equal(parent.wrapper.style.transform, 'none');
  parent.wrapper.style.transform = 'rotate(1deg)';
  parent.window.dispatch('pagehide', { persisted: true }); await parent.flush();
  assert.equal(frame.style.width, '640px');
  assert.equal(parent.wrapper.style.transform, 'rotate(1deg)');
  assert.equal(frame.style.getPropertyPriority('width'), '');
  parent.window.dispatch('pageshow', { persisted: true });
  parent.gesture(); await parent.nativeRequest.call(parent.video); await parent.flush();
  assert.equal(parent.runtimeSent.filter(message => message.type === 'FSA_TAB_STATE').length, 1, 'Neither MAIN nor the bridge may keep the pre-BFCache session');
  assert.equal(parent.calls.exits, 1);
  assert.equal(parent.startMessage()?.type, 'start');
  assert.equal(parent.timers.size, 0);
});

test('page+bridge: pagehide cancels pending ownership checks and late pre-BFCache replies cannot affect a new recovery', async () => {
  const late = deferred(); let queries = 0;
  const h = harness({ bridge: true, runtimeHandler: message => {
    if (message.type === 'FSA_TAB_STATE') return ++queries === 1 ? late.promise : { sessionId: null };
    return frameRuntime(message);
  } });
  await h.nativeRequest.call(h.video); await h.flush();
  assert.equal(h.timers.size, 1);
  h.window.dispatch('pagehide', { persisted: true }); await h.flush();
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.exits, 0); assert.equal(h.startMessage(), undefined);
  late.resolve({ sessionId: null }); await h.flush();
  assert.equal(h.calls.exits, 0); assert.equal(h.startMessage(), undefined);
  h.document.fullscreenElement = null; h.window.dispatch('pageshow', { persisted: true });
  h.gesture(); await h.nativeRequest.call(h.wrapper); await h.flush();
  assert.equal(queries, 2);
  assert.equal(h.calls.exits, 1);
  assert.equal(h.posted.filter(message => message.type === 'start').length, 1);
  assert.equal(h.calls.native.at(-1).target, h.wrapper);
  assert.equal(h.timers.size, 0);
});

test('page+bridge: pagehide ends the old request and removes its reveal cover before a BFCache page starts again', async () => {
  const h = harness({ bridge: true, runtimeHandler: frameRuntime });
  h.gesture(); const first = h.wrapper.requestFullscreen(); await h.flush(); await first;
  const old = h.startMessage();
  h.runtime({ type: 'FSA_PREPARE_RESTORE', requestId: old.requestId, animate: true }); await h.flush();
  assert.equal(h.covers().length, 1);
  h.window.dispatch('pagehide', { persisted: true }); await h.flush();
  assert.equal(h.covers().length, 0);
  assert.equal(h.observers.every(observer => observer.disconnected), true);
  assert.equal(h.runtime({ type: 'FSA_SOURCE_ALIVE', requestId: old.requestId }).responses[0].alive, false);
  assert.equal(h.runtimeSent.filter(message => message.type === 'FSA_STOP' && message.requestId === old.requestId).length, 1);
  assert.equal(h.timers.size, 0);
  h.runtime({ type: 'FSA_RESTORED', requestId: old.requestId, animate: true }); await h.flush();
  assert.equal(h.covers().length, 0);
  h.window.dispatch('pageshow', { persisted: true }); h.gesture();
  const next = h.wrapper.requestFullscreen(); await h.flush(); await next;
  assert.notEqual(h.startMessage().requestId, old.requestId);
  assert.equal(h.posted.filter(message => message.type === 'start').length, 2);
  assert.equal(h.calls.native.length, 2);
  assert.equal(h.timers.size, 0);
});

test('bridge: start requires a trusted gesture and sends bounded preview metadata without RTC payloads', async () => {
  const h = harness({ page: false, bridge: true });
  await h.message({ type: 'start', requestId: 'untrusted' }, 'page');
  assert.equal(h.runtimeSent.length, 0);
  h.gesture();
  await h.message({ type: 'start', requestId: 'valid', preview: 'https://remote.invalid/not-a-preview' }, 'page');
  assert.equal(h.runtimeSent.length, 1);
  assert.equal(h.runtimeSent[0].type, 'FSA_START');
  assert.equal(h.runtimeSent[0].preview, undefined);
  assert.equal('offer' in h.runtimeSent[0], false);
  assert.equal('stream' in h.runtimeSent[0], false);
  const alive = h.runtime({ type: 'FSA_SOURCE_ALIVE', requestId: 'valid' });
  assert.equal(alive.responses[0].alive, true);
  h.runtime({ type: 'FSA_RESTORED', requestId: 'valid' }); await h.flush();
  const ended = h.runtime({ type: 'FSA_SOURCE_ALIVE', requestId: 'valid' });
  assert.equal(ended.responses[0].alive, false);
});

test('bridge: source addresses come from the current document rather than MAIN data and only this extension can query them', async () => {
  const sourceUrl = 'https://example.test/original-video?quality=4k#player';
  const h = harness({ page: false, bridge: true, sourceUrl });
  const direct = h.runtime({ type: 'FSA_SOURCE_URL' });
  assert.equal(direct.responses[0].sourceUrl, sourceUrl);
  assert.equal(h.runtime({ type: 'FSA_SOURCE_URL' }, { id: 'another-extension' }).responses.length, 0);
  h.gesture();
  await h.message({ type: 'start', requestId: 'trusted-url', sourceUrl: 'https://attacker.invalid/spoof' }, 'page');
  assert.equal(h.runtimeSent[0].sourceUrl, sourceUrl);
  assert.equal(h.runtimeSent[0].type, 'FSA_START');
});

test('bridge: PREPARE_RESTORE replies asynchronously and directly without another runtime request', async () => {
  const h = harness({ page: false, bridge: true }); h.gesture();
  await h.message({ type: 'start', requestId: 'active' }, 'page');
  const sentBefore = h.runtimeSent.length;
  const preparation = h.runtime({ type: 'FSA_PREPARE_RESTORE', requestId: 'active', animate: true });
  assert.equal(preparation.returns[0], true);
  await h.flush();
  assert.equal(preparation.responses.length, 0);
  const prepare = h.posted.findLast(x => x.type === 'prepare-restore');
  await h.message({ type: 'restore-prepared', requestId: 'active', prepareId: prepare.prepareId }, 'page');
  assert.equal(preparation.responses.length, 1);
  assert.equal(preparation.responses[0].ok, true);
  assert.equal(h.runtimeSent.length, sentBefore);
  await h.advance(2000);
  await h.message({ type: 'restore-prepared', requestId: 'active', prepareId: prepare.prepareId }, 'page');
  assert.equal(preparation.responses.length, 1);
  const unknown = h.runtime({ type: 'FSA_PREPARE_RESTORE', requestId: 'other' });
  assert.equal(unknown.responses[0].ok, false);
});

test('bridge: tab-wide session notifications reach MAIN in frames without a local video request', async () => {
  const h = harness({ page: false, bridge: true });
  h.runtime({ type: 'FSA_TAB_ACTIVE', sessionId: 'child-frame-session' }); await h.flush();
  const active = h.posted.findLast(x => x.type === 'tab-active');
  assert.equal(active?.direction, 'extension');
  assert.equal(active?.sessionId, 'child-frame-session');
  h.runtime({ type: 'FSA_TAB_RESTORED', sessionId: 'child-frame-session' }); await h.flush();
  const restored = h.posted.findLast(x => x.type === 'tab-restored');
  assert.equal(restored?.direction, 'extension');
  assert.equal(restored?.sessionId, 'child-frame-session');
  assert.equal(h.runtimeSent.length, 0);
});

test('page+bridge: the restore handshake can finish while the worker waits on its direct response', async () => {
  const h = harness({ bridge: true }); h.gesture();
  const pending = h.wrapper.requestFullscreen(); await h.flush(); await pending;
  const start = h.startMessage();
  assert.equal(h.calls.native.length, 1);
  const before = h.runtimeSent.length;
  const result = h.runtime({ type: 'FSA_PREPARE_RESTORE', requestId: start.requestId, animate: true });
  await h.flush();
  assert.equal(result.returns[0], true);
  assert.equal(result.responses.length, 0, 'The worker must wait for the obscured original layout to paint');
  await h.advance(224);
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].ok, true);
  assert.equal(h.runtimeSent.length, before, 'No nested EXIT/STOP request is queued behind PREPARE_RESTORE');
  h.runtime({ type: 'FSA_RESTORED', requestId: start.requestId, animate: true }); await h.flush();
  await h.advance(1000);
  assert.equal(h.covers().length, 0);
});

test('page+bridge: worker restore errors retain the session for a subsequent successful exit', async () => {
  let exits = 0;
  const h = harness({ bridge: true, runtimeHandler: message => {
    if (message.type === 'FSA_START') return { sessionId: 'moved-original-tab' };
    if (message.type === 'FSA_EXIT_REQUEST') return ++exits === 1 ? { error: 'Temporary browser move failure' } : { ok: true };
    return { ok: true };
  } });
  h.gesture(); const pending = h.wrapper.requestFullscreen(); await h.flush(); await pending;
  const start = h.startMessage();
  const first = h.document.exitFullscreen(); await h.flush(); await first;
  assert.equal(h.runtime({ type: 'FSA_SOURCE_ALIVE', requestId: start.requestId }).responses[0].alive, true);
  const second = h.document.exitFullscreen(); await h.flush();
  assert.equal(exits, 2);
  const prepare = h.runtime({ type: 'FSA_PREPARE_RESTORE', requestId: start.requestId, animate: false }); await h.flush();
  assert.equal(prepare.responses[0].ok, true);
  h.runtime({ type: 'FSA_RESTORED', requestId: start.requestId, animate: false }); await h.flush(); await second;
  assert.equal(h.runtime({ type: 'FSA_SOURCE_ALIVE', requestId: start.requestId }).responses[0].alive, false);
});

test('placeholder: a valid session loads its title and optional local JPEG preview without exposing it before load', async () => {
  const preview = 'data:image/jpeg;base64,bG9jYWwtc25hcHNob3Q=';
  const h = placeholderHarness({ runtimeHandler: () => ({ title: 'Original video — 4K', preview }) }); await h.flush();
  assert.deepEqual(h.sent, [{ type: 'FSA_PLACEHOLDER_READY', sessionId: 'a1234567-abcd-4abc-8def-0123456789ab' }]);
  assert.equal(h.document.title, 'Original video — 4K');
  assert.equal(h.preview.src, preview); assert.equal(h.preview.hidden, true);
  assert.equal(h.exit.disabled, false);
  h.preview.dispatch('load'); await h.flush();
  assert.equal(h.preview.hidden, false);
  assert.equal(h.preview.style.opacity, '.72');
  assert.equal(h.timers.size, 0, 'Loading a decoded placeholder image must not schedule an opacity animation');
});

test('placeholder: valid source metadata uses only the extension favicon cache with the original page URL', async () => {
  const sourceUrl = 'https://example.test/watch?v=one&quality=4k#player';
  const h = placeholderHarness({ runtimeHandler: () => ({ title: 'Original player', sourceUrl }) }); await h.flush();
  const icon = new URL(h.favicon.href);
  assert.equal(icon.origin, 'null');
  assert.equal(icon.protocol, 'chrome-extension:'); assert.equal(icon.host, 'extension-id');
  assert.equal(icon.pathname, '/_favicon/'); assert.equal(icon.searchParams.get('pageUrl'), sourceUrl);
  assert.equal(icon.searchParams.get('size'), '32');
});

test('placeholder: invalid source metadata cannot request a website favicon', async () => {
  for (const sourceUrl of ['javascript:alert(1)', 'chrome-extension://foreign/page.html', 'data:text/html,hello', '/relative']) {
    const h = placeholderHarness({ runtimeHandler: () => ({ sourceUrl }) }); await h.flush();
    assert.equal(h.favicon.href, undefined);
  }
});

test('placeholder: original website recovery is saved in the same history entry without adding navigation', async () => {
  const sourceUrl = 'https://example.test/original-video?quality=4k#player';
  const h = placeholderHarness({ historyState: { kept: 'existing-state' }, runtimeHandler: () => ({ title: 'Original player', sourceUrl }) });
  await h.flush();
  assert.equal(h.history.state.fsaSourceUrl, sourceUrl);
  assert.equal(h.history.state.kept, 'existing-state');
  assert.equal(h.historyWrites.length, 1);
  assert.equal(h.historyWrites[0].url, undefined, 'replaceState must preserve the placeholder URL and its session identity');
  assert.equal(h.replacements.length, 0);
});

test('placeholder: loading an ended session replaces the stale placeholder with its original ordinary website', async () => {
  const sourceUrl = 'https://example.test/original-video';
  const h = placeholderHarness({ historyState: { fsaSourceUrl: sourceUrl }, runtimeHandler: () => ({ error: 'Session is no longer available', sessionEnded: true }) });
  assert.equal(h.exit.hidden, true, 'A restored history entry must not flash its stale fullscreen prompt');
  await h.flush();
  assert.deepEqual(h.replacements, [sourceUrl]);
  assert.equal(h.exit.disabled, true);
  assert.equal(h.historyWrites.length, 0, 'Recovery uses location.replace instead of pushing a second placeholder history entry');
});

test('placeholder: an ended legacy entry without a saved website stays hidden instead of pretending fullscreen still exists', async () => {
  const h = placeholderHarness({ runtimeHandler: () => ({ sessionEnded: true, error: 'Session is no longer available' }) });
  await h.flush();
  assert.equal(h.exit.hidden, true);
  assert.equal(h.exit.disabled, true);
  assert.deepEqual(h.replacements, [], 'A legacy entry with no saved URL cannot invent a destination');
  h.window.dispatch('pageshow', { persisted: true }); await h.flush();
  assert.equal(h.exit.hidden, true);
});

test('placeholder: BFCache return revalidates a closed video and restores the normal source website', async () => {
  let ended = false;
  const sourceUrl = 'https://example.test/watch/original';
  const h = placeholderHarness({ runtimeHandler: () => ended ? { sessionEnded: true, error: 'Session is no longer available' } : { sourceUrl, title: 'Original player' } });
  await h.flush();
  h.window.dispatch('pagehide', { persisted: true });
  ended = true;
  h.window.dispatch('pageshow', { persisted: true });
  assert.equal(h.exit.hidden, true);
  await h.flush();
  assert.deepEqual(h.replacements, [sourceUrl]);
  assert.equal(h.sent.filter(message => message.type === 'FSA_PLACEHOLDER_READY').length, 2);
  assert.equal(h.sent.some(message => message.type === 'FSA_START'), false, 'Returning through history must not recreate a fullscreen video');
});

test('placeholder: a live BFCache session clears cached exit state and remains a usable placeholder', async () => {
  const exit = deferred();
  const h = placeholderHarness({ runtimeHandler: message => message.type === 'FSA_EXIT_REQUEST' ? exit.promise : { title: 'Original player', sourceUrl: 'https://example.test/video' } });
  await h.flush(); h.exit.dispatch('click'); await h.flush();
  assert.equal(h.exit.disabled, true);
  h.window.dispatch('pagehide', { persisted: true });
  h.window.dispatch('pageshow', { persisted: true });
  await h.flush();
  assert.equal(h.exit.disabled, false);
  assert.equal(h.classes.has('exiting'), false);
  assert.equal(h.exit.getAttribute('aria-busy'), null);
  assert.equal(h.exit.hidden, false);
  assert.deepEqual(h.replacements, []);
  exit.resolve({ ok: true }); await h.flush();
});

test('placeholder: recovery refuses executable, extension, relative, malformed and oversized addresses', async () => {
  for (const sourceUrl of ['javascript:alert(1)', 'data:text/html,unsafe', 'blob:https://example.test/token', 'chrome-extension://extension-id/placeholder.html', '/relative', 'not a URL', 'https://example.test/' + 'x'.repeat(8192)]) {
    const live = placeholderHarness({ runtimeHandler: () => ({ sourceUrl }) }); await live.flush();
    assert.equal(live.historyWrites.length, 0);
    const dead = placeholderHarness({ historyState: { fsaSourceUrl: sourceUrl }, runtimeHandler: () => ({ sessionEnded: true }) }); await dead.flush();
    assert.equal(dead.replacements.length, 0);
    assert.equal(dead.exit.hidden, true);
  }
});

test('placeholder: runtime errors and unrelated validation errors are not treated as an ended video', async () => {
  for (const result of [undefined, { error: 'Invalid session sender' }, new Error('Extension context unavailable')]) {
    const h = placeholderHarness({ historyState: { fsaSourceUrl: 'https://example.test/video' }, runtimeHandler: () => {
      if (result instanceof Error) throw result;
      return result;
    } });
    await h.flush();
    assert.deepEqual(h.replacements, []);
    assert.equal(h.exit.disabled, false);
    assert.equal(h.exit.hidden, true);
  }
});

test('placeholder: a late pre-navigation validation cannot redirect a newer live BFCache restoration', async () => {
  const pending = deferred(); let requests = 0;
  const sourceUrl = 'https://example.test/video';
  const h = placeholderHarness({ historyState: { fsaSourceUrl: sourceUrl }, runtimeHandler: () => ++requests === 1 ? pending.promise : { sourceUrl } });
  h.window.dispatch('pagehide', { persisted: true });
  h.window.dispatch('pageshow', { persisted: true }); await h.flush();
  pending.resolve({ sessionEnded: true }); await h.flush();
  assert.deepEqual(h.replacements, []);
  assert.equal(h.exit.hidden, false);
});

test('placeholder: repeated click and Escape share one pending exit and remain disabled after success', async () => {
  const pending = deferred();
  const h = placeholderHarness({ runtimeHandler: message => message.type === 'FSA_EXIT_REQUEST' ? pending.promise : { title: 'Original video' } }); await h.flush();
  h.exit.dispatch('click'); h.exit.dispatch('click');
  const escape = { key: 'Escape' }; h.document.dispatch('keydown', escape); await h.flush();
  assert.equal(escape.defaultPrevented, true);
  assert.equal(h.sent.filter(message => message.type === 'FSA_EXIT_REQUEST').length, 1);
  assert.equal(h.exit.disabled, true); assert.equal(h.classes.has('exiting'), true);
  assert.equal(h.exit.getAttribute('aria-busy'), 'true');
  pending.resolve({ ok: true }); await h.flush();
  h.exit.dispatch('click'); h.document.dispatch('keydown', { key: 'Escape' }); await h.flush();
  assert.equal(h.sent.filter(message => message.type === 'FSA_EXIT_REQUEST').length, 1);
  assert.equal(h.exit.disabled, true);
});

test('placeholder: direct preparation decodes the preview and paints before ACK without waiting for its queued metadata request', async () => {
  const metadata = deferred();
  const h = placeholderHarness({ runtimeHandler: message => message.type === 'FSA_PLACEHOLDER_READY' ? metadata.promise : { ok: true } });
  const decoded = deferred(); h.preview.decode = () => decoded.promise;
  const prepare = { type: 'FSA_PREPARE_PLACEHOLDER', sessionId: 'a1234567-abcd-4abc-8def-0123456789ab', title: 'Original player', preview: 'data:image/jpeg;base64,bG9jYWw=' };
  const result = h.runtime(prepare); await h.flush();
  assert.equal(result.returns[0], true); assert.equal(result.responses.length, 0);
  assert.equal(h.document.title, 'Original player');
  assert.equal(h.exit.hidden, false, 'Trusted direct preparation can reveal the live placeholder while its metadata request is queued');
  h.preview.dispatch('load'); await h.flush();
  await h.advance(16);
  assert.equal(h.preview.style.opacity, '.72');
  assert.equal(result.responses.length, 0);
  decoded.resolve(); await h.flush(); await h.advance(32);
  assert.equal(result.responses[0].ok, true);
  assert.equal(h.sent.length, 1, 'Preparing the placeholder must not enqueue a second metadata request behind START');
  assert.equal(h.runtime({ ...prepare, sessionId: 'other-session' }).returns[0], undefined);
  assert.equal(h.runtime(prepare, { id: 'another-extension' }).returns[0], undefined);
  metadata.resolve({ title: 'Original player', preview: prepare.preview }); await h.flush();
  assert.equal(h.preview.hidden, false);
  assert.equal(h.preview.style.opacity, '.72');
});

test('placeholder: background readiness does not wait for throttled paint, timers or image decode', async () => {
  const pendingMetadata = deferred();
  const h = placeholderHarness({ runtimeHandler: () => pendingMetadata.promise });
  h.document.visibilityState = 'hidden';
  h.preview.decode = () => new Promise(() => {});
  const result = h.runtime({ type: 'FSA_PREPARE_PLACEHOLDER', sessionId: 'a1234567-abcd-4abc-8def-0123456789ab', title: 'Original player', sourceUrl: 'https://example.test/video', preview: 'data:image/jpeg;base64,bG9jYWw=' });
  await h.flush();
  assert.equal(result.responses[0].ok, true);
  assert.equal(h.exit.hidden, false);
  assert.equal(h.history.state.fsaSourceUrl, 'https://example.test/video');
  assert.equal(h.timers.size, 0, 'An inactive placeholder must acknowledge without advancing any browser timers');
  pendingMetadata.resolve({ title: 'Original player' }); await h.flush();
});

test('placeholder: pending fullscreen keeps its content hidden until the worker reveals the entered session', async () => {
  const h = placeholderHarness({ runtimeHandler: () => ({ pending: true }) });
  h.document.visibilityState = 'hidden';
  await h.flush();
  assert.equal(h.exit.hidden, true);
  assert.equal(h.history.state, null);
  const ready = h.runtime({ type: 'FSA_PREPARE_PLACEHOLDER', sessionId: 'a1234567-abcd-4abc-8def-0123456789ab', title: 'Original website', sourceUrl: 'https://example.test/video' });
  await h.flush();
  assert.equal(ready.responses[0].ok, true);
  assert.equal(h.exit.hidden, false);
  assert.equal(h.document.title, 'Original website');
  assert.equal(h.history.state.fsaSourceUrl, 'https://example.test/video');
});

test('placeholder: stalled preview preparation is bounded and still leaves exit available', async () => {
  const h = placeholderHarness(); await h.flush();
  const result = h.runtime({ type: 'FSA_PREPARE_PLACEHOLDER', sessionId: 'a1234567-abcd-4abc-8def-0123456789ab', preview: 'data:image/jpeg;base64,bG9jYWw=' });
  await h.advance(252);
  assert.equal(result.responses[0].ok, true);
  assert.equal(h.exit.disabled, false);
  h.exit.dispatch('click'); await h.flush();
  assert.equal(h.sent.at(-1).type, 'FSA_EXIT_REQUEST');
});

test('placeholder: an explicit failure or runtime rejection releases the exit button for a successful retry', async () => {
  let attempts = 0;
  const h = placeholderHarness({ runtimeHandler: message => {
    if (message.type === 'FSA_PLACEHOLDER_READY') return {};
    if (++attempts === 1) return { error: 'Temporary tab move failure' };
    if (attempts === 2) throw new Error('The worker restarted');
    return { ok: true };
  } }); await h.flush();
  for (let i = 0; i < 2; i++) {
    h.exit.dispatch('click'); await h.flush();
    assert.equal(h.exit.disabled, false); assert.equal(h.classes.has('exiting'), false);
    assert.equal(h.exit.getAttribute('aria-busy'), null);
  }
  h.exit.dispatch('click'); await h.flush();
  assert.equal(attempts, 3);
  assert.equal(h.exit.disabled, true); assert.equal(h.classes.has('exiting'), true);
});

test('placeholder: malformed or missing session hashes never send metadata or exit requests', async () => {
  for (const hash of ['', '#not-a-session', '#a1234567-abcd-4abc-8def-0123456789ab-extra', '#%61a1234567-abcd-4abc-8def-0123456789ab']) {
    const h = placeholderHarness({ hash }); await h.flush();
    assert.equal(h.exit.disabled, true);
    h.exit.dispatch('click'); h.document.dispatch('keydown', { key: 'Escape' }); await h.flush();
    assert.equal(h.sent.length, 0);
  }
});

test('placeholder: unavailable, rejected, or failed previews never block exit', async () => {
  for (const preview of [undefined, null, 'https://remote.invalid/video.jpg', 'data:image/jpeg;base64,' + 'A'.repeat(350000)]) {
    const h = placeholderHarness({ runtimeHandler: message => message.type === 'FSA_PLACEHOLDER_READY' ? { title: 'Protected video', preview } : { ok: true } }); await h.flush();
    assert.equal(h.preview.src, ''); assert.equal(h.preview.hidden, true); assert.equal(h.exit.disabled, false);
    h.exit.dispatch('click'); await h.flush();
    assert.equal(h.sent.filter(message => message.type === 'FSA_EXIT_REQUEST').length, 1);
  }
  const h = placeholderHarness({ runtimeHandler: message => message.type === 'FSA_PLACEHOLDER_READY' ? { preview: 'data:image/jpeg;base64,bG9jYWw=' } : { ok: true } }); await h.flush();
  h.preview.dispatch('load'); h.preview.dispatch('error'); await h.flush();
  assert.equal(h.preview.hidden, true); assert.equal(h.preview.src, '');
  h.exit.dispatch('click'); await h.flush();
  assert.equal(h.sent.filter(message => message.type === 'FSA_EXIT_REQUEST').length, 1);
});
