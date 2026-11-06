'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPlatformProgressReader } = require('../src/platform-progress-reader.js');

const origin = 'https://nhjcxy.haiqikeji.com';
const context = Object.freeze({ courseId: 'COURSE_PRIVATE', schoolId: '22', userId: 'USER_PRIVATE' });

test('explicit response account, school or course contradictions cannot confirm another scope', async () => {
  for (const where of ['response', 'data', 'summary', 'record']) {
    for (const key of ['courseId', 'schoolId', 'userId', 'studentId']) {
      const payload = business();
      payload.data.summary = {};
      const at = where === 'response' ? payload : where === 'data' ? payload.data
        : where === 'summary' ? payload.data.summary : payload.data.nodeProgressList[0];
      at[key] = 'DIFFERENT_PRIVATE_SCOPE';
      const env = environment({ get: () => Promise.resolve(payload) });
      await rejects(env.reader.query(context), 'progress_context_mismatch');
      env.reader.dispose();
    }
  }
});
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function business() { return { code: 200, data: { nodeProgressList: [{ nodeId: 100, state: 1 }] } }; }
function environment(options = {}) {
  const calls = [], required = [], probes = [];
  const client = function unusedCallableClient() { throw new Error('Do not use the generic client'); };
  client.defaults = { baseURL: '/api' };
  client.get = function (...args) {
    calls.push({ thisValue: this, args });
    return options.get ? options.get(...args) : Promise.resolve(business());
  };
  const factory = function inspectedFactoryTestDouble() {};
  // A harmless source change must not block the configured client.
  factory.toString = () => { throw new Error('PRIVATE_SIGNATURE'); };
  const require = id => { required.push(id); return { A: options.client || client }; };
  require.m = { 51953: factory };
  const chunks = [];
  chunks.push = function (tuple) { probes.push(tuple); tuple[2](require); return probes.length; };
  const win = {
    URL, location: { origin }, TextEncoder,
    webpackChunktravel_web: chunks,
  };
  for (const key of ['localStorage', 'sessionStorage', 'cookie', 'fetch', 'XMLHttpRequest']) {
    Object.defineProperty(win, key, { get() { throw new Error('PRIVATE_CREDENTIALS ' + key); } });
  }
  Object.defineProperty(client.defaults, 'headers', { get() { throw new Error('PRIVATE_HEADERS'); } });
  const reader = createPlatformProgressReader({ window: win, origin });
  return { reader, win, require, factory, client, calls, required, probes };
}
async function rejects(promise, reason, retryable = false) {
  await assert.rejects(promise, error => {
    assert.equal(error.name, 'ProgressReadError');
    assert.equal(error.reason, reason);
    assert.equal(error.message, reason);
    assert.equal(error.retryable, retryable);
    assert.equal(JSON.stringify(error).includes('PRIVATE'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('reuses only the verified cached client and whitelists GET arguments', async () => {
  const value = business();
  const env = environment({ get: () => Promise.resolve(value) });
  const aborter = new AbortController();
  const input = Object.freeze({ ...context, signal: aborter.signal, token: 'PRIVATE_TOKEN', extraURL: 'PRIVATE_URL' });
  assert.equal(await env.reader.query(input), value);
  assert.deepEqual(env.required, [51953]);
  assert.equal(env.probes.length, 1);
  assert.equal(env.probes[0][0].length, 1);
  assert.match(env.probes[0][0][0], /^nhjcxy-progress-reader-/);
  assert.deepEqual(env.probes[0][1], {});
  assert.equal(env.calls.length, 1);
  const call = env.calls[0];
  assert.equal(call.thisValue, env.client);
  assert.equal(call.args[0], '/user/get_study_progress');
  assert.deepEqual(call.args[1], { params: context, timeout: 8000, signal: aborter.signal });
  assert.equal(input.token, 'PRIVATE_TOKEN');
});

test('concurrent queries share acquisition and retain only their own request contexts', async () => {
  const env = environment();
  const first = env.reader.query(context);
  const second = env.reader.query({ courseId: 200, schoolId: 22, userId: 300 });
  await nextTurn();
  assert.equal(env.required.length, 1);
  assert.equal(env.probes.length, 1);
  await Promise.all([first, second]);
  assert.deepEqual(env.required, [51953]);
  assert.deepEqual(env.calls.map(call => call.args[1].params), [context, { courseId: '200', schoolId: '22', userId: '300' }]);
});

test('missing runtime or factory does not invoke a client or make a request', async () => {
  for (const [reason, mutate] of [
    ['progress_runtime_unavailable', env => { env.win.webpackChunktravel_web = []; }],
    ['progress_factory_unavailable', env => { env.require.m = {}; }],
    ['progress_runtime_unavailable', env => { env.win.webpackChunktravel_web.push = () => {}; }],
  ]) {
    const env = environment(); mutate(env);
    await rejects(env.reader.query(context), reason);
    assert.equal(env.required.length, 0);
    assert.equal(env.calls.length, 0);
  }
});

test('client shape and base URL mismatch fail before an API call', async () => {
  for (const mutate of [
    client => { client.defaults.baseURL = 'https://other.example/api'; },
    client => { client.get = undefined; },
  ]) {
    const env = environment(); mutate(env.client);
    await rejects(env.reader.query(context), 'progress_client_unavailable');
    assert.equal(env.calls.length, 0);
  }
});

test('invalid origin and invalid IDs fail before probing any runtime', async () => {
  const env = environment();
  env.win.location.origin = 'https://other.example';
  await rejects(env.reader.query(context), 'progress_origin_mismatch');
  env.win.location.origin = origin;
  for (const patch of [{ courseId: '' }, { schoolId: ' 22' }, { userId: null }, { userId: Number.MAX_SAFE_INTEGER + 1 }]) {
    await rejects(env.reader.query({ ...context, ...patch }), 'progress_context_invalid');
  }
  assert.equal(env.probes.length, 0);
  assert.equal(env.calls.length, 0);
});

test('business data is accepted while raw Axios wrappers and malformed payloads are rejected', async () => {
  for (const value of [null, [], {}, { code: 200 }, { code: 200, data: [] }, { code: 200, data: {} }, { status: 200, data: business() }]) {
    const env = environment({ get: () => Promise.resolve(value) });
    await assert.rejects(env.reader.query(context), error => {
      assert.ok(['progress_response_invalid', 'progress_business_rejected'].includes(error.reason));
      assert.equal(error.retryable, false);
      return true;
    });
  }
});

test('business authentication and non-success results never request a retry', async () => {
  for (const code of [401, '401', 403, 500, '200']) {
    const env = environment({ get: () => Promise.resolve({ code, msg: 'PRIVATE_MESSAGE', data: { token: 'PRIVATE_TOKEN' } }) });
    await rejects(env.reader.query(context), code === 401 || code === '401' ? 'progress_auth_required' : 'progress_business_rejected');
    assert.equal(env.calls.length, 1);
  }
});

test('only the three known network failure codes are marked retryable and no raw error escapes', async () => {
  for (const code of ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_BAD_REQUEST', 'UNKNOWN_PRIVATE_CODE']) {
    const original = Object.assign(new Error('PRIVATE_URL?auth_key=PRIVATE_TOKEN'), { code, config: { headers: { Authorization: 'PRIVATE_TOKEN' } } });
    const env = environment({ get: () => Promise.reject(original) });
    await rejects(env.reader.query(context), ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT'].includes(code) ? 'progress_network_failed' : 'progress_request_failed', ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT'].includes(code));
  }
  const env = environment({ get: () => Promise.reject({ code: 'ERR_NETWORK', response: { status: 401 }, message: 'PRIVATE_AUTH' }) });
  await rejects(env.reader.query(context), 'progress_auth_required');
});

test('a native cancellation is sanitized without a retry', async () => {
  const env = environment({ get: () => Promise.reject({ name: 'CanceledError', code: 'ERR_CANCELED', message: 'PRIVATE_URL' }) });
  await rejects(env.reader.query(context), 'progress_aborted');
});

test('a pre-aborted signal never probes or requests and a bad listener cannot leak a request', async () => {
  const env = environment();
  const aborter = new AbortController(); aborter.abort('PRIVATE_REASON');
  await rejects(env.reader.query({ ...context, signal: aborter.signal }), 'progress_aborted');
  const brokenSignal = { aborted: false, addEventListener() { throw new Error('PRIVATE_SIGNAL'); } };
  await rejects(env.reader.query({ ...context, signal: brokenSignal }), 'progress_request_failed');
  await nextTurn();
  assert.equal(env.probes.length, 0);
  assert.equal(env.calls.length, 0);
});

test('aborting an in-flight request rejects immediately and ignores its late success', async () => {
  const result = deferred();
  const env = environment({ get: () => result.promise });
  const aborter = new AbortController();
  const attempt = env.reader.query({ ...context, signal: aborter.signal });
  await nextTurn(); assert.equal(env.calls.length, 1);
  aborter.abort('PRIVATE_REASON'); await rejects(attempt, 'progress_aborted');
  result.resolve(business()); await nextTurn();
  assert.equal(env.calls.length, 1);
});

test('dispose during runtime capture prevents client access afterward', async () => {
  const env = environment();
  const push = env.win.webpackChunktravel_web.push;
  env.win.webpackChunktravel_web.push = function (tuple) {
    push.call(this, tuple);
    env.reader.dispose();
  };
  await rejects(env.reader.query(context), 'progress_disposed');
  assert.equal(env.required.length, 0);
  assert.equal(env.calls.length, 0);
});

test('dispose ignores a late failed request without an unhandled rejection', async () => {
  const result = deferred();
  const env = environment({ get: () => result.promise });
  const attempt = env.reader.query(context);
  await nextTurn(); env.reader.dispose();
  await rejects(attempt, 'progress_disposed');
  result.reject(new Error('PRIVATE_LATE_URL')); await nextTurn();
  assert.equal(env.calls.length, 1);
});

test('configured client works without crypto support', async () => {
 const env=environment(); env.win.crypto={}; await env.reader.query(context); assert.equal(env.calls.length,1);
});
