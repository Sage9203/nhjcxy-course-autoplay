// Offline browser/event model for completion preview. No real site or decoder.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixtureCatalog(count = 3) {
  return [{ id: 10, name: '第一章 商务礼仪', sort: 1, children: Array.from({ length: count }, (_, i) => ({
    id: 100 + i, name: `第${i + 1}讲 课程`, sort: i + 1,
    tabVideo: 1, tabWork: 0, tabExam: 0, tabFile: 0, tabVote: 0,
    localFile: `https://media.example/lesson-${i}.mp4?signature=SECRET_MEDIA_${i}`,
    videoDuration: 120, lock: 0, unlockTime: null,
  })) }, { id: 11, name: '期末考试', sort: 2, children: [] }];
}

function fixtureProgress(catalog, complete = [0]) {
  let index = 0;
  const nodeProgressList = catalog.flatMap(chapter => chapter.children.map(node => {
    const done = complete.includes(index++);
    return {
      nodeId: node.id, nodeName: node.name, chapterName: chapter.name,
      state: done ? 1 : 0, statusText: done ? '已完成' : '未开始',
      progressPercent: done ? 100 : 0, progressRatio: done ? '1.00' : '0.00',
      completeTime: done ? '2026-10-29 18:00:00' : null,
      startTime: done ? '2026-10-29 17:58:00' : null,
      videoDuration: '2分0秒', watchDuration: done ? '2分0秒' : '0秒', watchCount: done ? 1 : 0,
    };
  }));
  return { code: 200, msg: 'success', data: {
    summary: { totalNodes: nodeProgressList.length, completedNodes: complete.length }, nodeProgressList,
  } };
}

function browser(options = {}) {
  const scriptPath = options.scriptPath || process.env.COMPLETION_PREVIEW_SCRIPT_PATH ||
    path.join(__dirname, '../../dist/nhjcxy-course-autoplay.user.js');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const catalog = options.catalog || fixtureCatalog(options.count || 3);
  const nodes = catalog.flatMap((chapter) => chapter.children);
  let now = Date.UTC(2026, 9, 29);
  let timerId = 0;
  const timers = new Map();
  const microtasks = [];
  const observers = [];
  const clicks = [];
  const warnings = [];
  const requests = [];
  const progressCalls = [];
  let progressBody = fixtureProgress(catalog, options.complete || [0]);
  let progressBehavior = null;
  let platformRequestDepth = 0;
  let credentialTouches = 0;
  let clipboard = '';
  let document;
  let api;
  const location = {
    href: options.url || 'https://nhjcxy.haiqikeji.com/student/course-study?id=course-A&nodeId=100',
    get pathname() { return new URL(this.href).pathname; },
    get origin() { return new URL(this.href).origin; },
    get search() { return new URL(this.href).search; },
    get protocol() { return new URL(this.href).protocol; },
    get host() { return new URL(this.href).host; },
  };

  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback, options = false) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push({ callback, capture: options === true || options?.capture === true, once: options?.once === true });
    }
    removeEventListener(type, callback, options = false) {
      const capture = options === true || options?.capture === true;
      this.listeners.set(type, (this.listeners.get(type) || []).filter((x) => x.callback !== callback || x.capture !== capture));
    }
    fire(type, event, capture) {
      for (const entry of [...(this.listeners.get(type) || [])]) {
        if (capture !== undefined && entry.capture !== capture) continue;
        if (entry.once) this.removeEventListener(type, entry.callback, entry.capture);
        event.currentTarget = this;
        if (typeof entry.callback === 'function') entry.callback.call(this, event);
        else entry.callback.handleEvent(event);
      }
    }
    dispatchEvent(event) { this.fire(event.type, event); return true; }
  }

  function simpleMatch(element, simple, scope) {
    if (simple === ':scope') return element === scope;
    if (simple.includes(':scope')) {
      if (element !== scope) return false;
      simple = simple.replace(':scope', '');
    }
    const tag = simple.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    for (const [, id] of simple.matchAll(/#([\w-]+)/g)) if (element.id !== id) return false;
    for (const [, name] of simple.matchAll(/\.([\w-]+)/g)) if (!element.classList.contains(name)) return false;
    for (const [, name, quoted, bare] of simple.matchAll(/\[([^\s=\]]+)(?:\s*=\s*(?:["']([^"']*)["']|([^\s\]]+)))?\]/g)) {
      if (!element.hasAttribute(name)) return false;
      const value = quoted ?? bare;
      if (value !== undefined && element.getAttribute(name) !== value) return false;
    }
    return true;
  }
  function matchSelector(element, selector, scope) {
    return selector.split(',').some((branch) => {
      const tokens = branch.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
      function matchAt(node, index) {
        if (!node || !simpleMatch(node, tokens[index], scope)) return false;
        if (index === 0) return true;
        if (tokens[index - 1] === '>') return matchAt(node.parentElement, index - 2);
        for (let parent = node.parentElement; parent; parent = parent.parentElement) if (matchAt(parent, index - 1)) return true;
        return false;
      }
      return tokens.length > 0 && matchAt(element, tokens.length - 1);
    });
  }
  function descendants(root) { return root.children.flatMap((child) => [child, ...descendants(child)]); }

  class Element extends Target {
    constructor(tag = 'div') {
      super(); this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.children = [];
      this.parentElement = null; this._connected = false; this._text = ''; this.style = {}; this.hidden = false;
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => name && !names.includes(name)).join(' '); },
        toggle: (name, force) => { const add = force ?? !this.classList.contains(name); this.classList[add ? 'add' : 'remove'](name); return add; },
      };
    }
    get isConnected() { return this.parentElement ? this.parentElement.isConnected : this._connected; }
    set isConnected(value) { this._connected = Boolean(value); if (!value && this.parentElement) this.remove(); }
    get parentNode() { return this.parentElement; }
    get ownerDocument() { return document; }
    get textContent() { return this._text + this.children.map((x) => x.textContent).join(''); }
    set textContent(value) { this._text = String(value); for (const child of this.children) child.parentElement = null; this.children = []; }
    get innerText() { return this.textContent; }
    set innerText(value) { this.textContent = value; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    set id(value) { this.setAttribute('id', value); }
    get id() { return this.getAttribute('id') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get className() { return this.getAttribute('class') || ''; }
    matches(selector) { return matchSelector(this, selector, this); }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    contains(element) { return element === this || descendants(this).includes(element); }
    querySelectorAll(selector) { return descendants(this).filter((node) => matchSelector(node, selector, this)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    appendChild(child) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
    append(...children) { for (const child of children) this.appendChild(child); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((x) => x !== this); this.parentElement = null; this._connected = false; }
    attachShadow() {
      const root = new Element('shadow-root'); root._connected = true;
      Object.defineProperty(root, 'innerHTML', { set(value) {
        root.children = [];
        for (const match of value.matchAll(/<(\w+)[^>]*\bclass="([^"]+)"[^>]*>/g)) {
          const node = new Element(match[1]); node.className = match[2];
          const pressed = match[0].match(/aria-pressed="([^"]+)"/);
          if (pressed) node.setAttribute('aria-pressed', pressed[1]);
          root.appendChild(node);
        }
      } });
      this.shadowRoot = root; return root;
    }
    click() {
      emit('click', this, { isTrusted: false });
      if (this.matches('.section-item')) { clicks.push(this.index); api.onItemClick?.(this.index); }
    }
  }

  class Video extends Element {
    constructor() {
      super('video'); this.currentSrc = nodes[options.active || 0]?.localFile || ''; this.src = '';
      this.currentTime = 5; this.duration = 120; this.readyState = 4; this.networkState = 1;
      this.paused = false; this.ended = false; this.seeking = false; this.error = null; this.loop = false;
      this.playCalls = 0; this.pauseCalls = 0; this.playBehavior = 'resolve'; this.pendingPlay = null;
    }
    play() {
      this.playCalls += 1;
      if (this.playBehavior === 'pending') return new Promise((resolve, reject) => { this.pendingPlay = { resolve, reject }; });
      if (typeof this.playBehavior === 'object') return Promise.reject(this.playBehavior);
      this.paused = false; this.ended = false; emit('playing', this); return Promise.resolve();
    }
    pause() { this.pauseCalls += 1; this.paused = true; emit('pause', this); }
  }
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  class FakeXHR extends Target {
    constructor() { super(); this.readyState = 0; this.status = 0; this.responseType = ''; this.responseURL = ''; this.responseText = ''; this.response = ''; }
    open(method, url) { this.method = method; this.url = new URL(url, location.href).href; this.readyState = 1; }
    send() { requests.push({ transport: 'xhr', method: this.method, url: this.url, platform: platformRequestDepth > 0 }); }
    setRequestHeader() { credentialTouches += 1; throw new Error('The script must not inspect or set credentials'); }
    getAllResponseHeaders() { credentialTouches += 1; throw new Error('Response headers are not needed'); }
    respond(body, config = {}) {
      this.status = config.status ?? 200; this.responseURL = config.url || this.url;
      this.readyState = 4; this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      this.response = this.responseType === 'json' ? JSON.parse(this.responseText) : this.responseText;
      this.fire('readystatechange', { type: 'readystatechange', target: this });
      this.fire('load', { type: 'load', target: this }); this.fire('loadend', { type: 'loadend', target: this });
    }
  }
  class FakeResponse {
    constructor(body, url, status = 200) { this.body = body; this.url = url; this.status = status; this.ok = status >= 200 && status < 300; }
    clone() { return new FakeResponse(this.body, this.url, this.status); }
    async json() { return typeof this.body === 'string' ? JSON.parse(this.body) : JSON.parse(JSON.stringify(this.body)); }
    async text() { return typeof this.body === 'string' ? this.body : JSON.stringify(this.body); }
  }
  let nextFetchBody = null;
  async function nativeFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href).href;
    const method = init.method || input.method || 'GET';
    requests.push({ transport: 'fetch', method, url, platform: platformRequestDepth > 0 });
    return new FakeResponse(nextFetchBody, url);
  }
  const window = new Target();
  const client = function platformHttpClient() { throw new Error('Only the reviewed GET method should be used'); };
  client.defaults = { baseURL: '/api' };
  client.get = function (requestPath, config = {}) {
    const call = { path: requestPath, params: { ...config.params }, signal: config.signal,
      timeout: config.timeout, time: now, method: 'GET' };
    progressCalls.push(call);
    if (progressBehavior) return progressBehavior(call, progressCalls.length - 1);
    return Promise.resolve(JSON.parse(JSON.stringify(progressBody)));
  };
  const moduleFactory = function reviewedPlatformModule() {};
  const fakeRequire = function (id) {
    if (String(id) !== '51953') throw new Error('Unexpected module access');
    return { A: client };
  };
  fakeRequire.m = { 51953: moduleFactory };
  fakeRequire.c = { 51953: { exports: { A: client } } };
  const webpackChunks = [];
  webpackChunks.push = function (tuple) {
    Array.prototype.push.call(this, tuple);
    if (typeof tuple[2] === 'function') tuple[2](fakeRequire);
    return this.length;
  };
  const moduleDigest = 'b25a350384cc8fbbaf8743c3fe496856ef50837e461800d7ba874bd6be25cf36';
  const crypto = { subtle: { async digest() {
    // Hashing is covered by the reader's unit tests; integration models the
    // exact reviewed module hash without executing downloaded platform code.
    return Uint8Array.from(Buffer.from(options.badModuleHash ? '00'.repeat(32) : moduleDigest, 'hex')).buffer;
  } } };
  document = new Target();
  document.documentElement = new Element('html'); document.documentElement._connected = true;
  const savedDocumentElement = document.documentElement;
  document.body = new Element('body'); document.documentElement.appendChild(document.body);
  document.visibilityState = 'visible'; document.readyState = 'complete';
  document.createElement = (tag) => new Element(tag);
  document.querySelectorAll = (selector) => document.documentElement
    ? [document.documentElement, ...descendants(document.documentElement)].filter((node) => matchSelector(node, selector, document.documentElement)) : [];
  document.querySelector = (selector) => document.querySelectorAll(selector)[0] || null;
  document.getElementById = (id) => document.querySelector('#' + id);
  function el(tag, className, parent, text) {
    const element = new Element(tag); element.className = className;
    if (text) element.textContent = text;
    if (parent) parent.appendChild(element);
    return element;
  }
  const sidebar = el('aside', 'course-sidebar', document.body);
  const chapters = el('div', 'course-chapters', sidebar);
  const items = [];
  for (const chapter of catalog) {
    const group = el('div', 'chapter', chapters);
    const title = el('div', 'chapter-title', group); el('span', '', title, chapter.name);
    const sections = el('div', 'chapter-sections', group);
    for (const node of chapter.children) {
      const index = items.length;
      const row = el('div', 'section-item' + (index === (options.active || 0) ? ' active' : ''), sections);
      row.index = index;
      const header = el('div', 'section-header', row);
      row.titleElement = el('span', 'section-title', header, node.name);
      items.push(row);
    }
  }
  const initialVideo = new Video(); document.body.appendChild(initialVideo);
  let videoList = [initialVideo];
  if (options.source) initialVideo.currentSrc = options.source;
  function emit(type, target = document, extra = {}) {
    const event = { type, target, isTrusted: true, ...extra };
    document.fire(type, event, true);
    if (target !== document) target.fire(type, event);
    document.fire(type, event, false);
  }
  async function flush() {
    for (let rounds = 0; rounds < 100; rounds += 1) {
      while (microtasks.length) microtasks.shift()();
      await Promise.resolve(); await Promise.resolve();
      if (rounds >= 15 && !microtasks.length) { await Promise.resolve(); if (!microtasks.length) return; }
    }
    throw new Error('Microtask loop');
  }
  async function advance(ms) {
    await flush(); const end = now + ms;
    for (let steps = 0; steps < 20000; steps += 1) {
      const next = [...timers].filter(([, task]) => task.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) { now = end; await flush(); return; }
      timers.delete(next[0]); now = Math.max(now, next[1].due); next[1].callback(); await flush();
    }
    throw new Error('Timer loop');
  }
  async function jump(ms) {
    now += ms;
    const due = [...timers].filter(([, task]) => task.due <= now);
    for (const [id, task] of due) if (timers.delete(id)) task.callback();
    await flush();
  }
  const sandbox = {
    window, document, location, Element, HTMLVideoElement: Video, Date: FakeDate,
    URL, URLSearchParams, Blob, WeakMap, WeakSet, Map, Set, Number, JSON, Promise,
    AbortController, TextEncoder, Uint8Array, ArrayBuffer, crypto,
    XMLHttpRequest: FakeXHR, Response: FakeResponse,
    console: { warn: (...args) => warnings.push(args.join(' ')), log() {}, error: (...args) => warnings.push(args.join(' ')) },
    navigator: { clipboard: { writeText: async (value) => { clipboard = value; } } },
    queueMicrotask: (callback) => microtasks.push(callback),
    setTimeout: (callback, delay = 0) => { const id = ++timerId; timers.set(id, { callback, due: now + Number(delay) }); return id; },
    clearTimeout: (id) => timers.delete(id),
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} },
  };
  Object.assign(window, sandbox); window.XMLHttpRequest = FakeXHR; window.fetch = nativeFetch; window.window = window;
  window.webpackChunktravel_web = options.missingClient ? undefined : webpackChunks;
  Object.defineProperty(sandbox, 'fetch', { get: () => window.fetch, set: (value) => { window.fetch = value; }, configurable: true });
  const forbidden = () => { credentialTouches += 1; throw new Error('Credential storage must not be read'); };
  Object.defineProperty(document, 'cookie', { get: forbidden });
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, { get: forbidden }); Object.defineProperty(sandbox, name, { get: forbidden });
  }
  const context = vm.createContext(sandbox);
  api = {
    context, window, document, location, catalog, nodes, items, sidebar, chapters,
    initialVideo, Video, clicks, warnings, requests, progressCalls, client, emit, flush, advance, jump, onItemClick: null,
    get now() { return now; },
    setCompletion(indices) { progressBody = fixtureProgress(catalog, indices); },
    setProgress(body) { progressBody = body; },
    setProgressBehavior(callback) { progressBehavior = callback; },
    get credentialTouches() { return credentialTouches; },
    get extraRequests() { return requests.filter((request) => !request.platform); },
    get platformRequests() { return requests.filter((request) => request.platform); },
    get video() { return videoList[0]; },
    get host() { return document.getElementById('nhjcxy-auto-next-control'); },
    get panel() { return api.host?.shadowRoot; },
    get status() { return api.panel?.querySelector('.status')?.textContent || ''; },
    get enabled() { return api.panel?.querySelector('.toggle')?.getAttribute('aria-pressed') === 'true'; },
    setActive(index, updateNode = false) {
      for (const item of items) item.classList.toggle('active', item.index === index);
      if (updateNode) { const url = new URL(location.href); url.searchParams.set('nodeId', String(nodes[index].id)); location.href = url.href; }
    },
    async toggle() { api.panel.querySelector('.toggle').click(); await flush(); },
    async report() { api.panel.querySelector('.copy-log').click(); await flush(); return JSON.parse(clipboard); },
    async end(video = api.video) { video.currentTime = video.duration; video.ended = true; video.paused = true; emit('ended', video); await flush(); },
    load(index, config = {}) {
      api.setActive(index, config.updateNode === true);
      let video = config.replace ? new Video() : api.video;
      if (config.replace) { api.video.remove(); videoList = [video]; document.body.appendChild(video); }
      video.currentSrc = config.source || nodes[index].localFile;
      video.currentTime = config.ended ? 120 : 0; video.duration = 120; video.readyState = 4;
      video.paused = !config.playing; video.ended = Boolean(config.ended); video.error = null;
      if (config.events !== false) { emit('loadstart', video); emit('loadedmetadata', video); if (config.playing) emit('playing', video); }
      return video;
    },
    mutate() { for (const observer of observers) observer.callback([]); },
    runAgain() { vm.runInContext(script, context, { filename: scriptPath }); },
    mountDocument() { document.documentElement = savedDocumentElement; document.readyState = 'interactive'; emit('DOMContentLoaded'); },
    platformCatalog(value = catalog, config = {}) {
      const url = config.url || '/api/user/yee_node_select?courseId=course-A&schoolId=22&studentId=PRIVATE_ACCOUNT';
      const xhr = new window.XMLHttpRequest(); xhr.open(config.method || 'GET', url);
      platformRequestDepth += 1; try { xhr.send(); } finally { platformRequestDepth -= 1; }
      if (config.respond !== false) xhr.respond({ code: 200, msg: 'success', data: value }, config);
      return xhr;
    },
    async platformFetchCatalog(value = catalog) {
      nextFetchBody = { code: 200, msg: 'success', data: value };
      platformRequestDepth += 1;
      try { await window.fetch('/api/user/yee_node_select?courseId=course-A&schoolId=22&studentId=PRIVATE_ACCOUNT'); }
      finally { platformRequestDepth -= 1; }
      await flush();
    },
  };
  if (options.beforeDocumentElement) { document.documentElement = null; document.readyState = 'loading'; }
  vm.runInContext(script, context, { filename: scriptPath });
  if (options.captureCatalog !== false) api.platformCatalog();
  return api;
}

module.exports = { browser, fixtureCatalog, fixtureProgress };
