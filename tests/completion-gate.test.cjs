'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateNodeCompletion, createCompletionGate } = require('../src/completion-gate.js');

const clone = value => JSON.parse(JSON.stringify(value));
function fixtures() {
  const directory = [0, 1, 2].map(index => ({
    courseId: 'course-A', nodeId: String(100 + index), title: `第${index + 1}节`, chapterId: '10',
    chapterTitle: '第一章', kind: 'video', hasSubItems: false,
  }));
  const progress = { code: 200, data: { summary: { totalNodes: 3 }, nodeProgressList: directory.map(entry => ({
    nodeId: Number(entry.nodeId), nodeName: entry.title, chapterName: entry.chapterTitle,
    statusText: '未开始', state: 0, progressPercent: 0, progressRatio: '0.00', completeTime: null,
  })) } };
  const input = { courseId: 'course-A', expectedLesson: { ...directory[0] }, directory, progress };
  return { input, directory, progress, records: progress.data.nodeProgressList };
}
function complete(record, changes = {}) {
  Object.assign(record, { statusText: '已完成', state: 1, progressPercent: 100,
    progressRatio: '1.00', completeTime: '2026-10-29 22:42:17' }, changes);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let n = 0; n < 8; n += 1) await Promise.resolve(); };
function environment(options = {}) {
  let time = 0;
  let serial = 0;
  let current = true;
  const timers = new Map();
  const queries = [];
  const changes = [];
  const schedule = (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: time + delay }); return id; };
  const unschedule = id => timers.delete(id);
  const gate = createCompletionGate({
    query: signal => { const response = deferred(); queries.push({ signal, ...response }); return response.promise; },
    evaluate: value => value,
    isCurrent: () => current, onChange: value => changes.push(value), now: () => time,
    setTimeout: schedule, clearTimeout: unschedule, AbortController,
    deadlineAt: 60000, retryMs: 5000, requestTimeoutMs: 8000,
    ...options,
  });
  const api = {
    gate, queries, changes, timers,
    setCurrent(value) { current = value; },
    setTime(value) { time = value; },
    get time() { return time; },
    async advance(ms) {
      const until = time + ms;
      for (;;) {
        const next = [...timers].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { time = until; await flush(); return; }
        timers.delete(next[0]); time = next[1].at; next[1].callback(); await flush();
      }
    },
    async jump(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time && timers.delete(id)) timer.callback();
      await flush();
    },
  };
  return api;
}

test('completion uses frozen ended node ID, never a different completed or active node', () => {
  const { input, records } = fixtures();
  complete(records[1]); input.directory[1].active = true;
  assert.equal(evaluateNodeCompletion(input).status, 'unconfirmed');
  complete(records[0]);
  assert.deepEqual(evaluateNodeCompletion(input), { status: 'complete', reason: 'observed_complete_combination' });
});

test('only the observed complete combination passes; 100 alone and partial/conflicting states stay unconfirmed', () => {
  for (const fields of [
    { progressPercent: 100 }, { state: 1 }, { statusText: '学习中', state: 2, progressPercent: 100 },
    { statusText: '已完成', state: 1, progressPercent: 100, progressRatio: '0.99' },
    { statusText: '已完成', state: 1, progressPercent: 100, progressRatio: 1 },
    { statusText: '已完成', state: 1, progressPercent: 100, progressRatio: '1e0' },
  ]) {
    const { input, records } = fixtures(); Object.assign(records[0], fields);
    assert.equal(evaluateNodeCompletion(input).status, 'unconfirmed');
  }
});

test('completion date format/calendar is checked while previously completed rewatches remain valid', () => {
  for (const date of [null, '', '2026-02-29 01:02:03', '2026-10-29T22:42:17Z', '2026-10-29 24:00:00']) {
    const { input, records } = fixtures(); complete(records[0], { completeTime: date });
    assert.equal(evaluateNodeCompletion(input).status, 'unconfirmed');
  }
  const { input, records } = fixtures(); complete(records[0], { completeTime: '2024-02-29 00:00:00' });
  assert.equal(evaluateNodeCompletion(input).status, 'complete');
});

test('explicit course conflicts in expected lesson, directory, response, data, summary or record are invalid', () => {
  for (const select of [f => f.input.expectedLesson, f => f.directory[0], f => f.progress,
    f => f.progress.data, f => f.progress.data.summary, f => f.records[0]]) {
    const f = fixtures(); complete(f.records[0]); select(f).courseId = 'course-B';
    assert.equal(evaluateNodeCompletion(f.input).status, 'invalid');
  }
});

test('missing or duplicate target IDs cannot confirm completion', () => {
  for (const modify of [
    rows => rows.shift(), rows => rows.push({ ...rows[0] }), rows => { rows[0].nodeId = 999; },
    rows => { rows[0].nodeId = null; }, rows => { rows[0].nodeId = Number.MAX_SAFE_INTEGER + 1; },
  ]) {
    const f = fixtures(); complete(f.records[0]); modify(f.records);
    assert.equal(evaluateNodeCompletion(f.input).status, 'invalid');
  }
});

test('target title and chapter must match regardless of list order', () => {
  const f = fixtures(); complete(f.records[0]); f.records.reverse();
  assert.equal(evaluateNodeCompletion(f.input).status, 'complete');
  f.records.find(record => record.nodeId === 100).chapterName = '其他章';
  assert.equal(evaluateNodeCompletion(f.input).status, 'invalid');
});

test('changed ended-lesson metadata or unsupported content fails closed', () => {
  for (const modify of [
    f => { f.directory[0].title = '改名'; }, f => { f.directory[0].chapterId = '11'; },
    f => { f.directory[0].kind = 'exam'; }, f => { f.directory[0].hasSubItems = true; },
    f => { f.directory.push({ ...f.directory[0] }); },
    f => { f.input.expectedLesson.kind = 'exam'; f.directory[0].kind = 'exam'; },
  ]) {
    const f = fixtures(); complete(f.records[0]); modify(f);
    assert.equal(evaluateNodeCompletion(f.input).status, 'invalid');
  }
});

test('malformed or unsuccessful progress is invalid rather than inferred from summary count', () => {
  for (const response of [null, {}, { code: 401 }, { code: 200, data: null },
    { code: 200, data: { summary: { completionRate: 100 }, nodeProgressList: null } }]) {
    const { input } = fixtures(); input.progress = response;
    assert.equal(evaluateNodeCompletion(input).status, 'invalid');
  }
});

test('validator normalizes harmless title whitespace/NFC and never mutates or returns private payloads', () => {
  const { input, records } = fixtures(); complete(records[0]);
  records[0].nodeName = ' \n第1节\t';
  input.progress.token = 'PRIVATE_TOKEN'; input.progress.userId = 'PRIVATE_USER';
  records[0].localFile = 'https://media.example/clip.mp4?auth_key=PRIVATE_MEDIA';
  const original = clone(input); const result = evaluateNodeCompletion(input);
  assert.equal(result.status, 'complete'); assert.deepEqual(input, original);
  assert.equal(/PRIVATE|auth_key|media\.example/.test(JSON.stringify(result)), false);
});

test('gate performs no request before poll and prevents overlapping queries', () => {
  const e = environment(); assert.equal(e.queries.length, 0);
  for (let i = 0; i < 20; i += 1) e.gate.poll();
  assert.equal(e.queries.length, 1); assert.equal(e.gate.summary().attempts, 1);
  assert.equal(e.gate.summary().status, 'pending');
});

test('unconfirmed response waits for poll after retry delay, then confirmed response releases gate', async () => {
  const e = environment(); e.gate.poll(); e.queries[0].resolve({ status: 'unconfirmed' }); await flush();
  e.gate.poll(); assert.equal(e.queries.length, 1);
  await e.advance(4999); e.gate.poll(); assert.equal(e.queries.length, 1);
  await e.advance(1); e.gate.poll(); assert.equal(e.queries.length, 2);
  e.queries[1].resolve({ status: 'complete' }); await flush();
  assert.deepEqual(e.gate.summary(), { status: 'confirmed', attempts: 2, reason: 'completion_confirmed' });
  e.gate.poll(); assert.equal(e.queries.length, 2); assert.equal(e.timers.size, 0);
});

test('structural invalidity is terminal and cannot fall back to natural end', async () => {
  const e = environment(); e.gate.poll(); e.queries[0].resolve({ status: 'invalid' }); await flush();
  assert.equal(e.gate.summary().status, 'failed');
  await e.advance(60000); e.gate.poll(); assert.equal(e.queries.length, 1);
});

test('unknown completion combinations remain unconfirmed until retry attempts exhaust', async () => {
  const f = fixtures(); f.records[0].progressPercent = 100;
  const e = environment({ evaluate: value => evaluateNodeCompletion(value), maxAttempts: 2 });
  e.gate.poll(); e.queries[0].resolve(f.input); await flush();
  assert.equal(e.gate.summary().status, 'pending');
  await e.advance(5000); e.gate.poll(); e.queries[1].resolve(f.input); await flush();
  assert.deepEqual(e.gate.summary(), { status: 'failed', attempts: 2, reason: 'completion_attempts_exhausted' });
});

test('cancel aborts in-flight query and ignores both late success and late failure', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const e = environment(); e.gate.poll(); e.gate.cancel();
    assert.equal(e.queries[0].signal.aborted, true); assert.equal(e.timers.size, 0);
    e.queries[0][outcome](outcome === 'resolve' ? { status: 'complete' } : { retryable: true }); await flush();
    assert.deepEqual(e.gate.summary(), { status: 'cancelled', attempts: 1, reason: 'completion_cancelled' });
  }
});

test('stale operation response cannot approve a new session or retain timeout timers', async () => {
  const e = environment(); e.gate.poll(); e.setCurrent(false);
  e.queries[0].resolve({ status: 'complete' }); await flush();
  assert.equal(e.gate.summary().status, 'cancelled'); assert.equal(e.queries[0].signal.aborted, true);
  assert.equal(e.timers.size, 0); e.setCurrent(true); e.gate.poll(); assert.equal(e.queries.length, 1);
});

test('request timeout aborts and permits bounded serial retry while late old response stays inert', async () => {
  const e = environment(); e.gate.poll(); await e.advance(8000);
  assert.equal(e.queries[0].signal.aborted, true); assert.equal(e.gate.summary().reason, 'completion_query_timeout');
  await e.advance(5000); e.gate.poll(); assert.equal(e.queries.length, 2);
  e.queries[0].resolve({ status: 'complete' }); await flush();
  assert.equal(e.gate.summary().status, 'pending');
  e.queries[1].resolve({ status: 'complete' }); await flush(); assert.equal(e.gate.summary().status, 'confirmed');
});

test('hard fixed deadline rejects a late success even if timeout callback was throttled', async () => {
  const e = environment(); e.gate.poll(); e.setTime(60000);
  e.queries[0].resolve({ status: 'complete' }); await flush();
  assert.deepEqual(e.gate.summary(), { status: 'failed', attempts: 1, reason: 'completion_deadline_exceeded' });
  assert.equal(e.queries[0].signal.aborted, true);
});

test('a background jump does not burst retries and fixed deadline prevents new requests', async () => {
  const e = environment(); e.gate.poll(); await e.jump(30000);
  for (let n = 0; n < 50; n += 1) e.gate.poll();
  assert.equal(e.queries.length, 1);
  await e.jump(30000); e.gate.poll();
  assert.equal(e.queries.length, 1); assert.equal(e.gate.summary().reason, 'completion_deadline_exceeded');
});

test('retryable failures retry, nonretryable/authentication failures stop and hide raw errors', async () => {
  const e = environment(); e.gate.poll();
  e.queries[0].reject({ retryable: true, message: 'PRIVATE_TOKEN' }); await flush();
  assert.equal(e.gate.summary().status, 'pending');
  await e.advance(5000); e.gate.poll();
  e.queries[1].reject({ status: 401, message: 'https://api.example/?userId=PRIVATE_USER' }); await flush();
  assert.equal(e.gate.summary().status, 'failed');
  assert.equal(/PRIVATE|userId|api\.example/.test(JSON.stringify(e.changes)), false);
});

test('synchronous query failure and thrown evaluator produce terminal safe summaries', async () => {
  const thrown = new Error('PRIVATE_MESSAGE');
  const a = environment({ query() { throw thrown; } }); a.gate.poll();
  assert.equal(a.gate.summary().reason, 'completion_query_failed');
  const b = environment({ evaluate() { throw thrown; } }); b.gate.poll();
  b.queries[0].resolve('PRIVATE_RESPONSE'); await flush();
  assert.equal(b.gate.summary().reason, 'completion_evaluation_failed');
  assert.equal(JSON.stringify([...a.changes, ...b.changes]).includes('PRIVATE'), false);
  const c = environment({ evaluate() { return { get status() { throw thrown; } }; } });
  c.gate.poll(); c.queries[0].resolve('PRIVATE_RESPONSE'); await flush();
  assert.equal(c.gate.summary().reason, 'completion_evaluation_failed');
});

test('throwing onChange cannot affect gate, and reentrant cancellation prevents query start', async () => {
  const e = environment({ onChange() { throw new Error('UI failed'); } });
  e.gate.poll(); e.queries[0].resolve({ status: 'complete' }); await flush();
  assert.equal(e.gate.summary().status, 'confirmed');
  let gate, calls = 0;
  gate = createCompletionGate({ query() { calls += 1; }, evaluate: value => value,
    onChange() { gate.cancel(); }, now: () => 0, deadlineAt: 60000 });
  gate.poll(); assert.equal(calls, 0); assert.equal(gate.summary().status, 'cancelled');
});

test('a lost operation before first poll makes zero requests', () => {
  const e = environment(); e.setCurrent(false); e.gate.poll();
  assert.equal(e.queries.length, 0); assert.equal(e.gate.summary().status, 'cancelled');
});

test('terminal gate summaries are frozen and contain only safe scalar fields', async () => {
  const e = environment(); e.gate.poll(); e.queries[0].resolve({ status: 'complete', token: 'PRIVATE_TOKEN' }); await flush();
  const report = e.gate.summary(); assert.equal(Object.isFrozen(report), true);
  assert.deepEqual(Object.keys(report), ['status', 'attempts', 'reason']);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
});

test('unrelated missing, renamed and additional records do not block the ended lesson', () => {
  const f = fixtures(); complete(f.records[0]);
  f.records.pop(); f.records[1].nodeName = 'Unrelated rename';
  f.records.push({nodeId:999,nodeName:'Extra'});
  assert.equal(evaluateNodeCompletion(f.input).status, 'complete');
});
