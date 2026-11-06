// Synthetic integration tests: no live account, network, media or progress writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, fixtureCatalog, fixtureProgress } = require('./helpers/completion-preview-browser.cjs');

async function enabledBrowser(options) {
  const b = browser(options); await b.flush(); await b.toggle();
  assert.equal(b.enabled, true, b.status);
  b.onItemClick = index => b.load(index);
  return b;
}

function assertNoWriteOrCredentialReads(b) {
  assert.equal(b.credentialTouches, 0);
  assert.deepEqual(b.extraRequests, []);
  for (const call of b.progressCalls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.path, '/user/get_study_progress');
    assert.equal(call.timeout, 8000);
    assert.equal(call.params.courseId, 'course-A');
    assert.equal(call.params.schoolId, '22');
    assert.equal(call.params.userId, 'PRIVATE_ACCOUNT');
  }
}

test('completion preview remains manual and performs no progress query before a natural end', async () => {
  const b = browser(); await b.flush(); await b.advance(10000);
  assert.equal(b.enabled, false); assert.deepEqual(b.progressCalls, []);
  await b.toggle(); await b.advance(10000);
  assert.equal(b.enabled, true); assert.deepEqual(b.progressCalls, []);
  assert.deepEqual(b.clicks, []); assertNoWriteOrCredentialReads(b);
});

test('a completed fresh progress response permits one next lesson after the end buffer', async () => {
  const b = await enabledBrowser(); const endedAt = b.now;
  await b.end(); await b.advance(3499);
  assert.deepEqual(b.progressCalls, []); assert.deepEqual(b.clicks, []);
  await b.advance(2001);
  assert.equal(b.progressCalls.length, 1);
  assert.ok(b.progressCalls[0].time >= endedAt + 3500);
  assert.deepEqual(b.clicks, [1]); assert.equal(b.video.playCalls, 1);
  assert.equal((await b.report()).lesson.nodeId, '101');
  assertNoWriteOrCredentialReads(b);
});

test('an incomplete response waits, then a subsequent complete response permits a single click', async () => {
  const b = await enabledBrowser();
  const incomplete = fixtureProgress(b.catalog, []), complete = fixtureProgress(b.catalog, [0]);
  b.setProgressBehavior((_call, index) => Promise.resolve(index === 0 ? incomplete : complete));
  await b.end(); await b.advance(4000);
  assert.equal(b.progressCalls.length, 1); assert.deepEqual(b.clicks, []); assert.equal(b.enabled, true);
  await b.advance(6500);
  assert.equal(b.progressCalls.length, 2); assert.deepEqual(b.clicks, [1]); assert.equal(b.video.playCalls, 1);
  assertNoWriteOrCredentialReads(b);
});

test('persistent incomplete state has a finite query budget and never navigates', async () => {
  const b = await enabledBrowser(); b.setCompletion([]);
  await b.end(); await b.advance(80000);
  assert.equal(b.enabled, false); assert.deepEqual(b.clicks, []); assert.equal(b.video.playCalls, 0);
  assert.ok(b.progressCalls.length >= 1 && b.progressCalls.length <= 6);
  const count = b.progressCalls.length; await b.advance(80000); assert.equal(b.progressCalls.length, count);
  assertNoWriteOrCredentialReads(b);
});

test('the ended actual node is checked even while URL nodeId remains stale across two switches', async () => {
  const b = await enabledBrowser(); await b.end(); await b.advance(6000);
  assert.deepEqual(b.clicks, [1]); assert.equal((await b.report()).route.nodeId, '100');
  // Node 100 is complete, but it must not satisfy the next node 101's gate.
  await b.end(); await b.advance(4000);
  assert.deepEqual(b.clicks, [1]); assert.equal(b.enabled, true);
  b.setCompletion([0, 1]); await b.advance(6500);
  assert.deepEqual(b.clicks, [1, 2]); assert.equal((await b.report()).lesson.nodeId, '102');
  assert.equal((await b.report()).route.nodeId, '100'); assertNoWriteOrCredentialReads(b);
});

test('stopping before query time prevents both querying and navigation', async () => {
  const b = await enabledBrowser(); await b.end(); await b.advance(1000); await b.toggle();
  await b.advance(80000);
  assert.equal(b.enabled, false); assert.deepEqual(b.progressCalls, []); assert.deepEqual(b.clicks, []);
});

test('stopping an in-flight query aborts its signal and ignores its late completion', async () => {
  const b = await enabledBrowser(); let resolve;
  b.setProgressBehavior(() => new Promise(done => { resolve = done; }));
  await b.end(); await b.advance(4000); assert.equal(b.progressCalls.length, 1);
  const signal = b.progressCalls[0].signal; await b.toggle();
  assert.equal(signal.aborted, true);
  resolve(fixtureProgress(b.catalog, [0])); await b.advance(80000);
  assert.equal(b.enabled, false); assert.deepEqual(b.clicks, []); assert.equal(b.video.playCalls, 0);
});

test('an old progress response cannot act on a newly started session', async () => {
  const b = await enabledBrowser(); let resolve;
  b.setProgressBehavior(() => new Promise(done => { resolve = done; }));
  await b.end(); await b.advance(4000); await b.toggle();
  b.video.ended = false; b.video.currentTime = 5; b.video.paused = false;
  await b.toggle(); assert.equal(b.enabled, true, b.status);
  resolve(fixtureProgress(b.catalog, [0])); await b.advance(10000);
  assert.equal(b.enabled, true); assert.deepEqual(b.clicks, []); assert.equal(b.video.playCalls, 0);
});

test('a trusted manual lesson selection cancels a pending progress operation', async () => {
  const b = await enabledBrowser(); let resolve;
  b.setProgressBehavior(() => new Promise(done => { resolve = done; }));
  await b.end(); await b.advance(4000);
  b.emit('click', b.items[2].titleElement, { isTrusted: true }); b.load(2, { playing: true });
  resolve(fixtureProgress(b.catalog, [0])); await b.advance(10000);
  assert.equal(b.enabled, false); assert.deepEqual(b.clicks, []);
});

test('route changes cancel the completion query before its response can navigate', async () => {
  const b = await enabledBrowser(); let resolve;
  b.setProgressBehavior(() => new Promise(done => { resolve = done; }));
  await b.end(); await b.advance(4000);
  b.location.href = 'https://nhjcxy.haiqikeji.com/student/course-study?id=course-B&nodeId=100'; b.mutate();
  resolve(fixtureProgress(b.catalog, [0])); await b.advance(10000);
  assert.equal(b.enabled, false); assert.deepEqual(b.clicks, []); assert.equal(b.video.playCalls, 0);
});

test('changing private account context invalidates a pending completion response', async () => {
  const b = await enabledBrowser(); let resolve;
  b.setProgressBehavior(() => new Promise(done => { resolve = done; }));
  await b.end(); await b.advance(4000);
  b.platformCatalog(b.catalog, { url: '/api/user/yee_node_select?courseId=course-A&schoolId=22&studentId=ANOTHER_ACCOUNT' });
  await b.flush(); resolve(fixtureProgress(b.catalog, [0])); await b.advance(10000);
  assert.equal(b.enabled, false); assert.deepEqual(b.clicks, []); assert.equal(b.video.playCalls, 0);
});

for (const before of [true, false]) test(`platform advancement ${before ? 'before' : 'after'} ended capture still checks from-node without N+2`, async () => {
  const b = await enabledBrowser();
  if (before) b.setActive(1);
  await b.end(); if (!before) b.setActive(1);
  b.load(1); await b.advance(6000);
  assert.deepEqual(b.clicks, []); assert.equal((await b.report()).lesson.nodeId, '101');
  assert.equal(b.progressCalls.length, 1); assert.equal(b.video.playCalls, 1);
});

test('authentication failure stops instead of falling back to delay-only navigation', async () => {
  const b = await enabledBrowser();
  b.setProgress({ code: 401, msg: 'SECRET_AUTH_TOKEN raw backend details', data: null });
  await b.end(); await b.advance(10000);
  assert.equal(b.enabled, false); assert.equal(b.progressCalls.length, 1);
  assert.deepEqual(b.clicks, []); assert.equal(b.video.playCalls, 0);
  assert.equal(JSON.stringify(await b.report()).includes('SECRET_AUTH_TOKEN'), false);
});

test('a progress client that never settles is stopped by the absolute gate deadline', async () => {
  const b = await enabledBrowser(); b.setProgressBehavior(() => new Promise(() => {}));
  await b.end(); await b.advance(80000);
  assert.equal(b.enabled, false); assert.deepEqual(b.clicks, []); assert.equal(b.video.playCalls, 0);
  // Each stalled request can be aborted at 8 seconds and retried, but only
  // sequentially and within the absolute completion budget.
  assert.ok(b.progressCalls.length >= 1 && b.progressCalls.length <= 6);
  for (let index = 0; index < b.progressCalls.length; index += 1) {
    assert.equal(b.progressCalls[index].signal.aborted, true);
    if (index) assert.ok(b.progressCalls[index].time >= b.progressCalls[index - 1].time + 8000);
  }
});

test('refreshing the same catalog context still invalidates an old in-flight completion response', async () => {
  const b = await enabledBrowser(); let resolve;
  b.setProgressBehavior(() => new Promise(done => { resolve = done; }));
  await b.end(); await b.advance(4000);
  b.platformCatalog(); await b.flush();
  assert.equal(b.enabled, false);
  resolve(fixtureProgress(b.catalog, [0])); await b.advance(10000);
  assert.deepEqual(b.clicks, []); assert.equal(b.video.playCalls, 0);
});

test('a throttled background timer beyond the completion deadline does not issue a burst of queries', async () => {
  const b = await enabledBrowser(); b.setCompletion([]);
  await b.end(); await b.jump(70000);
  assert.equal(b.enabled, false); assert.deepEqual(b.progressCalls, []); assert.deepEqual(b.clicks, []);
});

test('background timer throttling after one incomplete result does not query again past the deadline', async () => {
  const b = await enabledBrowser(); b.setCompletion([]);
  await b.end(); await b.advance(4000); assert.equal(b.progressCalls.length, 1);
  await b.jump(70000);
  assert.equal(b.enabled, false); assert.equal(b.progressCalls.length, 1); assert.deepEqual(b.clicks, []);
});

test('transient network failure retries within a fixed budget and never falls back to clicking', async () => {
  const b = await enabledBrowser();
  b.setProgressBehavior(() => Promise.reject(Object.assign(new Error('SECRET_BACKEND_SIGNED_URL'), { code: 'ERR_NETWORK', name: 'AxiosError' })));
  await b.end(); await b.advance(80000);
  assert.equal(b.enabled, false); assert.deepEqual(b.clicks, []); assert.equal(b.video.playCalls, 0);
  assert.ok(b.progressCalls.length >= 1 && b.progressCalls.length <= 6);
  assert.equal(JSON.stringify(await b.report()).includes('SECRET_BACKEND_SIGNED_URL'), false);
});

for (const bad of ['missing', 'duplicate', 'contradictory', 'unknown_state']) test(`${bad} progress record cannot be treated as completed`, async () => {
  const b = await enabledBrowser(); const progress = fixtureProgress(b.catalog, [0]);
  const records = progress.data.nodeProgressList;
  if (bad === 'missing') records.shift();
  if (bad === 'duplicate') records.push({ ...records[0] });
  if (bad === 'contradictory') records[0].progressRatio = '0.40';
  if (bad === 'unknown_state') { records[0].state = 2; records[0].statusText = '学习中'; }
  b.setProgress(progress); await b.end(); await b.advance(80000);
  assert.equal(b.enabled, false); assert.deepEqual(b.clicks, []); assert.equal(b.video.playCalls, 0);
  assert.ok(b.progressCalls.length >= 1 && b.progressCalls.length <= 6);
});

test('a changed module source with the same configured client can continue', async () => {
  const b = await enabledBrowser({badModuleHash:true});
  await b.end(); await b.advance(6000);
  assert.equal(b.enabled, true); assert.equal(b.progressCalls.length,1); assert.deepEqual(b.clicks,[1]);
});

test('missing user context cannot be guessed from historical IDs', async () => {
  const b = browser({ captureCatalog: false });
  b.platformCatalog(b.catalog, { url: '/api/user/yee_node_select?courseId=course-A&schoolId=22' });
  await b.flush(); await b.toggle(); await b.end(); await b.advance(80000);
  assert.equal(b.enabled, false); assert.deepEqual(b.progressCalls, []); assert.deepEqual(b.clicks, []);
});

test('completion diagnostics contain safe outcomes, not identities, backend messages or media URLs', async () => {
  const b = await enabledBrowser(); await b.end(); await b.advance(6000);
  const json = JSON.stringify(await b.report());
  for (const secret of ['PRIVATE_ACCOUNT', 'ANOTHER_ACCOUNT', 'SECRET_MEDIA', 'signature=', 'media.example']) {
    assert.equal(json.includes(secret), false, secret); assert.equal(b.warnings.join('\n').includes(secret), false, secret);
  }
  assertNoWriteOrCredentialReads(b);
});
