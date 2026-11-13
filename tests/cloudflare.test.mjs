import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../cloudflare/worker.mjs';

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const DB = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    const build = values => ({
      bind: (...args) => build(args),
      first: async () => statement.get(...values) || null,
      all: async () => ({ results: statement.all(...values) }),
      run: async () => ({ meta: { changes: Number(statement.run(...values).changes) } }),
    });
    return build([]);
  } };
  let time = Date.parse('2026-11-06T12:00:00Z');
  let mode = 'normal';
  const calls = [], pushes = [], tasks = [];
  const env = { DB, ENABLED: 'true', ENABLE_SIGNING: 'true', PUBLIC_BASE_URL: 'https://cloud.example',
    OPEN_STATUSES: '1', UNSIGNED_PATH: 'person.signed', UNSIGNED_VALUES: '0',
    ADMIN_KEY: 'admin'.repeat(10), CONFIRM_SECRET: 'sign'.repeat(12), BARK_DEVICE_KEY: 'offline-key', UCLOUD_TOKEN: 'offline-token',
    SESSION_SECRET: 'encryption'.repeat(8),
    ASSETS: { fetch: async () => new Response('<html>fixture</html>') },
  };
  const app = createApplication({ now: () => time, request: async (url, options) => {
    // Match the Workers transport contract, which differs from Node's fetch.
    if (options.redirect === 'error') throw new TypeError('Unsupported redirect mode');
    assert.equal(options.redirect, 'manual', 'credentials must not follow redirects');
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/ykt-basics/oauth/token') {
      if (env.UCLOUD_CLIENT_ID === 'portal') assert.equal(options.headers.Authorization, 'Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ=');
      assert.equal(new URLSearchParams(options.body).get('grant_type'), 'refresh_token');
      if (mode === 'refresh-denied') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (mode === 'refresh-lost') throw new Error('lost refresh response');
      return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
    }
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://other.example' } });
    if (url === 'https://api.day.app/push') {
      if (mode === 'bark-down') throw new Error('simulated push failure');
      pushes.push(JSON.parse(options.body));
      return Response.json({ code: 200 });
    }
    if (mode === 'expired-auth') return new Response('{}', { status: 401 });
    if (path === '/blade-chat/web/chat/myCourse' && mode === 'no-class-object') return Response.json({ code: 200, success: true, msg: '没有正在上课的课程', data: {} });
    if (path === '/blade-chat/web/chat/myCourse' && mode === 'unknown-object') return Response.json({ code: 200, data: {} });
    if (['refresh-auth', 'refresh-denied', 'refresh-lost'].includes(mode) && options.headers['Blade-Auth'] !== 'rotated-access') return new Response('{}', { status: 401 });
    let data;
    if (path === '/ykt-basics/info') data = { id: mode === 'other-account' ? '8' : '9' };
    else if (path === '/ykt-site/site/list/student/current') data = { records: [{ id: '10', siteName: '模拟云端课堂' }] };
    else if (path === '/blade-chat/web/chat/myCourse') data = mode === 'no-class' ? [] : [{ siteId: '10', groupId: '20' }];
    else if (path === '/ykt-site/attendancebasicinfo/basic') data = { attendanceBasicInfo: {
      id: mode === 'new-round' ? '31' : '30', siteId: '10', attendanceBasicStatus: 1,
      attendanceStartTime: new Date(time - 60000).toISOString(), attendanceEndTime: new Date(time + 120000).toISOString(),
    }, person: { signed: mode === 'signed' ? 1 : 0 } };
    else if (path === '/ykt-site/common/v2/clock') data = { data: 'offline-clock' };
    else if (path === '/ykt-site/attendancedetailinfo/getUserAttendListBySiteIdAndUserId') {
      assert.equal(JSON.parse(options.body).userId, '9');
      const currentRecorded = mode === 'already-recorded' || calls.includes('/ykt-site/attendancedetailinfo/sign');
      data = { totalCount: 1, signCount: 1, timeAndStatusList: [{ attendanceId: currentRecorded ? '30' : '99', status: 11, time: '2026-11-06 20:00:00', name: 'private-name' }] };
    }
    else if (path === '/ykt-site/attendancedetailinfo/sign') {
      if (mode === 'sign-unauthorized') return new Response('{}', { status: 401 });
      if (mode === 'timeout') throw new Error('simulated timeout');
      if (mode === 'business-rejection') return Response.json({ code: 400 });
      data = {};
    } else throw new Error('Unexpected request');
    return Response.json({ code: 200, data });
  } });
  const ctx = { waitUntil(promise) { tasks.push(promise); } };
  const request = async (path, input, admin = false) => {
    const res = await app.fetch(new Request('https://cloud.example' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: 'Bearer ' + env.ADMIN_KEY } : {}) },
      body: JSON.stringify(input || {}),
    }), env, ctx);
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return { app, env, ctx, calls, pushes, request, sqlite,
    mode: value => { mode = value; }, advance: value => { time += value; },
    drain: async () => { while (tasks.length) await Promise.all(tasks.splice(0)); },
    token: () => new URL(pushes.find(push => push.url).url).hash.slice(1),
    submissions: () => calls.filter(path => path.endsWith('/attendancedetailinfo/sign')).length,
  };
}

test('cloud redirects are rejected for both Bark and platform requests', async t => {
  const f = fixture(t);
  f.mode('redirect');
  assert.equal((await f.request('/api/admin/test-bark', {}, true)).status, 502);
  await f.app.monitor(f.env);
  const status = (await f.request('/api/admin/status', {}, true)).body.status;
  assert.equal(status.ok, false);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.submissions(), 0);
  assert.deepEqual(f.calls, ['/push', '/ykt-basics/info']);
});
test('cloud monitoring, Bark link, explicit phone confirmation, and submission work without Chrome', async t => {
  const f = fixture(t);
  await f.app.monitor(f.env);
  assert.equal(f.pushes.length, 1);
  const token = f.token();
  assert.equal(f.submissions(), 0);
  assert.equal((await f.request('/api/confirmation/view', { token })).body.executionHost, 'cloud');
  assert.equal(f.submissions(), 0);
  await Promise.all([f.request('/api/confirmation/confirm', { token }), f.request('/api/confirmation/confirm', { token })]);
  await f.drain();
  assert.equal(f.submissions(), 1);
  const result = await f.request('/api/confirmation/view', { token });
  assert.equal(result.body.outcome, 'accepted');
  assert.equal(result.headers.get('Referrer-Policy'), 'no-referrer');
  await f.app.monitor(f.env);
  assert.equal(f.submissions(), 1);
  assert.equal(f.pushes.length, 2);
});
test('cloud expiry, account changes, completed attendance and changed rounds fail closed', async t => {
  for (const mode of ['expired', 'other-account', 'signed', 'new-round']) {
    const f = fixture(t);
    await f.app.monitor(f.env);
    const token = f.token();
    if (mode === 'expired') f.advance(120001); else f.mode(mode);
    const res = await f.request('/api/confirmation/confirm', { token });
    await f.drain();
    assert.equal(f.submissions(), 0, mode);
    if (mode === 'expired') assert.equal(res.status, 410);
  }
});
test('cloud concurrent scheduled invocations deduplicate notifications', async t => {
  const f = fixture(t);
  await Promise.all([f.app.monitor(f.env), f.app.monitor(f.env)]);
  assert.equal(f.pushes.length, 1);
});
test('cloud disabled or uncalibrated modes cannot create a signing action', async t => {
  const f = fixture(t);
  f.env.ENABLED = 'false'; await f.app.monitor(f.env); assert.equal(f.calls.length, 0);
  f.env.ENABLED = 'true'; f.env.UNSIGNED_PATH = '';
  await f.app.monitor(f.env); assert.equal(f.pushes.length, 0); assert.equal(f.submissions(), 0);
});
test('cloud unknown submission outcome is not retried by repeated confirmations or scheduled ticks', async t => {
  for (const mode of ['timeout', 'business-rejection']) {
    const f = fixture(t);
    await f.app.monitor(f.env); f.mode(mode);
    const token = f.token();
    await f.request('/api/confirmation/confirm', { token }); await f.drain();
    assert.equal((await f.request('/api/confirmation/view', { token })).body.outcome, 'unknown');
    await f.request('/api/confirmation/confirm', { token }); await f.drain();
    await f.app.monitor(f.env);
    assert.equal(f.submissions(), 1);
  }
});
test('cloud classroom transition sends one new-class reminder with signing disabled', async t => {
  const f = fixture(t); f.env.ENABLE_SIGNING = 'false'; f.mode('no-class');
  await f.app.monitor(f.env); assert.equal(f.pushes.length, 0);
  f.mode('normal'); await f.app.monitor(f.env); await f.app.monitor(f.env);
  assert.equal(f.pushes.length, 1);
  assert.match(f.pushes[0].title, /课堂已开启/);
  assert.equal(f.submissions(), 0);
});
test('cloud dead processing is marked unknown instead of reissued', async t => {
  const f = fixture(t);
  await f.app.monitor(f.env);
  f.sqlite.exec("UPDATE events SET status='processing',claimed_at=0");
  const token = f.token();
  const res = await f.request('/api/confirmation/view', { token });
  assert.equal(res.body.outcome, 'unknown');
  await f.app.monitor(f.env); assert.equal(f.submissions(), 0);
});
test('cloud administration is authenticated and Bark testing never calls the platform', async t => {
  const f = fixture(t);
  assert.equal((await f.request('/api/admin/test-bark')).status, 401);
  assert.equal((await f.request('/api/admin/test-bark', {}, true)).status, 200);
  assert.deepEqual(f.calls, ['/push']);
});
test('cloud expired login produces a bounded reminder, not a sign retry', async t => {
  const f = fixture(t); f.mode('expired-auth');
  await f.app.monitor(f.env); await f.app.monitor(f.env);
  assert.equal(f.pushes.length, 1);
  assert.equal(f.submissions(), 0);
  assert.equal((await f.request('/api/admin/status', {}, true)).body.status.ok, false);
});
test('refresh rotates both tokens, persists encrypted state, and reuses it across invocations', async t => {
  const f = fixture(t); f.env.UCLOUD_REFRESH_TOKEN = 'seed-refresh'; f.mode('refresh-auth');
  await f.app.monitor(f.env);
  assert.equal((await f.request('/api/admin/status', {}, true)).body.status.ok, true);
  const stored = f.sqlite.prepare("SELECT value FROM state WHERE key='session'").get().value;
  for (const secret of ['rotated-access', 'rotated-refresh', 'seed-refresh']) assert.equal(stored.includes(secret), false);
  await f.app.monitor(f.env);
  assert.equal(f.calls.filter(p => p === '/ykt-basics/oauth/token').length, 1);
  // A newly configured seed explicitly replaces the old stored session.
  f.env.UCLOUD_REFRESH_TOKEN = 'new-seed';
  await f.app.monitor(f.env);
  assert.equal(f.calls.filter(p => p === '/ykt-basics/oauth/token').length, 2);
});
test('denied or unanswered refresh is blocked rather than replaying a possibly rotated token', async t => {
  for (const mode of ['refresh-denied', 'refresh-lost']) {
    const f = fixture(t); f.env.UCLOUD_REFRESH_TOKEN = 'seed-refresh'; f.mode(mode);
    await f.app.monitor(f.env); await f.app.monitor(f.env);
    assert.equal(f.calls.filter(p => p === '/ykt-basics/oauth/token').length, 1);
    assert.equal(f.submissions(), 0);
    assert.equal((await f.request('/api/admin/status', {}, true)).body.status.ok, false);
  }
});
test('a submission receiving 401 is never resubmitted after token refresh', async t => {
  const f = fixture(t); f.env.UCLOUD_REFRESH_TOKEN = 'seed-refresh';
  await f.app.monitor(f.env); const token = f.token(); f.mode('sign-unauthorized');
  await f.request('/api/confirmation/confirm', { token }); await f.drain();
  assert.equal(f.submissions(), 1);
  assert.equal(f.calls.includes('/ykt-basics/oauth/token'), false);
  assert.equal((await f.request('/api/confirmation/view', { token })).body.outcome, 'unknown');
});
test('scheduled invocations gate actual platform calls by daytime and idle interval', async t => {
  const f = fixture(t); f.mode('no-class');
  await f.app.monitor(f.env, { scheduled: true });
  const first = f.calls.length;
  assert.equal(first, 3);
  f.advance(29 * 60000); await f.app.monitor(f.env, { scheduled: true });
  assert.equal(f.calls.length, first);
  f.advance(60000); await f.app.monitor(f.env, { scheduled: true });
  assert.equal(f.calls.length, first * 2);
  f.advance(3 * 3600000); await f.app.monitor(f.env, { scheduled: true });
  assert.equal(f.calls.length, first * 2);
});
test('real no-class envelope is accepted while an unexplained empty object stays an error', async t => {
  const f = fixture(t); f.mode('no-class-object');
  await f.app.monitor(f.env);
  let status = (await f.request('/api/admin/status', {}, true)).body.status;
  assert.equal(status.ok, true); assert.equal(status.activeClasses, 0);
  f.mode('unknown-object'); await f.app.monitor(f.env);
  status = (await f.request('/api/admin/status', {}, true)).body.status;
  assert.equal(status.ok, false);
});
test('manual session renewal is authenticated and verifies the identity after rotation', async t => {
  const f = fixture(t); f.env.UCLOUD_REFRESH_TOKEN = 'seed-refresh';
  assert.equal((await f.request('/api/admin/refresh-session')).status, 401);
  const r = await f.request('/api/admin/refresh-session', {}, true);
  assert.equal(r.status, 200); assert.equal(r.body.identityMatches, true);
  assert.deepEqual(f.calls, ['/ykt-basics/info', '/ykt-basics/oauth/token', '/ykt-basics/info']);
  assert.equal(f.submissions(), 0);
});
test('portal login refresh uses the portal client instead of the default sword client', async t => {
  const f = fixture(t); f.env.UCLOUD_REFRESH_TOKEN = 'seed-refresh'; f.env.UCLOUD_CLIENT_ID = 'portal';
  assert.equal((await f.request('/api/admin/refresh-session', {}, true)).status, 200);
});
test('timetable import is authenticated, binds the current user, and off-class ticks only maintain identity', async t => {
  const f = fixture(t); f.mode('no-class');
  const input = { term: '2026-2027-1', windows: [{ title: '示例课', start: '2026-11-07T08:00:00+08:00', end: '2026-11-07T09:35:00+08:00' }] };
  assert.equal((await f.request('/api/admin/timetable', input)).status, 401);
  assert.equal((await f.request('/api/admin/timetable', input, true)).status, 200);
  const count = f.calls.length;
  await f.app.monitor(f.env, { scheduled: true });
  assert.deepEqual(f.calls.slice(count), ['/ykt-basics/info']);
  await f.app.monitor(f.env, { scheduled: true });
  assert.equal(f.calls.length, count + 1);
  assert.equal((await f.request('/api/admin/status', {}, true)).body.timetable.count, 1);
  f.advance(3 * 3600000); await f.app.monitor(f.env, { scheduled: true });
  assert.equal(f.calls.length, count + 1);
});
test('plugin-compatible read-only sampling queries basic attendance without creating a signing event', async t => {
  const f = fixture(t); f.env.ENABLE_SIGNING = 'false'; f.env.ENABLE_ATTENDANCE_PROBE = 'true';
  await f.app.monitor(f.env);
  assert.equal(f.calls.filter(p => p === '/ykt-site/attendancebasicinfo/basic').length, 1);
  assert.equal(f.calls.includes('/ykt-site/common/v2/clock'), false);
  assert.equal(f.submissions(), 0);
  assert.equal(f.pushes.length, 0);
  const status = (await f.request('/api/admin/status', {}, true)).body;
  assert.equal(status.attendanceProbeEnabled, true);
  assert.equal(status.attendanceSamples[0].basic.id, '30');
  assert.equal(status.attendanceSamples[0].signals['person.signed'], 0);
});
test('attendance monitoring can notify with submission disabled and shares the read-only probe request', async t => {
  const f = fixture(t); f.env.ENABLE_SIGNING = 'false'; f.env.ENABLE_ATTENDANCE_MONITOR = 'true'; f.env.ENABLE_ATTENDANCE_PROBE = 'true';
  await f.app.monitor(f.env);
  assert.equal(f.calls.filter(p => p === '/ykt-site/attendancebasicinfo/basic').length, 1);
  assert.equal(f.pushes.length, 1);
  const token = f.token();
  assert.equal((await f.request('/api/confirmation/view', { token })).body.submissionEnabled, false);
  assert.equal((await f.request('/api/confirmation/confirm', { token })).status, 409);
  await f.drain(); assert.equal(f.submissions(), 0);
});
test('attendance record inspection reads only the current user and owned courses', async t => {
  const f = fixture(t);
  assert.equal((await f.request('/api/admin/attendance-records')).status, 401);
  assert.equal((await f.request('/api/admin/attendance-records', { siteId: '11' }, true)).status, 403);
  const result = await f.request('/api/admin/attendance-records', { siteId: '10' }, true);
  assert.equal(result.status, 200); assert.equal(result.body.records[0].status, 11);
  assert.equal(JSON.stringify(result).includes('private-name'), false);
  assert.equal(f.submissions(), 0);
});
test('explicit automatic mode uses the original plugin protocol and submits once without phone confirmation', async t => {
  const f = fixture(t); Object.assign(f.env, { AUTO_SIGN: 'true', SIGNING_PROTOCOL: 'plugin', ENABLE_ATTENDANCE_MONITOR: 'true', OPEN_STATUSES: '', UNSIGNED_PATH: '', UNSIGNED_VALUES: '' });
  await f.app.monitor(f.env); assert.equal(f.submissions(), 1);
  assert.equal(f.pushes.some(p => p.url), false);
  await f.app.monitor(f.env); assert.equal(f.submissions(), 1);
  assert.equal(f.sqlite.prepare("SELECT outcome FROM events WHERE kind='attendance'").get().outcome, 'verified');
});
test('automatic mode cannot submit when submission is disabled and uncertain writes are never repeated', async t => {
  const f = fixture(t); Object.assign(f.env, { AUTO_SIGN: 'true', SIGNING_PROTOCOL: 'plugin', ENABLE_ATTENDANCE_MONITOR: 'true', ENABLE_SIGNING: 'false' });
  await f.app.monitor(f.env); assert.equal(f.submissions(), 0);
  f.env.ENABLE_SIGNING = 'true'; f.mode('timeout');
  await f.app.monitor(f.env); await f.app.monitor(f.env);
  assert.equal(f.submissions(), 1);
  assert.equal(f.sqlite.prepare("SELECT outcome FROM events WHERE kind='attendance'").get().outcome, 'unknown');
});
test('Bark transport failure does not prevent an explicitly authorized automatic attempt or duplicate it', async t => {
  const f = fixture(t); Object.assign(f.env, { AUTO_SIGN: 'true', SIGNING_PROTOCOL: 'plugin', ENABLE_ATTENDANCE_MONITOR: 'true' });
  f.mode('bark-down'); await f.app.monitor(f.env); await f.app.monitor(f.env);
  assert.equal(f.submissions(), 1);
});
test('automatic mode skips an already recorded current activity', async t => {
  const f = fixture(t); Object.assign(f.env, { AUTO_SIGN: 'true', SIGNING_PROTOCOL: 'plugin', ENABLE_ATTENDANCE_MONITOR: 'true' });
  f.mode('already-recorded'); await f.app.monitor(f.env);
  assert.equal(f.submissions(), 0);
  assert.equal(f.sqlite.prepare("SELECT outcome FROM events WHERE kind='attendance'").get().outcome, 'already_signed');
});
