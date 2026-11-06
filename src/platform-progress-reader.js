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

module.exports = { createPlatformProgressReader };
