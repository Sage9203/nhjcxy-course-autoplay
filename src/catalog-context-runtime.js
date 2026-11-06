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

module.exports = createCatalogContextRuntime;
