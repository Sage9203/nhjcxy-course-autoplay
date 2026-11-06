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

module.exports = { evaluateNodeCompletion, createCompletionGate };
