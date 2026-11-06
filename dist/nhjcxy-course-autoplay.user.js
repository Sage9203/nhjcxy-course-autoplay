// ==UserScript==
// @name         南航金城学院课程自动联播（手动开启）
// @namespace    urn:userscript:nhjcxy-course-auto-next
// @version      1.2.1
// @description  仅适配南航金城学院海旗课程学习页。手动开启，视频自然结束后只读核对平台完成记录，再进入下一讲；提供停止、异常提示和本地日志。
// @license      MIT
// @match        https://nhjcxy.haiqikeji.com/student/course-study*
// @exclude      https://nhjcxy.haiqikeji.com/student/course-study-record*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
MIT License

Copyright (c) 2026 nhjcxy-course-auto-next contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

(() => {
  'use strict';

  const VERSION = '1.2.1';
  const STUDY_PATH = '/student/course-study';
  const HOST_ID = 'nhjcxy-auto-next-control';
  const ITEM_SELECTOR = '.section-item';
  const ACTIVE_SELECTOR = '.section-item.active';
  // This delay gives the site time to submit progress. It is NOT a server acknowledgement.
  const END_DELAY_MS = 3500;
  const TRANSITION_TIMEOUT_MS = 45000;
  const PLAY_TIMEOUT_MS = 20000;
  const STABLE_MEDIA_MS = 700;
  const POLL_MS = 500;
  const IDLE_POLL_MS = 1000;
  const LOG_LIMIT = 150;

  if (location.pathname !== STUDY_PATH) return;
  if (document.getElementById(HOST_ID) || window.__nhjcxyIdentityPreviewInstalled) {
    console.warn('[课程联播] 页面已有联播面板，请只启用一个版本并刷新页面。');
    return;
  }

  window.__nhjcxyIdentityPreviewInstalled = true;

  let enabled = false;
  let phase = 'off';
  let generation = 0;
  let courseId = '';
  let operation = null;
  let timer = 0;
  let tickQueued = false;
  let ticking = false;
  const mediaRecords = new WeakMap();
  const events = [];

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all:initial; }
      :host([hidden]) { display:none !important; }
      .panel { box-sizing:border-box; width:270px; max-width:calc(100vw - 32px); padding:12px;
        border:1px solid #d8dee8; border-radius:12px; background:#fff; color:#172033;
        box-shadow:0 6px 24px rgba(20,35,55,.2); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
      .heading { display:flex; justify-content:space-between; margin-bottom:8px; font-weight:600; }
      .version,.context,.hint { color:#64748b; font-size:12px; }
      button { box-sizing:border-box; border:0; border-radius:8px; cursor:pointer; font:inherit; }
      .toggle { width:100%; padding:9px 12px; background:#2484e8; color:#fff; font-weight:600; }
      .toggle[aria-pressed="true"] { background:#c0392b; }
      button:focus-visible,summary:focus-visible { outline:3px solid #80bfff; outline-offset:2px; }
      .status { margin-top:8px; overflow-wrap:anywhere; }
      .context { margin-top:5px; overflow-wrap:anywhere; }
      details { margin-top:9px; border-top:1px solid #e5e7eb; padding-top:7px; }
      summary { cursor:pointer; color:#475569; font-size:12px; }
      .actions { display:flex; gap:6px; margin:8px 0; }
      .actions button { flex:1; padding:6px; background:#eaf2fc; color:#18548c; font-size:12px; }
      .log-preview { max-height:130px; overflow:auto; margin:7px 0 0; white-space:pre-wrap;
        overflow-wrap:anywhere; color:#475569; font:11px/1.5 ui-monospace,monospace; }
      .hint { margin:6px 0 0; }
    </style>
    <section class="panel" aria-label="课程自动联播">
      <div class="heading"><span>课程自动联播</span><span class="version">v${VERSION}</span></div>
      <button class="toggle" type="button" aria-pressed="false">开启自动联播</button>
      <div class="status" role="status" aria-live="polite">关闭状态：不会自动切换课程。</div>
      <div class="context"></div>
      <div class="identity-context context"></div>
      <div class="media-state context"></div>
      <div class="completion-context context"></div>
      <details>
        <summary>日志与诊断</summary>
        <div class="actions">
          <button class="copy-log" type="button">复制日志</button>
          <button class="download-log" type="button">下载日志</button>
        </div>
        <div class="hint" role="status" aria-live="polite">日志仅留在本页内存，刷新后清空。</div>
        <pre class="log-preview"></pre>
      </details>
    </section>`;

  const toggleButton = shadow.querySelector('.toggle');
  const statusElement = shadow.querySelector('.status');
  const contextElement = shadow.querySelector('.context');
  const hintElement = shadow.querySelector('.hint');
  const logPreview = shadow.querySelector('.log-preview');

  const resolveCatalogIdentity = (function () {
'use strict';

// Pure identity diagnostic, not a userscript. No DOM, network, storage, credentials
// or playback operations occur here. "verified" means supplied snapshots agree;
// callers must establish response provenance/freshness before supplying them.
// resolveCatalogIdentity needs only context.courseId/context.catalogCourseId,
// catalog and dom; resolveLessonIdentity additionally checks the progress input.
// Input:
// {
//   context: { courseId, catalogCourseId, progressCourseId },
//   catalog: { code: 200, data: [ { id?, name, sort?, children: [
//     { id, name, sort?, tabVideo, tabWork?, tabExam?, tabFile?, tabVote?, subItems? }
//   ] } ] }, // data.list and one chapter object are also supported.
//   dom: { courseId, chapters: [ { title, chapterId?, nodes: [
//     { title, active: true|false, nodeId?, hasSubItems?: true|false }
//   ] } ] },
//   progress: { code: 200, data: { nodeProgressList: [ ... ] } }
// }
// DOM IDs must come from explicitly understood semantic attributes, never a
// framework key, generated element id, array position, or stale URL parameter.

function normalizeText(value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
}

function identifier(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  // IDs are opaque. The site compares String(id), so stripping whitespace or
  // numeric-looking zeroes could merge identifiers the site treats as distinct.
  return typeof value === 'string' && value && value.trim() === value ? value : null;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknown(reason, details = {}) {
  return { status: 'unknown', reason, nodeId: null, ...details };
}

function sortValue(value) {
  if (value === undefined || value === null || value === '' || value === false) return 0;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ordered(items) {
  if (items.some(item => !object(item) || sortValue(item.sort) === null)) return null;
  // The inspected site sorts by (sort || 0). Copy first to keep this API pure.
  return items.slice().sort((a, b) => sortValue(a.sort) - sortValue(b.sort));
}

function kindOf(node) {
  const kinds = [
    ['video', 'tabVideo'], ['work', 'tabWork'], ['exam', 'tabExam'],
    ['materials', 'tabFile'], ['externalLink', 'tabVote'],
  ].filter(([, flag]) => node[flag] === 1).map(([kind]) => kind);
  return kinds.length === 1 ? kinds[0] : kinds.length ? 'mixed' : 'unknown';
}

function groupsBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const value = key(item);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }
  return groups;
}

function resolveCatalogIdentity(input) {
  if (!object(input) || !object(input.context) || !object(input.dom)) return unknown('invalid_input');
  const { context, catalog, dom } = input;
  const courseId = identifier(context.courseId);
  const contextIds = [context.catalogCourseId, dom.courseId].map(identifier);
  if (!courseId || contextIds.some(id => !id)) return unknown('course_context_missing');
  if (contextIds.some(id => id !== courseId)) return unknown('course_context_mismatch');
  if (!object(catalog) || catalog.code !== 200) {
    return unknown('response_not_successful');
  }
  if (catalog.courseId !== undefined && identifier(catalog.courseId) !== courseId) {
    return unknown('response_course_mismatch');
  }
  if (object(catalog.data) && catalog.data.courseId !== undefined && identifier(catalog.data.courseId) !== courseId) {
    return unknown('response_course_mismatch');
  }

  const rawChapters = Array.isArray(catalog.data) ? catalog.data
    : object(catalog.data) && Array.isArray(catalog.data.list) ? catalog.data.list
      : object(catalog.data) && Array.isArray(catalog.data.children) ? [catalog.data] : null;
  if (!rawChapters || !rawChapters.length) return unknown('catalog_chapters_missing');
  const chapters = ordered(rawChapters);
  if (!chapters) return unknown('catalog_sort_invalid');
  if (!Array.isArray(dom.chapters) || dom.chapters.length !== chapters.length) return unknown('chapter_count_mismatch');

  const chapterNames = groupsBy(chapters, chapter => normalizeText(chapter.name));
  const nodeIds = new Set();
  const chapterIds = new Set();
  const directory = [];
  const active = [];
  let directoryIndex = 0;

  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex];
    if (chapter.courseId !== undefined && identifier(chapter.courseId) !== courseId) {
      return unknown('catalog_chapter_course_mismatch', { chapterIndex });
    }
    const visibleChapter = dom.chapters[chapterIndex];
    const chapterTitle = normalizeText(chapter.name);
    const chapterId = chapter.id === undefined ? null : identifier(chapter.id);
    if (!chapterTitle) return unknown('catalog_chapter_title_missing', { chapterIndex });
    if (chapter.id !== undefined && !chapterId) return unknown('catalog_chapter_id_invalid', { chapterIndex });
    if (chapterId && chapterIds.has(chapterId)) return unknown('duplicate_chapter_id', { chapterIndex });
    if (chapterId) chapterIds.add(chapterId);
    if (!object(visibleChapter) || normalizeText(visibleChapter.title) !== chapterTitle) {
      return unknown('chapter_title_or_order_mismatch', { chapterIndex });
    }
    const visibleChapterId = visibleChapter.chapterId === undefined ? null : identifier(visibleChapter.chapterId);
    if (visibleChapter.chapterId !== undefined && (!visibleChapterId || visibleChapterId !== chapterId)) {
      return unknown('chapter_id_mismatch', { chapterIndex });
    }
    if (chapterNames.get(chapterTitle).length > 1 && !visibleChapterId) {
      return unknown('ambiguous_chapter_title', { chapterIndex });
    }
    if (chapter.children !== undefined && !Array.isArray(chapter.children)) return unknown('catalog_children_invalid', { chapterIndex });
    const nodes = ordered(chapter.children || []);
    if (!nodes) return unknown('catalog_sort_invalid', { chapterIndex });
    if (!Array.isArray(visibleChapter.nodes) || visibleChapter.nodes.length !== nodes.length) {
      return unknown('node_count_mismatch', { chapterIndex });
    }
    const titles = groupsBy(nodes, node => normalizeText(node.name));
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const node = nodes[nodeIndex];
      if (node.courseId !== undefined && identifier(node.courseId) !== courseId) {
        return unknown('catalog_node_course_mismatch', { chapterIndex, nodeIndex });
      }
      const visible = visibleChapter.nodes[nodeIndex];
      const nodeId = identifier(node.id);
      const nodeTitle = normalizeText(node.name);
      const position = { chapterIndex, nodeIndex, directoryIndex };
      directoryIndex += 1;
      if (!nodeId) return unknown('catalog_node_id_invalid', position);
      if (nodeIds.has(nodeId)) return unknown('duplicate_node_id', position);
      nodeIds.add(nodeId);
      if (!nodeTitle) return unknown('catalog_node_title_missing', position);
      if (!object(visible) || normalizeText(visible.title) !== nodeTitle) return unknown('node_title_or_order_mismatch', position);
      if (typeof visible.active !== 'boolean') return unknown('dom_active_state_invalid', position);
      const visibleId = visible.nodeId === undefined ? null : identifier(visible.nodeId);
      if (visible.nodeId !== undefined && (!visibleId || visibleId !== nodeId)) return unknown('dom_node_id_mismatch', position);
      if (titles.get(nodeTitle).length > 1 && !visibleId) return unknown('ambiguous_node_title', position);
      if (node.subItems !== undefined && node.subItems !== null && !Array.isArray(node.subItems)) {
        return unknown('catalog_subitems_invalid', position);
      }
      if (visible.hasSubItems !== undefined && typeof visible.hasSubItems !== 'boolean') {
        return unknown('dom_subitems_invalid', position);
      }
      const entry = { ...position, nodeId, chapterId, chapterTitle, nodeTitle, title: nodeTitle,
        kind: kindOf(node), hasSubItems: Boolean(node.subItems?.length || visible.hasSubItems) };
      directory.push(entry);
      if (visible.active) active.push(entry);
    }
  }
  if (active.length !== 1) return unknown('active_node_not_unique', { activeCount: active.length });
  const selected = active[0];
  if (selected.hasSubItems) return unknown('active_subitems_unsupported');
  if (selected.kind === 'mixed' || selected.kind === 'unknown') return unknown('active_kind_ambiguous');
  if (selected.kind !== 'video') return unknown('active_not_video', { kind: selected.kind });

  // Keep every validated entry, including non-video/unsupported next nodes.
  // A playback caller must decide whether to stop; this resolver never skips.
  return {
    status: 'verified', reason: 'catalog_dom_agree', source: 'catalog-dom', courseId,
    ...selected, directory,
  };
}

return resolveCatalogIdentity;

  })();
  const createCatalogRuntime = (function () {
'use strict';

// Passive, in-memory capture of the site's own catalogue requests. The media
// map deliberately never leaves this closure; this module makes no requests.
function createCatalogContextRuntime({ window: win, origin, onChange } = {}) {
  if (!win || typeof origin !== 'string') throw new TypeError('window and origin required');
  const URLType = win.URL || URL;
  const siteOrigin = new URLType(origin).origin;
  const path = '/api/user/yee_node_select';
  let installed = false;
  let disposed = false;
  let serial = 0;
  let revision = 0;
  let contextVersion = 0;
  let current = null;
  let media = new Map();
  const pending = new Set();
  const xhrMetadata = new WeakMap();
  let originalOpen, originalSend, originalFetch, ownOpen, ownSend, ownFetch, xhrPrototype;

  function id(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    return typeof value === 'string' && value && value.trim() === value ? value : null;
  }

  function target(method, address) {
    if (typeof method !== 'string' || method.toUpperCase() !== 'GET') return null;
    if (typeof address !== 'string' && !(address instanceof URLType)) return null;
    try {
      const url = new URLType(address, siteOrigin);
      const single = name => url.searchParams.getAll(name).length === 1 ? id(url.searchParams.get(name)) : null;
      const courseId = single('courseId');
      const schoolId = single('schoolId');
      const userId = single('studentId');
      return url.origin === siteOrigin && url.pathname === path
        ? { courseId, schoolId, userId } : null;
    } catch (_) { return null; }
  }

  function finalAddressMatches(address, request) {
    const result = target('GET', address);
    return !!result && result.courseId === request.courseId &&
      result.schoolId === request.schoolId && result.userId === request.userId;
  }

  function mediaAddress(value) {
    if (typeof value !== 'string') return null;
    let address = value.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!address) return null;
    if (/^http:\/\//i.test(address)) address = address.replace(/^http:/i, 'https:');
    else if (!/^(?:https:\/\/|blob:|data:)/i.test(address)) address = 'https://' + address;
    try { return new URLType(address).href; } catch (_) { return null; }
  }

  function summary(courseId) {
    const matches = current && id(courseId) === current.courseId;
    return Object.freeze({
      courseId: id(courseId), ready: !!(matches && current.catalog && !disposed),
      revision, contextVersion, contextReady: Boolean(matches && current.catalog && current.scope.schoolId && current.scope.userId && !disposed), nodeCount: matches ? current.nodeCount : 0,
      unsupportedMediaCount: matches ? current.unsupportedMediaCount : 0,
      reason: disposed ? 'disposed' : matches ? current.reason : 'catalog_not_observed',
    });
  }

  function notify() {
    if (!disposed && current && typeof onChange === 'function') {
      try { onChange(summary(current.courseId)); } catch (_) { /* Never affect the site. */ }
    }
  }

  function begin(scope) {
    const { courseId } = scope;
    const request = { ...scope, serial: ++serial };
    revision += 1;
    contextVersion += 1;
    media = new Map();
    current = { courseId, catalog: null, capturedAt: null, nodeCount: 0,
      unsupportedMediaCount: 0, reason: 'catalog_pending', scope: { ...scope } };
    notify();
    return request;
  }

  function isCurrent(request) {
    return !disposed && request.serial === serial && current && request.courseId === current.courseId;
  }

  function fail(request, reason) {
    if (!isCurrent(request)) return;
    revision += 1;
    media = new Map();
    current.catalog = null;
    current.capturedAt = null;
    current.nodeCount = 0;
    current.unsupportedMediaCount = 0;
    current.reason = reason;
    notify();
  }

  function sanitize(response, courseId) {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!object(response) || response.code !== 200) throw new Error('catalog_response_invalid');
    const data = response.data;
    const chapters = Array.isArray(data) ? data : object(data) && Array.isArray(data.list) ? data.list
      : object(data) && Array.isArray(data.children) ? [data] : null;
    if (!chapters || !chapters.length || chapters.length > 5000) throw new Error('catalog_shape_invalid');
    const fields = ['id', 'name', 'sort', 'courseId', 'tabVideo', 'tabWork', 'tabExam',
      'tabFile', 'tabVote', 'lock', 'unlockTime'];
    const urls = new Map();
    const nodeIds = new Set();
    const chapterIds = new Set();
    let nodeCount = 0;
    let unsupportedMediaCount = 0;
    function copyFields(source) {
      if (!object(source)) throw new Error('catalog_shape_invalid');
      const result = {};
      for (const key of fields) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const value = source[key];
        if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' &&
            !(typeof value === 'number' && Number.isFinite(value))) throw new Error('catalog_field_invalid');
        result[key] = value;
      }
      if (typeof result.name !== 'string') throw new Error('catalog_name_invalid');
      if (result.courseId !== undefined && id(result.courseId) !== courseId) throw new Error('catalog_course_mismatch');
      return result;
    }
    // Only explicitly understood course IDs are inspected, never user IDs.
    for (const value of [response, object(data) ? data : null]) {
      if (value && value.courseId !== undefined && id(value.courseId) !== courseId) throw new Error('catalog_course_mismatch');
    }
    const cleanChapters = chapters.map(chapter => {
      const clean = copyFields(chapter);
      if (!Array.isArray(chapter.children)) throw new Error('catalog_shape_invalid');
      if (clean.id !== undefined) {
        const chapterId = id(clean.id);
        if (!chapterId || chapterIds.has(chapterId)) throw new Error('catalog_id_invalid');
        chapterIds.add(chapterId);
      }
      clean.children = Object.freeze(chapter.children.map(node => {
        const item = copyFields(node);
        const nodeId = id(item.id);
        if (!nodeId || nodeIds.has(nodeId) || ++nodeCount > 5000) throw new Error('catalog_id_invalid');
        nodeIds.add(nodeId);
        if (Object.prototype.hasOwnProperty.call(node, 'subItems')) {
          if (node.subItems === null) item.subItems = null;
          else if (Array.isArray(node.subItems) && node.subItems.length <= 5000) {
            // Retain only presence/shape, never nested payload or URLs.
            item.subItems = Object.freeze(node.subItems.length ? [Object.freeze({})] : []);
          } else throw new Error('catalog_subitems_invalid');
        }
        if (item.tabVideo === 1) {
          const address = mediaAddress(node.localFile);
          if (address) urls.set(nodeId, address);
          else unsupportedMediaCount += 1;
        }
        return Object.freeze(item);
      }));
      return Object.freeze(clean);
    });
    return { catalog: Object.freeze({ code: 200, courseId, data: Object.freeze(cleanChapters) }),
      urls, nodeCount, unsupportedMediaCount };
  }

  function accept(request, response) {
    if (!isCurrent(request)) return;
    let result;
    try { result = sanitize(response, request.courseId); }
    catch (_) { fail(request, 'catalog_response_invalid'); return; }
    revision += 1;
    media = result.urls;
    current = { courseId: request.courseId, catalog: result.catalog,
      capturedAt: Date.now(), nodeCount: result.nodeCount,
      unsupportedMediaCount: result.unsupportedMediaCount, reason: 'catalog_ready',
      scope: { courseId: request.courseId, schoolId: request.schoolId, userId: request.userId } };
    notify();
  }

  function fetchTarget(input, options) {
    let address, method = 'GET';
    if (typeof input === 'string' || input instanceof URLType) address = input;
    else if (win.Request && input instanceof win.Request) { address = input.url; method = input.method; }
    else return null;
    if (options !== undefined && options !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(options, 'method');
      // Accessors/custom inherited options are passed through untouched.
      if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      if (descriptor) { if (descriptor.value !== undefined) method = descriptor.value; }
      else if ('method' in Object(options)) return null;
    }
    return target(method, address);
  }

  async function observeFetch(request, response) {
    if (!isCurrent(request)) return;
    try {
      if (!response || response.status !== 200 || !finalAddressMatches(response.url, request)) {
        fail(request, 'catalog_http_invalid'); return;
      }
      const value = await response.clone().json();
      accept(request, value);
    } catch (_) { fail(request, 'catalog_parse_failed'); }
  }

  function install() {
    if (disposed) return false;
    if (installed) return true;
    installed = true;
    xhrPrototype = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (xhrPrototype && typeof xhrPrototype.open === 'function' && typeof xhrPrototype.send === 'function') {
      originalOpen = xhrPrototype.open;
      originalSend = xhrPrototype.send;
      ownOpen = function (...args) {
        const result = Reflect.apply(originalOpen, this, args);
        if (!disposed) {
          try { xhrMetadata.set(this, target(args[0], args[1])); } catch (_) { xhrMetadata.delete(this); }
        }
        return result;
      };
      ownSend = function (...args) {
        const match = !disposed && xhrMetadata.get(this);
        if (!match) return Reflect.apply(originalSend, this, args);
        const request = begin(match);
        if (disposed) return Reflect.apply(originalSend, this, args);
        const xhr = this;
        let settled = false;
        const cleanup = () => {
          for (const type of ['load', 'error', 'abort', 'timeout']) {
            try { xhr.removeEventListener(type, finish); } catch (_) { /* Keep native errors intact. */ }
          }
          pending.delete(cleanup);
        };
        function finish(event) {
          if (settled) return;
          settled = true;
          cleanup();
          if (!isCurrent(request)) return;
          if (event.type !== 'load') { fail(request, 'catalog_request_failed'); return; }
          try {
            if (xhr.status !== 200 || !finalAddressMatches(xhr.responseURL, request)) {
              fail(request, 'catalog_http_invalid'); return;
            }
            const type = xhr.responseType;
            const response = type === 'json' ? xhr.response
              : type === '' || type === 'text' ? JSON.parse(xhr.responseText) : null;
            accept(request, response);
          } catch (_) { fail(request, 'catalog_parse_failed'); }
        }
        try {
          for (const type of ['load', 'error', 'abort', 'timeout']) xhr.addEventListener(type, finish);
          pending.add(cleanup);
        } catch (_) {
          try { cleanup(); } catch (_) { /* Observation is optional. */ }
          fail(request, 'catalog_observer_failed');
          return Reflect.apply(originalSend, this, args);
        }
        try { return Reflect.apply(originalSend, this, args); }
        catch (error) { cleanup(); fail(request, 'catalog_request_failed'); throw error; }
      };
      xhrPrototype.open = ownOpen;
      xhrPrototype.send = ownSend;
    }
    if (typeof win.fetch === 'function') {
      originalFetch = win.fetch;
      ownFetch = function (...args) {
        let match = null;
        if (!disposed) { try { match = fetchTarget(args[0], args[1]); } catch (_) { /* Pass through. */ } }
        const request = match ? begin(match) : null;
        let promise;
        try { promise = Reflect.apply(originalFetch, this, args); }
        catch (error) { if (request) fail(request, 'catalog_request_failed'); throw error; }
        if (request) {
          try {
            promise.then(response => { void observeFetch(request, response); }, () => { fail(request, 'catalog_request_failed'); });
          } catch (_) { fail(request, 'catalog_observer_failed'); }
        }
        return promise;
      };
      win.fetch = ownFetch;
    }
    return true;
  }

  function getCatalog(courseId) {
    if (!summary(courseId).ready) return null;
    return Object.freeze({ courseId: current.courseId, revision, catalog: current.catalog, capturedAt: current.capturedAt });
  }

  // Account scope stays inside the userscript closure; never pass this to log/report.
  function getQueryContext(courseId) {
    if (!summary(courseId).contextReady) return null;
    return Object.freeze({ ...current.scope, contextVersion, catalogRevision: revision });
  }

  function matchesMedia(courseId, nodeId, source) {
    if (!summary(courseId).ready) return false;
    const expected = media.get(id(nodeId));
    return !!expected && expected === mediaAddress(source);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    serial += 1;
    media.clear();
    current = null;
    for (const cleanup of [...pending]) { try { cleanup(); } catch (_) { /* Best effort. */ } }
    if (xhrPrototype && xhrPrototype.open === ownOpen) xhrPrototype.open = originalOpen;
    if (xhrPrototype && xhrPrototype.send === ownSend) xhrPrototype.send = originalSend;
    if (win.fetch === ownFetch) win.fetch = originalFetch;
  }

  return Object.freeze({ install, getCatalog, getQueryContext, matchesMedia, summary, dispose });
}

return createCatalogContextRuntime;

  })();
  const identityElement = shadow.querySelector('.identity-context');
  const catalogRuntime = createCatalogRuntime({
    window, origin: location.origin || new URL(location.href).origin,
    onChange(summary) {
      log('catalog_observed', summary);
      if (enabled && !sameSessionContext(sessionContext, catalogRuntime.getQueryContext(courseId))) {
        stopAuto('课程或登录上下文发生变化，联播已停止；请刷新后重新开启。', 'context_changed');
      }
      render();
      requestTick();
    },
  });

  const { createPlatformProgressReader } = (function () {
'use strict';

// Reuse only the inspected site's existing Axios singleton. Never extract
// credentials, inspect request headers, import code, or evaluate factory text.

function createPlatformProgressReader({ window: win, origin } = {}) {
  let disposed = false;
  let acquisition = null;
  const waiters = new Set();
  class ProgressReadError extends Error {}

  function failure(reason, retryable = false) {
    const error = new ProgressReadError(reason);
    error.name = 'ProgressReadError';
    error.reason = reason;
    error.retryable = retryable;
    return error;
  }

  function checkState(signal) {
    if (disposed) throw failure('progress_disposed');
    if (signal?.aborted) throw failure('progress_aborted');
  }

  function identifier(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    return typeof value === 'string' && value && value.trim() === value ? value : null;
  }

  function validateOrigin() {
    try {
      const URLType = win && (win.URL || URL);
      const parsed = new URLType(origin);
      if (parsed.origin !== origin || parsed.protocol !== 'https:' || win.location.origin !== parsed.origin) {
        throw failure('progress_origin_mismatch');
      }
    } catch (error) {
      if (error instanceof ProgressReadError) throw error;
      throw failure('progress_origin_mismatch');
    }
  }

  function captureRequire() {
    let chunks;
    try { chunks = win.webpackChunktravel_web; } catch (_) { throw failure('progress_runtime_unavailable'); }
    if (!Array.isArray(chunks) || typeof chunks.push !== 'function' || chunks.push === Array.prototype.push) {
      throw failure('progress_runtime_unavailable');
    }
    let captured = null;
    let active = true;
    const marker = 'nhjcxy-progress-reader-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    try {
      // Adds no modules and downloads nothing. The inspected webpack callback
      // synchronously supplies its cached module resolver to runtime callbacks.
      chunks.push([[marker], {}, (require) => { if (active) captured = require; }]);
    } catch (_) {
      active = false;
      captured = null;
      throw failure('progress_runtime_unavailable');
    }
    active = false;
    const result = captured;
    // The chunk history may retain the callback; do not leave require captured
    // by that publicly reachable function's closure after synchronous probing.
    captured = null;
    if (typeof result !== 'function') throw failure('progress_runtime_unavailable');
    return result;
  }

  async function acquireClient() {
    checkState();
    validateOrigin();
    const require = captureRequire();
    checkState();
    if (typeof require.m?.[51953] !== 'function') throw failure('progress_factory_unavailable');
    // This site-specific module exposes the configured HTTP client.
    let client;
    try {
      client = require(51953).A;
      if (typeof client !== 'function' || typeof client.get !== 'function' || client.defaults?.baseURL !== '/api') {
        throw failure('progress_client_unavailable');
      }
    } catch (error) {
      if (error instanceof ProgressReadError) throw error;
      throw failure('progress_client_unavailable');
    }
    checkState();
    return client;
  }

  function getClient() {
    if (!acquisition) acquisition = acquireClient();
    return acquisition;
  }

  function sanitized(error) {
    if (error instanceof ProgressReadError) return error;
    let code, name, status;
    try { code = error?.code; name = error?.name; status = error?.response?.status; }
    catch (_) { return failure('progress_request_failed'); }
    if (status === 401) return failure('progress_auth_required');
    if (code === 'ERR_CANCELED' || name === 'AbortError' || name === 'CanceledError') return failure('progress_aborted');
    if (code === 'ERR_NETWORK' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return failure('progress_network_failed', true);
    }
    return failure('progress_request_failed');
  }

  function bounded(promise, signal, onCancel) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        waiters.delete(onDispose);
        try {
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        } catch (_) { /* Best effort only. */ }
      };
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        if (callback === reject) onCancel();
        cleanup();
        callback(value);
      };
      const onAbort = () => settle(reject, failure('progress_aborted'));
      const onDispose = () => settle(reject, failure('progress_disposed'));
      waiters.add(onDispose);
      try {
        if (signal) {
          if (typeof signal.addEventListener !== 'function') throw failure('progress_signal_invalid');
          signal.addEventListener('abort', onAbort, { once: true });
        }
        checkState(signal);
      } catch (error) { settle(reject, sanitized(error)); }
      // Always observe the internal promise, even if cancellation was already
      // delivered. Late browser results never become unhandled rejections.
      promise.then(value => {
        if (settled) return;
        try { checkState(signal); settle(resolve, value); }
        catch (error) { settle(reject, sanitized(error)); }
      }, error => settle(reject, sanitized(error)));
    });
  }

  function query(input = {}) {
    let courseId, schoolId, userId, signal;
    try {
      ({ signal } = input);
      checkState(signal);
      validateOrigin();
      courseId = identifier(input.courseId);
      schoolId = identifier(input.schoolId);
      userId = identifier(input.userId);
      if (!courseId || !schoolId || !userId) throw failure('progress_context_invalid');
    } catch (error) { return Promise.reject(sanitized(error)); }
    let cancelled = false;
    const ensure = () => {
      checkState(signal);
      if (cancelled) throw failure('progress_aborted');
    };
    const attempt = Promise.resolve().then(async () => {
      ensure();
      const client = await getClient();
      ensure();
      const response = await client.get('/user/get_study_progress', {
        params: { courseId, schoolId, userId }, timeout: 8000, signal,
      });
      ensure();
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw failure('progress_response_invalid');
      if (response.code === 401 || response.code === '401') throw failure('progress_auth_required');
      if (response.code !== 200) throw failure('progress_business_rejected');
      if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data) ||
          !Array.isArray(response.data.nodeProgressList)) throw failure('progress_response_invalid');
      // Future response versions may attest their own scope. Any explicit
      // contradiction is a failure, even when IDs/titles happen to coincide.
      const expected = { courseId, schoolId, userId, studentId: userId };
      for (const value of [response, response.data, response.data.summary, ...response.data.nodeProgressList]) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const [key, wanted] of Object.entries(expected)) {
          if (Object.prototype.hasOwnProperty.call(value, key) && identifier(value[key]) !== wanted) {
            throw failure('progress_context_mismatch');
          }
        }
      }
      return response;
    });
    return bounded(attempt, signal, () => { cancelled = true; });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const cancel of [...waiters]) cancel();
  }

  return Object.freeze({ query, dispose });
}

return { createPlatformProgressReader };

})();
  const { evaluateNodeCompletion, createCompletionGate } = (function () {
'use strict';

// Pure interpretation of a caller-provenanced read-only progress response.
// Authentication, response freshness and request/course provenance belong to
// the query adapter. No response payload or account field is returned here.
function evaluateNodeCompletion({ courseId, expectedLesson, directory, progress } = {}) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const identifier = value => typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0 ? String(value) : null
    : typeof value === 'string' && value && value.trim() === value ? value : null;
  const text = value => typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
  const result = (status, reason) => ({ status, reason });
  const invalid = reason => result('invalid', reason);
  const id = identifier(courseId);
  if (!id || !object(expectedLesson) || !Array.isArray(directory) || !directory.length) return invalid('completion_context_invalid');
  const courseMatches = value => !object(value) || value.courseId === undefined || identifier(value.courseId) === id;
  if (!courseMatches(expectedLesson)) return invalid('completion_lesson_course_mismatch');
  const expectedId = identifier(expectedLesson.nodeId);
  const expectedTitle = text(expectedLesson.title ?? expectedLesson.nodeTitle);
  const expectedChapter = text(expectedLesson.chapterTitle);
  if (!expectedId || !expectedTitle || !expectedChapter) return invalid('completion_lesson_invalid');
  const targets = directory.filter(entry => identifier(entry?.nodeId) === expectedId);
  const expected = targets[0];
  if (targets.length !== 1 || !courseMatches(expected) || text(expected.title ?? expected.nodeTitle) !== expectedTitle ||
      text(expected.chapterTitle) !== expectedChapter || expected.kind !== expectedLesson.kind ||
      expected.chapterId !== expectedLesson.chapterId || expected.hasSubItems !== expectedLesson.hasSubItems) {
    return invalid('completion_lesson_directory_mismatch');
  }
  if ((expectedLesson.kind !== undefined && expectedLesson.kind !== 'video') || expectedLesson.hasSubItems) {
    return invalid('completion_lesson_unsupported');
  }
  if (!object(progress) || progress.code !== 200 || !object(progress.data)) return invalid('completion_response_invalid');
  if (!courseMatches(progress) || !courseMatches(progress.data) || !courseMatches(progress.data.summary)) {
    return invalid('completion_response_course_mismatch');
  }
  const list = progress.data.nodeProgressList;
  if (!Array.isArray(list)) return invalid('completion_records_missing');
  const matches = list.filter(record => object(record) && identifier(record.nodeId) === expectedId);
  if (matches.length !== 1) return invalid('completion_target_not_unique');
  const record = matches[0];
  if (!courseMatches(record)) return invalid('completion_record_course_mismatch');
  if (text(record.nodeName) !== expectedTitle || text(record.chapterName) !== expectedChapter) {
    return invalid('completion_record_title_mismatch');
  }
  const ratio = typeof record.progressRatio === 'string' && /^\d+(?:\.\d+)?$/.test(record.progressRatio)
    ? Number(record.progressRatio) : null;
  function observedDateTime(value) {
    if (typeof value !== 'string') return false;
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if (!match) return false;
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day >= 1 && day <= days[month - 1];
  }
  if (record.statusText === '已完成' && record.state === 1 && record.progressPercent === 100 &&
      ratio === 1 && observedDateTime(record.completeTime)) {
    return result('complete', 'observed_complete_combination');
  }
  if (record.statusText === '未开始' && record.state === 0 && record.progressPercent === 0 &&
      ratio === 0 && record.completeTime === null) {
    return result('unconfirmed', 'observed_not_started_combination');
  }
  return result('unconfirmed', 'unverified_or_conflicting_completion_fields');
}

// A bounded, poll-driven gate. It never navigates, plays or stores responses.
// Only request timeout timers are scheduled; the owner's normal tick calls poll.
function createCompletionGate(options = {}) {
  const { query, evaluate } = options;
  if (typeof query !== 'function' || typeof evaluate !== 'function') throw new TypeError('query and evaluate required');
  const clock = options.now || Date.now;
  const schedule = options.setTimeout || setTimeout;
  const unschedule = options.clearTimeout || clearTimeout;
  const Controller = options.AbortController || (typeof AbortController === 'function' ? AbortController : null);
  const isCurrent = options.isCurrent || (() => true);
  const onChange = options.onChange;
  const deadlineAt = options.deadlineAt === undefined ? clock() + 60000 : options.deadlineAt;
  const maxAttempts = options.maxAttempts === undefined ? 6 : options.maxAttempts;
  const retryMs = options.retryMs === undefined ? 5000 : options.retryMs;
  const requestTimeoutMs = options.requestTimeoutMs === undefined ? 8000 : options.requestTimeoutMs;
  if (!Number.isFinite(deadlineAt) || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
      !Number.isFinite(retryMs) || retryMs < 0 || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError('invalid completion gate budget');
  }
  let status = 'pending';
  let reason = 'awaiting_query';
  let attempts = 0;
  let active = null;
  let nextAt = -Infinity;
  const summary = () => Object.freeze({ status, attempts, reason });
  function notify() {
    if (typeof onChange === 'function') { try { onChange(summary()); } catch (_) { /* Owner UI is optional. */ } }
  }
  function clearActive(abort) {
    const request = active;
    active = null;
    if (!request) return;
    if (request.timer !== null) { try { unschedule(request.timer); } catch (_) { /* Best effort. */ } }
    if (abort) { try { request.controller?.abort(); } catch (_) { /* Cancellation also has an identity guard. */ } }
  }
  function finish(nextStatus, nextReason) {
    clearActive(true);
    status = nextStatus;
    reason = nextReason;
    notify();
    return summary();
  }
  function cancel() {
    if (status === 'pending') return finish('cancelled', 'completion_cancelled');
    return summary();
  }
  function validOperation() {
    let current = false;
    try { current = Boolean(isCurrent()); } catch (_) { /* A failed owner guard is not permission to continue. */ }
    if (!current) {
      finish('cancelled', 'completion_operation_changed');
      return false;
    }
    if (clock() >= deadlineAt) {
      finish('failed', 'completion_deadline_exceeded');
      return false;
    }
    return true;
  }
  function retry(request, retryReason) {
    if (active !== request || status !== 'pending' || !validOperation()) return;
    clearActive(true);
    if (attempts >= maxAttempts) { finish('failed', 'completion_attempts_exhausted'); return; }
    nextAt = clock() + retryMs;
    reason = retryReason;
    notify();
  }
  function failRequest(request, error) {
    if (active !== request || status !== 'pending' || !validOperation()) return;
    let retryable = false;
    try { retryable = error?.retryable === true; } catch (_) { /* Raw errors never leave this closure. */ }
    if (retryable) retry(request, 'completion_query_retry');
    else finish('failed', 'completion_query_failed');
  }
  function accept(request, value) {
    if (active !== request || status !== 'pending' || !validOperation()) return;
    let evaluationStatus;
    try { evaluationStatus = evaluate(value)?.status; }
    catch (_) { finish('failed', 'completion_evaluation_failed'); return; }
    if (active !== request || status !== 'pending' || !validOperation()) return;
    if (evaluationStatus === 'complete') finish('confirmed', 'completion_confirmed');
    else if (evaluationStatus === 'unconfirmed') retry(request, 'completion_unconfirmed');
    else finish('failed', 'completion_response_invalid');
  }
  function poll() {
    if (status !== 'pending' || !validOperation()) return summary();
    if (active || clock() < nextAt) return summary();
    if (attempts >= maxAttempts) return finish('failed', 'completion_attempts_exhausted');
    let controller;
    try { controller = Controller ? new Controller() : null; }
    catch (_) { return finish('failed', 'completion_abort_setup_failed'); }
    const request = { controller, timer: null };
    attempts += 1;
    active = request;
    reason = 'completion_query_pending';
    try {
      request.timer = schedule(() => {
        if (active !== request || status !== 'pending' || !validOperation()) return;
        retry(request, 'completion_query_timeout');
      }, Math.min(requestTimeoutMs, Math.max(0, deadlineAt - clock())));
    } catch (_) { return finish('failed', 'completion_timeout_setup_failed'); }
    notify();
    // onChange can synchronously stop the owner's operation.
    if (active !== request || status !== 'pending' || !validOperation()) return summary();
    let promise;
    try { promise = query(controller?.signal); }
    catch (error) { failRequest(request, error); return summary(); }
    Promise.resolve(promise).then(value => { accept(request, value); }, error => { failRequest(request, error); });
    return summary();
  }
  return Object.freeze({ poll, summary, cancel });
}

return { evaluateNodeCompletion, createCompletionGate };

})();
// Runs inside the independent completion-preview closure.
  let sessionContext = null;
  let lastCompletion = null;
  const progressReader = createPlatformProgressReader({ window, origin: new URL(location.href).origin });

  function sameSessionContext(a, b) {
    return Boolean(a && b && a.courseId === b.courseId && a.schoolId === b.schoolId &&
      a.userId === b.userId && a.contextVersion === b.contextVersion && a.catalogRevision === b.catalogRevision);
  }

  function ensureCompletion(op, lesson) {
    if (!sameSessionContext(sessionContext, catalogRuntime.getQueryContext(courseId))) {
      stopAuto('课程或登录上下文发生变化，完成核对已取消；请刷新后重新开启。', 'context_changed');
      return false;
    }
    if (!op.completionGate) {
      const scope = sessionContext;
      // Already verified directory metadata; never select by the current active row.
      const directory = lesson.directory.map(lessonInfo);
      const expectedLesson = lessonInfo(op.from);
      op.completionGate = createCompletionGate({
        deadlineAt: op.notBefore + 60000,
        query: (signal) => progressReader.query({
          courseId: scope.courseId, schoolId: scope.schoolId, userId: scope.userId, signal,
        }).catch((error) => {
          if (currentOperation(op)) log('completion_query_error', { reason: error.reason });
          throw error;
        }),
        evaluate: (progress) => evaluateNodeCompletion({ courseId: scope.courseId, expectedLesson, directory, progress }),
        isCurrent: () => currentOperation(op) && sameSessionContext(scope, catalogRuntime.getQueryContext(scope.courseId)),
        onChange(check) {
          if (!currentOperation(op)) return;
          lastCompletion = { nodeId: expectedLesson.nodeId, title: expectedLesson.title, ...check };
          log('completion_check', { lesson: expectedLesson, check });
          requestTick();
        },
      });
    }
    const check = op.completionGate.poll();
    lastCompletion = { nodeId: op.from.nodeId, title: op.from.title, ...check };
    if (check.status === 'confirmed') return true;
    if (check.status === 'failed' || check.status === 'cancelled') {
      stopAuto('平台完成记录未能确认，联播已停止。请查看学习记录或导出日志。', 'completion_not_confirmed', { check });
      return false;
    }
    setStatus(check.reason === 'completion_query_pending'
      ? `正在核对本讲的平台记录（第 ${check.attempts} 次）…`
      : `平台尚未确认本讲完成，正在有限等待（已查询 ${check.attempts} 次）。`);
    return false;
  }

  function renderCompletion() {
    const element = shadow.querySelector('.completion-context');
    element.textContent = lastCompletion
      ? `上次核对：${lastCompletion.title} · ${lastCompletion.status === 'confirmed' ? '平台记录已完成' : lastCompletion.status === 'pending' ? '等待确认' : '未确认'}`
      : '本讲播放结束后核对平台完成记录。';
    const candidates = videos();
    const video = candidates.length === 1 ? candidates[0] : null;
    shadow.querySelector('.media-state').textContent = '播放器：' + (!video ? '等待加载' : video.error ? '播放报错'
      : video.ended ? '已结束' : video.seeking ? '正在定位' : video.paused ? '已暂停'
        : video.readyState < 3 ? '等待缓冲' : '播放中');
  }

  function route() {
    const url = new URL(location.href);
    return { path: url.pathname, courseId: url.searchParams.get('id') || '', nodeId: url.searchParams.get('nodeId') || '' };
  }

  function textOf(element) {
    return (element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

// Build fragment: runs inside the preview userscript's closure.
// No DOM position becomes an ID until the entire observed catalog agrees.
  let lastIdentityState = { status: 'unknown', reason: 'catalog_not_captured' };

  function readLesson() {
    const currentRoute = route();
    const fail = (reason) => {
      lastIdentityState = { status: 'unknown', reason };
      return null;
    };
    const captured = catalogRuntime.getCatalog(currentRoute.courseId);
    if (!captured) return fail('catalog_not_captured');
    const roots = document.querySelectorAll('.course-sidebar .course-chapters');
    if (roots.length !== 1) return fail('directory_not_unique');
    const root = roots[0];
    const items = [];
    const chapters = Array.from(root.querySelectorAll(':scope > .chapter'), (chapter) => ({
      title: textOf(chapter.querySelector(':scope > .chapter-title > span')),
      nodes: Array.from(chapter.querySelectorAll(':scope > .chapter-sections > .section-item'), (item) => {
        items.push(item);
        return {
          title: textOf(item.querySelector(':scope > .section-header > .section-title')),
          active: item.classList.contains('active'),
          hasSubItems: Boolean(item.querySelector('.sub-items .sub-item')),
        };
      }),
    }));
    if (!chapters.length || items.length !== root.querySelectorAll(ITEM_SELECTOR).length ||
        items.length !== document.querySelectorAll(ITEM_SELECTOR).length) {
      return fail('directory_structure_unrecognized');
    }
    const identity = resolveCatalogIdentity({
      context: { courseId: currentRoute.courseId, catalogCourseId: captured.courseId },
      catalog: captured.catalog,
      dom: { courseId: currentRoute.courseId, chapters },
    });
    if (identity.status !== 'verified') return fail(identity.reason);
    const directory = identity.directory.map((entry) => ({
      index: entry.directoryIndex, key: 'node:' + entry.nodeId,
      title: entry.nodeTitle, count: items.length, courseId: identity.courseId,
      nodeId: entry.nodeId, chapterId: entry.chapterId, chapterTitle: entry.chapterTitle,
      kind: entry.kind, hasSubItems: entry.hasSubItems,
    }));
    lastIdentityState = { status: 'verified', reason: identity.reason, nodeId: identity.nodeId };
    return {
      ...directory[identity.directoryIndex],
      next: directory[identity.directoryIndex + 1] || null, items, directory,
    };
  }

  function mediaMatchesLesson(video, lesson) {
    return Boolean(video && lesson && catalogRuntime.matchesMedia(lesson.courseId, lesson.nodeId, sourceOf(video)));
  }

  function identityMessage(reason) {
    if (reason === 'catalog_not_captured') {
      return '未捕获本站目录，请确认只启用一份联播脚本并刷新学习页。';
    }
    if (reason === 'active_not_video' || reason === 'active_subitems_unsupported' || reason === 'active_kind_ambiguous') {
      return '当前课节含非视频内容或子项目，请手动处理后再开启。';
    }
    return '目录与本站数据尚未对应，联播未开启；可导出日志查看原因。';
  }

  function lessonInfo(lesson) {
    if (!lesson) return null;
    const { index, key, title, count, courseId: id, nodeId, chapterId, chapterTitle, kind, hasSubItems } = lesson;
    return { index, key, title, count, courseId: id, nodeId, chapterId, chapterTitle, kind, hasSubItems };
  }

  function lessonSnapshot(lesson) {
    return lesson ? { ...lessonInfo(lesson), next: lessonInfo(lesson.next) } : null;
  }

  function sameLesson(a, b) {
    return Boolean(a && b && a.courseId === b.courseId && a.index === b.index &&
      a.key === b.key && a.count === b.count && a.title === b.title &&
      a.chapterId === b.chapterId && a.chapterTitle === b.chapterTitle &&
      a.kind === b.kind && a.hasSubItems === b.hasSubItems &&
      a.nodeId === b.nodeId);
  }

  function videos() {
    return Array.from(document.querySelectorAll('video')).filter((video) => video.isConnected);
  }

  function sourceOf(video) {
    return video.currentSrc || video.src || '';
  }

  function mediaRecord(video) {
    let record = mediaRecords.get(video);
    if (!record) {
      record = { serial: 0, lesson: null, source: '', playingSerial: -1 };
      mediaRecords.set(video, record);
    }
    return record;
  }

  function associate(video) {
    const lesson = readLesson();
    const record = mediaRecord(video);
    if (mediaMatchesLesson(video, lesson)) {
      record.lesson = lessonSnapshot(lesson);
      record.source = sourceOf(video);
      return true;
    }
    record.lesson = null;
    record.source = '';
    return false;
  }

  function mediaInfo(video) {
    if (!video) return null;
    return {
      connected: video.isConnected, paused: video.paused, ended: video.ended,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      readyState: video.readyState, networkState: video.networkState,
      errorCode: video.error?.code || null, loadSerial: mediaRecord(video).serial,
      loop: video.loop, sourcePresent: Boolean(sourceOf(video)),
    };
  }

  function log(code, detail = {}) {
    events.push({ time: new Date().toISOString(), code, phase, visibility: document.visibilityState, ...detail });
    if (events.length > LOG_LIMIT) events.splice(0, events.length - LOG_LIMIT);
    logPreview.textContent = events.slice(-8).map((entry) =>
      `${new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false })} ${entry.code}`).join('\n');
  }

  function setStatus(message) {
    if (statusElement.textContent !== message) statusElement.textContent = message;
  }

  function render() {
    toggleButton.textContent = enabled ? '停止自动联播' : '开启自动联播';
    toggleButton.setAttribute('aria-pressed', String(enabled));
    const lesson = readLesson();
    contextElement.textContent = lesson ? `${lesson.index + 1} / ${lesson.count} · ${lesson.title}` : '等待已验证的课程目录…';
    const currentRoute = route();
    identityElement.textContent = lesson
      ? `真实课节编号：${lesson.nodeId}${currentRoute.nodeId && currentRoute.nodeId !== lesson.nodeId ? ' · 地址栏仍是初始编号' : ''}`
      : identityMessage(lastIdentityState.reason);
    renderCompletion();
  }

  function stopAuto(message, code = 'stopped', detail = {}) {
    enabled = false;
    generation += 1;
    operation?.completionGate?.cancel();
    sessionContext = null;
    operation = null;
    if (timer) clearTimeout(timer);
    timer = 0;
    phase = 'off';
    render();
    setStatus(message);
    log(code, detail);
  }

  function checkRoute() {
    const current = route();
    host.hidden = current.path !== STUDY_PATH;
    if (enabled && (current.path !== STUDY_PATH || current.courseId !== courseId)) {
      stopAuto('已离开当前课程，联播已停止；返回后请手动开启。', 'route_changed');
      return false;
    }
    return enabled;
  }

  function currentOperation(op) {
    return enabled && operation === op && generation === op.generation && checkRoute();
  }

  function endedNormally(video) {
    return video.ended && !video.seeking && !video.error && Number.isFinite(video.duration) &&
      video.duration > 0 && video.currentTime >= video.duration - Math.min(1, video.duration * 0.05);
  }

  function onEnded(video, reason) {
    if (!checkRoute()) return;
    const candidates = videos();
    if (!video.isConnected || candidates.length !== 1 || candidates[0] !== video || !endedNormally(video)) return;
    if (phase !== 'idle') { requestTick(); return; }
    const lesson = readLesson();
    const record = mediaRecord(video);
    const from = record.lesson;
    if (!from || !mediaMatchesLesson(video, from) || record.source !== sourceOf(video) ||
        (!sameLesson(lesson, from) && !sameLesson(lesson, from.next))) {
      stopAuto('播放器与课程目录无法对应，联播已停止。请确认当前课程后重新开启。', 'lesson_media_mismatch');
      return;
    }
    operation = {
      generation, from, next: from.next, video, source: sourceOf(video), serial: record.serial,
      notBefore: Date.now() + END_DELAY_MS, timeoutAt: Date.now() + END_DELAY_MS + TRANSITION_TIMEOUT_MS,
      candidate: null, graceUsed: false,
    };
    phase = 'settling';
    setStatus('本讲播放结束，稍候核对平台完成记录…');
    log('lesson_ended', { reason, from: lessonInfo(from), next: from.next, media: mediaInfo(video) });
    requestTick();
  }

  function directoryMatches(lesson, op) {
    if (!lesson || lesson.count !== op.from.count) return false;
    const from = lesson.directory[op.from.index];
    const next = op.next && lesson.directory[op.next.index];
    return sameLesson(from, op.from) && (!op.next || sameLesson(next, op.next));
  }

  function mediaIdentity(video) {
    return { video, source: sourceOf(video), serial: mediaRecord(video).serial };
  }

  function sameMedia(a, b) {
    return Boolean(a && b && a.video === b.video && a.source === b.source && a.serial === b.serial);
  }

  function completeTransition(op, video) {
    if (!currentOperation(op)) return;
    const lesson = readLesson();
    if (!sameLesson(lesson, op.next) || !mediaMatchesLesson(video, lesson) || !associate(video)) return;
    operation = null;
    phase = 'idle';
    setStatus(video.ended ? '下一讲已播放结束，正在处理联播…' : '正在播放：' + lesson.title);
    log(video.ended ? 'next_already_ended' : 'play_started', { lesson: lessonInfo(lesson), media: mediaInfo(video) });
    requestTick();
  }

  function playbackFailure(error) {
    const name = typeof error?.name === 'string' ? error.name : 'UnknownError';
    // Do not export error.message: browser/player errors may contain signed media URLs.
    const message = name === 'NotAllowedError'
      ? '浏览器未允许自动播放。请手动播放后重新开启联播。'
      : name === 'NotSupportedError'
        ? '下一讲的媒体资源或格式无法播放，联播已停止。'
        : name === 'AbortError'
          ? '播放请求被播放器中断，联播已停止。请检查页面后重新开启。'
          : '下一讲播放失败，联播已停止。可导出日志查看错误类型。';
    stopAuto(message, 'play_rejected', { errorName: name });
  }

  function startPlayback(op, video, identity) {
    if (!currentOperation(op)) return;
    const lesson = readLesson();
    if (!sameLesson(lesson, op.next) || !mediaMatchesLesson(video, lesson)) return;
    op.target = identity;
    op.playDeadline = Date.now() + PLAY_TIMEOUT_MS;
    op.playResolved = false;
    op.startTime = video.currentTime;
    phase = 'starting';
    if (endedNormally(video)) { completeTransition(op, video); return; }
    if (!video.paused && video.readyState >= 2 &&
        (video.currentTime > 0.05 || mediaRecord(video).playingSerial === identity.serial)) {
      completeTransition(op, video);
      return;
    }
    setStatus('下一讲已加载，正在请求播放：' + op.next.title);
    log('play_requested', { lesson: op.next, media: mediaInfo(video) });
    try {
      const result = video.play();
      if (result && typeof result.then === 'function') {
        result.then(() => {
          if (!currentOperation(op)) return;
          op.playResolved = true;
          requestTick();
        }, (error) => {
          if (currentOperation(op)) playbackFailure(error);
        });
      }
    } catch (error) {
      if (currentOperation(op)) playbackFailure(error);
    }
  }

  function tick() {
    if (ticking || !checkRoute()) return;
    ticking = true;
    try {
      if (!sameSessionContext(sessionContext, catalogRuntime.getQueryContext(courseId))) {
        stopAuto('课程或登录上下文发生变化，完成核对已取消；请刷新后重新开启。', 'context_changed');
        return;
      }
      const candidates = videos();
      if (candidates.length > 1) {
        stopAuto('页面存在多个播放器，无法确定联播对象，已停止。', 'multiple_videos', { count: candidates.length });
        return;
      }
      const video = candidates[0] || null;
      const lesson = readLesson();
      render();
      if (phase === 'idle') {
        if (video && endedNormally(video)) onEnded(video, 'ended_state');
        return;
      }
      const op = operation;
      if (!op || !currentOperation(op)) return;
      const now = Date.now();
      if (lesson && (!directoryMatches(lesson, op) ||
          (!sameLesson(lesson, op.from) && !sameLesson(lesson, op.next)))) {
        stopAuto('课程目录发生了其他变化，联播已停止，避免误切课程。', 'unexpected_lesson');
        return;
      }

      if (phase === 'settling') {
        const atFrom = sameLesson(lesson, op.from);
        const mediaMoved = video && (video !== op.video || sourceOf(video) !== op.source ||
          mediaRecord(video).serial !== op.serial);
        if (atFrom && video === op.video && !mediaMoved && !endedNormally(video)) {
          stopAuto('检测到本讲重新播放，已取消切课并停止联播。', 'ended_media_changed');
          return;
        }
        if (now < op.notBefore) return;
        if (!lesson) {
          if (now >= op.timeoutAt) stopAuto('课程目录未能加载，联播已停止。', 'directory_timeout');
          return;
        }
        // SPA routing and DOM/player updates may arrive in either order. Once an
        // external transition starts, wait for the expected row instead of clicking again.
        if (atFrom && (mediaMoved || !video)) {
          if (now >= op.timeoutAt) {
            stopAuto('页面切换后目录未能对应下一讲，联播已停止。', 'external_transition_timeout');
          } else {
            setStatus('页面正在切换课程，等待目录和播放器…');
          }
          return;
        }
        if (!ensureCompletion(op, lesson)) return;
        if (!op.next) {
          stopAuto('已到课程目录最后一讲，联播已停止。', 'course_finished');
          return;
        }
        if (op.next.kind !== 'video' || op.next.hasSubItems) {
          stopAuto('下一项含非视频内容或子项目，请手动处理；联播已停止。', 'next_unsupported');
          return;
        }
        phase = 'loading';
        op.timeoutAt = now + TRANSITION_TIMEOUT_MS;
        if (sameLesson(lesson, op.next)) {
          setStatus('页面已进入下一讲，等待播放器就绪…');
          log('platform_advanced', { next: op.next });
        } else {
          const nextItem = lesson.items[op.next.index];
          if (nextItem.matches('.locked, .disabled, [aria-disabled="true"], [disabled]') ||
              nextItem.closest('[aria-disabled="true"]')) {
            stopAuto('下一讲当前不可选，联播已停止。', 'next_disabled');
            return;
          }
          setStatus('正在进入下一讲：' + op.next.title);
          log('next_clicked', { next: op.next });
          try { nextItem.click(); } catch (error) {
            stopAuto('无法打开下一讲，联播已停止。', 'click_failed', { errorName: error?.name || 'UnknownError' });
          }
        }
        return;
      }

      if (phase === 'loading') {
        const identity = video && mediaIdentity(video);
        // A seek/time reset alone does not prove that the next lesson's media has loaded.
        const changed = video && (video !== op.video || sourceOf(video) !== op.source || identity.serial !== op.serial);
        const ready = sameLesson(lesson, op.next) && changed && mediaMatchesLesson(video, lesson) && video.readyState >= 1 &&
          Number.isFinite(video.duration) && video.duration > 0 && !video.error;
        if (ready) {
          const candidate = op.candidate;
          if (!candidate || !sameMedia(candidate.identity, identity) || candidate.nodeId !== lesson.nodeId) {
            if (now >= op.timeoutAt && op.graceUsed) {
              stopAuto('下一讲播放器持续变化，等待超时，联播已停止。', 'unstable_media_timeout');
              return;
            }
            if (now >= op.timeoutAt) op.graceUsed = true;
            op.candidate = { identity, nodeId: lesson.nodeId, since: now };
            log('new_media_seen', { next: op.next, media: mediaInfo(video), late: now >= op.timeoutAt });
          } else if (now - candidate.since >= STABLE_MEDIA_MS) {
            startPlayback(op, video, identity);
          }
          // Give an already-ready candidate its stability check after a throttled timer.
          return;
        }
        op.candidate = null;
        if (now >= op.timeoutAt) {
          stopAuto('等待下一讲播放器加载超时，联播已停止。请检查页面或导出日志。', 'load_timeout', { media: mediaInfo(video) });
        }
        return;
      }

      if (phase === 'starting') {
        if (video && sameLesson(lesson, op.next) && mediaMatchesLesson(video, lesson) && sameMedia(mediaIdentity(video), op.target)) {
          if (endedNormally(video)) { completeTransition(op, video); return; }
          if (!video.paused && video.readyState >= 2 && (op.playResolved ||
              mediaRecord(video).playingSerial === op.target.serial || video.currentTime > op.startTime + 0.05)) {
            completeTransition(op, video);
            return;
          }
        } else if (video && lesson) {
          stopAuto('请求播放时播放器发生了变化，联播已停止。', 'play_media_changed');
          return;
        }
        if (now >= op.playDeadline) {
          stopAuto('下一讲未能开始播放，等待已超时。请手动播放后重新开启联播。', 'play_timeout', { media: mediaInfo(video) });
        }
      }
    } finally {
      ticking = false;
      if (timer) clearTimeout(timer);
      timer = enabled ? setTimeout(() => { timer = 0; tick(); }, phase === 'idle' ? IDLE_POLL_MS : POLL_MS) : 0;
    }
  }

  function requestTick() {
    if (!enabled || tickQueued) return;
    tickQueued = true;
    queueMicrotask(() => { tickQueued = false; tick(); });
  }

  function startAuto() {
    const currentRoute = route();
    const lesson = readLesson();
    const candidates = videos();
    if (!lesson) {
      setStatus(identityMessage(lastIdentityState.reason));
      log('start_identity_not_ready', { identity: { ...lastIdentityState }, catalog: catalogRuntime.summary(currentRoute.courseId) });
      render();
      return;
    }
    if (currentRoute.path !== STUDY_PATH || !currentRoute.courseId || candidates.length !== 1) {
      setStatus('请等课程目录和唯一的课程播放器加载后，再开启联播。');
      log('start_not_ready', { videoCount: candidates.length });
      return;
    }
    const context = catalogRuntime.getQueryContext(currentRoute.courseId);
    if (!context) {
      setStatus('尚未取得本站查询上下文，请完整刷新课程学习页后再开启。');
      log('start_progress_context_missing');
      return;
    }
    const video = candidates[0];
    if (!mediaMatchesLesson(video, lesson)) {
      setStatus('当前视频尚未与真实课节对应，请等待加载；仍不对应时请导出日志。');
      log('start_media_identity_unverified', { lesson: lessonInfo(lesson), media: mediaInfo(video) });
      return;
    }
    if (lesson.items[lesson.index].matches('.locked, .disabled, [aria-disabled="true"], [disabled]')) {
      setStatus('当前课节不可选，未开启联播。');
      log('start_lesson_disabled');
      return;
    }
    // The highlighted row may already refer to a new lesson while the previous
    // lesson's ended video is still on screen. Do not infer completion on enable.
    if (video.ended) {
      setStatus('当前视频已结束，请先手动进入下一讲并播放，再开启联播。');
      log('start_already_ended');
      return;
    }
    if (video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0) {
      setStatus('播放器还未加载完成，请正常播放后再开启联播。');
      log('start_media_not_ready', { media: mediaInfo(video) });
      return;
    }
    if (video.error || video.loop) {
      setStatus(video.loop ? '播放器正在循环播放，请先关闭循环再开启联播。' : '播放器当前报错，请恢复播放后再开启联播。');
      log('start_media_unavailable', { media: mediaInfo(video) });
      return;
    }
    enabled = true;
    sessionContext = context;
    lastCompletion = null;
    generation += 1;
    courseId = currentRoute.courseId;
    operation = null;
    phase = 'idle';
    associate(video);
    render();
    setStatus(video.paused && !video.ended
      ? '已开启：请正常播放当前视频，播放结束后进入下一讲。'
      : '已开启：当前视频播放结束后进入下一讲。');
    log('enabled', { lesson: lessonInfo(lesson), media: mediaInfo(video) });
    requestTick();
  }

  function report() {
    const candidates = videos();
    return {
      script: '南航金城学院课程自动联播（手动开启）', version: VERSION, exportedAt: new Date().toISOString(),
      enabled, phase, status: statusElement.textContent, route: route(),
      lesson: lessonInfo(readLesson()),
      completion: lastCompletion ? { ...lastCompletion } : null,
      identity: { ...lastIdentityState }, catalog: catalogRuntime.summary(route().courseId),
      mediaIdentityVerified: candidates.length === 1 && mediaMatchesLesson(candidates[0], readLesson()),
      videoCount: candidates.length,
      video: candidates.length === 1 ? mediaInfo(candidates[0]) : null,
      events: events.slice(),
    };
  }

  toggleButton.addEventListener('click', () => {
    if (enabled) stopAuto('已停止联播；当前视频不会被暂停。', 'manual_stop');
    else startAuto();
  });
  shadow.querySelector('.copy-log').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report(), null, 2));
      hintElement.textContent = '日志已复制，可在反馈问题时附上。分享前请检查课程编号和课节标题。';
    } catch (_error) {
      hintElement.textContent = '浏览器未允许复制，请使用“下载日志”。';
    }
  });
  shadow.querySelector('.download-log').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(report(), null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '南航金城课程联播日志-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    host.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    hintElement.textContent = '已请求下载日志；日志中不包含完整媒体地址或登录凭据。';
  });

  // Capture media events before the platform's usual target/bubbling handlers.
  // Delegation covers replaced/cloned videos without copying dataset markers.
  for (const type of ['loadstart', 'emptied', 'loadedmetadata', 'playing', 'ended', 'error', 'pause', 'waiting', 'stalled']) {
    document.addEventListener(type, (event) => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement) || !video.isConnected) return;
      renderCompletion();
      if (!checkRoute()) return;
      const record = mediaRecord(video);
      if (type === 'loadstart' || type === 'emptied' || type === 'loadedmetadata') {
        record.serial += 1;
        record.playingSerial = -1;
        record.lesson = null;
        if (type === 'loadedmetadata') associate(video);
      } else if (type === 'playing') {
        associate(video);
        record.playingSerial = record.serial;
      } else if (type === 'ended') {
        onEnded(video, 'ended_event');
        return;
      } else if (type === 'error' && videos().length === 1) {
        stopAuto('课程视频加载或播放报错，联播已停止。请检查网络和播放器。', 'media_error', { media: mediaInfo(video) });
        return;
      }
      if (['loadstart', 'loadedmetadata', 'playing', 'waiting', 'stalled', 'pause'].includes(type)) {
        log('media_' + type, { media: mediaInfo(video) });
      }
      requestTick();
    }, true);
  }

  document.addEventListener('click', (event) => {
    if (enabled && event.isTrusted && event.target instanceof Element && event.target.closest(ITEM_SELECTOR)) {
      stopAuto('检测到手动选择课程，联播已停止；需要时可重新开启。', 'manual_lesson_selection');
    }
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (enabled) log('visibility_changed');
    checkRoute();
    requestTick();
  });
  window.addEventListener('popstate', () => {
    if (enabled) stopAuto('检测到页面前进或后退，联播已停止；需要时可重新开启。', 'history_navigation');
    checkRoute();
  });
  window.addEventListener('pagehide', () => {
    if (enabled) stopAuto('页面已离开或进入缓存，联播已停止；返回后请手动开启。', 'page_hidden');
    catalogRuntime.dispose();
    progressReader.dispose();
  });
  window.addEventListener('pageshow', () => { checkRoute(); render(); });

  const observer = new MutationObserver(() => { checkRoute(); render(); requestTick(); });
  function mount() {
    if (!document.documentElement) return;
    if (!document.getElementById(HOST_ID)) document.documentElement.appendChild(host);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    render();
  }
  catalogRuntime.install();
  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
  log('initialized', { version: VERSION, mode: 'public', completionCheck: true });
})();
