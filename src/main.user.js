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
/* @include catalog-identity */
  })();
  const createCatalogRuntime = (function () {
/* @include catalog-context-runtime */
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
/* @include platform-progress-reader */
})();
  const { evaluateNodeCompletion, createCompletionGate } = (function () {
/* @include completion-gate */
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
