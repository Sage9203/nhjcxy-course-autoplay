'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createCatalogContextRuntime = require('../src/catalog-context-runtime.js');
function fixture() {
  class XHR extends EventTarget {
    open(method, url) { this.responseURL = new URL(url, 'https://nhjcxy.haiqikeji.com').href; }
    send() {}
    reply() {
      this.status = 200; this.responseType = 'json';
      this.response = { code: 200, data: [{ id: 1, name: '章', children: [{ id: 100, name: '节', tabVideo: 1, localFile: 'https://media.example/video?secret=SOURCE' }] }] };
      this.dispatchEvent(new Event('load'));
    }
  }
  const changes = [];
  const runtime = createCatalogContextRuntime({ window: { XMLHttpRequest: XHR, URL }, origin: 'https://nhjcxy.haiqikeji.com', onChange: value => changes.push(value) });
  runtime.install();
  const request = (params = 'courseId=course-A&schoolId=school-A&studentId=PRIVATE_USER') => {
    const xhr = new XHR(); xhr.open('GET', '/api/user/yee_node_select?' + params); xhr.send(); return xhr;
  };
  return { runtime, changes, request };
}
test('successful catalog privately supplies progress scope without exposing account query values', () => {
  const b = fixture(); const xhr = b.request();
  assert.equal(b.runtime.getQueryContext('course-A'), null);
  xhr.reply();
  assert.deepEqual(b.runtime.getQueryContext('course-A'), { courseId: 'course-A', schoolId: 'school-A', userId: 'PRIVATE_USER', contextVersion: 1, catalogRevision: 2 });
  const publicView = JSON.stringify({ summary: b.runtime.summary('course-A'), catalog: b.runtime.getCatalog('course-A'), changes: b.changes });
  for (const secret of ['PRIVATE_USER', 'school-A', 'secret=SOURCE']) assert.equal(publicView.includes(secret), false);
  assert.equal(b.runtime.summary('course-A').contextReady, true);
  b.runtime.dispose(); assert.equal(b.runtime.getQueryContext('course-A'), null);
});
test('every new catalog request invalidates and versions even the same private scope', () => {
  const b = fixture(); b.request().reply(); const before = b.runtime.getQueryContext('course-A');
  const next = b.request(); assert.equal(b.runtime.getQueryContext('course-A'), null);
  next.reply(); assert.equal(b.runtime.getQueryContext('course-A').contextVersion, before.contextVersion + 1);
  b.runtime.dispose();
});
test('changed account scope cannot reuse an older successful catalog response', () => {
  const b = fixture(); const old = b.request();
  const next = b.request('courseId=course-A&schoolId=school-B&studentId=OTHER_USER');
  old.reply(); assert.equal(b.runtime.getQueryContext('course-A'), null);
  next.reply(); assert.equal(b.runtime.getQueryContext('course-A').userId, 'OTHER_USER');
  b.runtime.dispose();
});
test('missing or ambiguous context parameters cannot use the previous context', () => {
  for (const params of [
    'courseId=course-A&schoolId=school-A',
    'courseId=course-A&schoolId=school-A&studentId=U&studentId=U',
    'courseId=course-A&schoolId=S&schoolId=S&studentId=U',
    'courseId=course-A&courseId=course-B&schoolId=S&studentId=U',
  ]) {
    const b = fixture(); b.request().reply(); const xhr = b.request(params);
    assert.equal(b.runtime.getQueryContext('course-A'), null); xhr.reply();
    assert.equal(b.runtime.getQueryContext('course-A'), null); b.runtime.dispose();
  }
});
test('redirecting response context fails instead of accepting same-course other-account data', () => {
  const b = fixture(); const xhr = b.request();
  xhr.responseURL = xhr.responseURL.replace('PRIVATE_USER', 'OTHER_USER'); xhr.reply();
  assert.equal(b.runtime.getCatalog('course-A'), null); assert.equal(b.runtime.getQueryContext('course-A'), null);
  b.runtime.dispose();
});
