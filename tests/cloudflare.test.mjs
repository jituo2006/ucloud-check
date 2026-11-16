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
  const calls = [], pushes = [], tasks = [], casPasswords = [];
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
    if (new URL(url).hostname === 'auth.bupt.edu.cn') {
      const form = '<form id="loginForm"><input name="execution" value="offline-state"><input name="_eventId" value="submit"></form>';
      if (options.method === 'POST') {
        const fields = new URLSearchParams(options.body);
        assert.equal(fields.get('username'), env.UCLOUD_CAS_USERNAME);
        assert.equal(fields.get('password'), env.UCLOUD_CAS_PASSWORD);
        casPasswords.push(time);
        if (mode === 'cas-rejected') return new Response(form);
        return new Response(null, { status: 302, headers: { Location: 'https://ucloud.bupt.edu.cn/?ticket=ST-offline-ticket-only', 'Set-Cookie': 'TGC=offline-sso-cookie; Path=/authserver; Secure; HttpOnly' } });
      }
      if (options.headers.Cookie?.includes('TGC=offline-sso-cookie')) return new Response(null, { status: 302, headers: { Location: 'https://ucloud.bupt.edu.cn/?ticket=ST-offline-ticket-only' } });
      return new Response(form);
    }
    if (path === '/ykt-basics/oauth/token') {
      if (env.UCLOUD_CLIENT_ID === 'portal') assert.equal(options.headers.Authorization, 'Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ=');
      if (new URLSearchParams(options.body).get('grant_type') === 'third') {
        if (mode === 'cas-exchange-down') return new Response('temporary unavailable', { status: 503 });
        return Response.json({ access_token: jwt({ user_id: '9', exp: Math.floor(time / 1000) + 7200 }), refresh_token: jwt({ exp: Math.floor(time / 1000) + 72000 }), expires_in: 7200 });
      }
      assert.equal(new URLSearchParams(options.body).get('grant_type'), 'refresh_token');
      if (env.AUTO_REAUTH === 'true') return Response.json({ access_token: jwt({ user_id: '9', exp: Math.floor(time / 1000) + 7200 }), refresh_token: new URLSearchParams(options.body).get('refresh_token'), expires_in: 7200 });
      if (mode === 'refresh-denied') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (mode === 'refresh-lost') throw new Error('lost refresh response');
      if (mode === 'fixed-refresh-deadline') {
        const exp = JSON.parse(Buffer.from(env.UCLOUD_REFRESH_TOKEN.split('.')[1], 'base64url')).exp;
        return Response.json({ access_token: 'rotated-access', refresh_token: 'e30.' + Buffer.from(JSON.stringify({ exp, jti: 'rotated' })).toString('base64url') + '.signature', expires_in: 3600 });
      }
      return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
    }
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://other.example' } });
    if (url === 'https://api.day.app/push') {
      if (mode === 'bark-down') throw new Error('simulated push failure');
      pushes.push(JSON.parse(options.body));
      return Response.json({ code: 200 });
    }
    if (mode === 'expired-auth') return new Response('{}', { status: 401 });
    if (mode === 'business-auth' && options.headers['Blade-Auth'] !== 'rotated-access') return Response.json({ code: 401, msg: 'private-server-echo' });
    if (path === '/blade-chat/web/chat/myCourse' && mode === 'query-network') throw new Error('private-server-echo');
    if (path === '/blade-chat/web/chat/myCourse' && mode === 'query-business') return Response.json({ code: 503, msg: 'private-server-echo' });
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
      if (mode === 'sign-business-auth') return Response.json({ code: 401, msg: 'private-server-echo' });
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
  return { app, env, ctx, calls, pushes, request, sqlite, casPasswords, now: () => time,
    mode: value => { mode = value; }, advance: value => { time += value; },
    drain: async () => { while (tasks.length) await Promise.all(tasks.splice(0)); },
    token: () => new URL(pushes.find(push => push.url).url).hash.slice(1),
    submissions: () => calls.filter(path => path.endsWith('/attendancedetailinfo/sign')).length,
  };
}
const jwt = claims => 'e30.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
function enableAutoReauth(f, refreshInMs = 3600000) {
  Object.assign(f.env, { AUTO_REAUTH: 'true', UCLOUD_CLIENT_ID: 'portal', SESSION_MAINTENANCE_24H: 'true',
    UCLOUD_CAS_USERNAME: 'offline-account', UCLOUD_CAS_PASSWORD: 'offline-password',
    UCLOUD_TOKEN: jwt({ user_id: '9', exp: Math.floor(f.now() / 1000) + 7200 }),
    UCLOUD_REFRESH_TOKEN: jwt({ exp: Math.floor((f.now() + refreshInMs) / 1000) }) });
  f.sqlite.prepare('INSERT INTO state(key,value) VALUES (?,?)').run('timetable', JSON.stringify({ userId: '9', term: '2026-2027-1', windows: [] }));
}

test('near-expiry maintenance obtains a fresh CAS session and encrypted SSO cookies, then renews across the next day without another password post', async t => {
  const f = fixture(t); enableAutoReauth(f);
  await f.app.monitor(f.env, { scheduled: true });
  let s = (await f.request('/api/admin/status', {}, true)).body;
  assert.equal(s.loginHealth.ok, true); assert.equal(s.sessionHealth.blocked, false);
  assert.equal(s.sessionHealth.refreshDeadlineExtended, true); assert.equal(f.casPasswords.length, 1);
  const first = s.sessionHealth.refreshExpiresAt;
  const stored = f.sqlite.prepare("SELECT value FROM state WHERE key='session'").get().value;
  for (const secret of ['offline-sso-cookie', f.env.UCLOUD_CAS_PASSWORD, 'ST-offline-ticket-only']) assert.equal(stored.includes(secret), false);
  // A normal half-hour access refresh must retain the encrypted SSO session.
  f.advance(30 * 60000); await f.app.monitor(f.env, { scheduled: true });
  f.advance(18 * 3600000); await f.app.monitor(f.env, { scheduled: true });
  s = (await f.request('/api/admin/status', {}, true)).body;
  assert.ok(s.sessionHealth.refreshExpiresAt > first);
  assert.equal(s.sessionHealth.reauthFailure, null); assert.equal(f.casPasswords.length, 1);
  assert.equal(f.submissions(), 0);
});
test('expired refresh recovers via normal login while rejected credentials preserve a usable session and stop password retries until changed', async t => {
  const expired = fixture(t); enableAutoReauth(expired, -1000);
  await expired.app.monitor(expired.env, { scheduled: true });
  assert.equal((await expired.request('/api/admin/status', {}, true)).body.loginHealth.ok, true);
  assert.equal(expired.casPasswords.length, 1);
  const f = fixture(t); enableAutoReauth(f); f.mode('cas-rejected');
  await f.app.monitor(f.env, { scheduled: true });
  let health = (await f.request('/api/admin/status', {}, true)).body.sessionHealth;
  assert.equal(health.blocked, false); assert.equal(health.reauthBlocked, true); assert.equal(health.reauthFailure, 'rejected');
  f.advance(30 * 60000); await f.app.monitor(f.env, { scheduled: true });
  assert.equal(f.casPasswords.length, 1);
  f.env.UCLOUD_CAS_PASSWORD = 'offline-corrected-password'; f.mode('normal');
  f.advance(30 * 60000); await f.app.monitor(f.env, { scheduled: true });
  health = (await f.request('/api/admin/status', {}, true)).body.sessionHealth;
  assert.equal(f.casPasswords.length, 2); assert.equal(health.reauthFailure, null); assert.equal(health.reauthBlocked, false);
});
test('authenticated re-login verifies identity and serializes concurrent password attempts without submitting attendance', async t => {
  const f = fixture(t); enableAutoReauth(f);
  assert.equal((await f.request('/api/admin/reauthenticate', {}, false)).status, 401);
  const results = await Promise.all([f.request('/api/admin/reauthenticate', {}, true), f.request('/api/admin/reauthenticate', {}, true)]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 401]);
  assert.equal(f.casPasswords.length, 1); assert.equal(f.submissions(), 0);
});
test('a temporary token exchange failure is not treated as a bad password and recovers on a later maintenance tick', async t => {
  const f = fixture(t); enableAutoReauth(f); f.mode('cas-exchange-down');
  await f.app.monitor(f.env, { scheduled: true });
  let h = (await f.request('/api/admin/status', {}, true)).body.sessionHealth;
  assert.equal(h.reauthBlocked, false); assert.equal(h.reauthFailure, 'exchange_unavailable');
  assert.equal(h.reauthFailureDetails.httpStatus, 503); assert.equal(h.reauthFailureDetails.stage, 'oauth_exchange');
  f.advance(10 * 60000); await f.app.monitor(f.env, { scheduled: true });
  assert.equal(f.casPasswords.length, 1);
  f.advance(20 * 60000); f.mode('normal'); await f.app.monitor(f.env, { scheduled: true });
  h = (await f.request('/api/admin/status', {}, true)).body.sessionHealth;
  assert.equal(h.reauthBlocked, false); assert.equal(h.reauthFailure, null); assert.equal(f.casPasswords.length, 2);
  assert.equal(f.submissions(), 0);
});
test('an expired refresh token does not discard a still valid access token while a temporary re-login failure waits for retry', async t => {
  const f = fixture(t); enableAutoReauth(f, -1000); f.mode('cas-exchange-down');
  await f.app.monitor(f.env, { scheduled: true });
  const s = (await f.request('/api/admin/status', {}, true)).body;
  assert.equal(s.loginHealth.ok, true); assert.equal(s.sessionHealth.refreshExpired, true);
  assert.equal(s.sessionHealth.blocked, false); assert.equal(s.sessionHealth.reauthBlocked, false);
  assert.ok(s.sessionHealth.accessExpiresAt > f.now()); assert.equal(f.submissions(), 0);
});
test('legacy exchange blocks are recoverable without replacing credentials or deleting encrypted state', async t => {
  const f = fixture(t); enableAutoReauth(f); f.mode('cas-exchange-down');
  await f.app.monitor(f.env, { scheduled: true });
  const wrapper = JSON.parse(f.sqlite.prepare("SELECT value FROM state WHERE key='session'").get().value);
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.env.SESSION_SECRET)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const additionalData = new TextEncoder().encode(wrapper.seed);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(wrapper.iv, 'base64'), additionalData }, key, Buffer.from(wrapper.data, 'base64'));
  const state = { ...JSON.parse(new TextDecoder().decode(plain)), reauthFailure: 'exchange', reauthBlocked: true };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, new TextEncoder().encode(JSON.stringify(state)));
  f.sqlite.prepare("UPDATE state SET value=? WHERE key='session'").run(JSON.stringify({ seed: wrapper.seed, iv: Buffer.from(iv).toString('base64'), data: Buffer.from(encrypted).toString('base64') }));
  f.advance(31 * 60000); f.mode('normal'); await f.app.monitor(f.env, { scheduled: true });
  const h = (await f.request('/api/admin/status', {}, true)).body.sessionHealth;
  assert.equal(h.reauthBlocked, false); assert.equal(h.reauthFailure, null); assert.equal(f.casPasswords.length, 2);
});

test('half-hour Cron arms class alarms even when authentication fails; planning never signs', async t => {
  const f = fixture(t);
  const plans = [];
  f.env.SESSION_MAINTENANCE_24H = 'true';
  f.env.CLASS_SCHEDULER = { getByName(name) { assert.equal(name, 'class-monitor'); return { fetch: async (url, options) => {
    plans.push({ url, method: options.method }); return Response.json({ nextAt: 123 });
  } }; } };
  f.app.scheduled({}, f.env, f.ctx); await f.drain();
  assert.equal(plans.length, 1);
  assert.equal(f.calls.filter(path => path !== '/push').length, 0);
  assert.equal((await f.request('/api/admin/scheduler-sync', {}, false)).status, 401);
  assert.equal((await f.request('/api/admin/scheduler-sync', {}, true)).body.scheduler.nextAt, 123);
  assert.equal(plans.length, 2);
  assert.equal(f.submissions(), 0);
});

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
test('HTTP-200 authentication failures refresh a read once, while a sign write is never replayed', async t => {
  const f = fixture(t); f.env.UCLOUD_REFRESH_TOKEN = 'seed-refresh'; f.mode('business-auth');
  await f.app.monitor(f.env);
  assert.equal((await f.request('/api/admin/status', {}, true)).body.status.ok, true);
  assert.equal(f.calls.filter(path => path === '/ykt-basics/oauth/token').length, 1);
  const token = f.token(); f.mode('sign-business-auth');
  await f.request('/api/confirmation/confirm', { token }); await f.drain();
  assert.equal(f.submissions(), 1);
  assert.equal(f.calls.filter(path => path === '/ykt-basics/oauth/token').length, 1);
  assert.equal((await f.request('/api/confirmation/view', { token })).body.outcome, 'unknown');
});
test('safe endpoint diagnostics survive recovery without retaining response bodies or raw exceptions', async t => {
  for (const [mode, details] of [
    ['query-network', { endpoint: '/blade-chat/web/chat/myCourse', reason: 'network' }],
    ['query-business', { endpoint: '/blade-chat/web/chat/myCourse', httpStatus: 200, businessCode: 503 }],
  ]) {
    const f = fixture(t); f.mode(mode); await f.app.monitor(f.env);
    let s = (await f.request('/api/admin/status', {}, true)).body;
    assert.equal(s.status.ok, false); assert.deepEqual(s.lastFailure.details, details);
    assert.equal(JSON.stringify(s).includes('private-server-echo'), false);
    f.advance(60000); f.mode('no-class'); await f.app.monitor(f.env);
    s = (await f.request('/api/admin/status', {}, true)).body;
    assert.equal(s.status.ok, true); assert.deepEqual(s.lastFailure.details, details);
    assert.equal(f.submissions(), 0);
  }
});
test('a transient login warning promises automatic recovery and a verified recovery is notified only once', async t => {
  const f = fixture(t); enableAutoReauth(f); f.mode('cas-exchange-down');
  // Neither token can support a query, so the first maintenance cycle must report failure.
  f.env.UCLOUD_TOKEN = jwt({ user_id: '9', exp: Math.floor(f.now() / 1000) - 1 });
  f.env.UCLOUD_REFRESH_TOKEN = jwt({ exp: Math.floor(f.now() / 1000) - 1 });
  await f.app.monitor(f.env, { scheduled: true });
  let s = (await f.request('/api/admin/status', {}, true)).body;
  assert.equal(s.loginHealth.ok, false); assert.equal(s.lastFailure.session.reauthFailure, 'exchange_unavailable');
  assert.equal(f.pushes.at(-1).title, '云邮登录暂未恢复');
  f.advance(31 * 60000); f.mode('no-class'); await f.app.monitor(f.env, { scheduled: true });
  s = (await f.request('/api/admin/status', {}, true)).body;
  assert.equal(s.loginHealth.ok, true); assert.equal(s.lastFailure.session.reauthFailure, 'exchange_unavailable');
  assert.equal(f.pushes.filter(push => push.title === '云邮登录已恢复').length, 1);
  await f.app.monitor(f.env);
  assert.equal(f.pushes.filter(push => push.title === '云邮登录已恢复').length, 1);
  assert.equal(f.submissions(), 0);
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
test('24-hour maintenance forces refresh every thirty minutes at night without classroom or signing requests', async t => {
  const f = fixture(t); f.env.UCLOUD_REFRESH_TOKEN = 'seed-refresh'; f.env.SESSION_MAINTENANCE_24H = 'true';
  f.advance(3 * 3600000);
  await f.app.monitor(f.env, { scheduled: true });
  assert.deepEqual(f.calls, ['/ykt-basics/oauth/token', '/ykt-basics/info']);
  f.advance(20 * 60000); await f.app.monitor(f.env, { scheduled: true });
  assert.equal(f.calls.length, 2);
  f.advance(10 * 60000); await f.app.monitor(f.env, { scheduled: true });
  assert.equal(f.calls.filter(p => p === '/ykt-basics/oauth/token').length, 2);
  assert.equal(f.submissions(), 0);
});
test('an expired refresh token is diagnosed locally and never sent repeatedly to the platform', async t => {
  const f = fixture(t); f.env.SESSION_MAINTENANCE_24H = 'true';
  f.env.UCLOUD_REFRESH_TOKEN = 'e30.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.signature';
  await f.app.monitor(f.env, { scheduled: true }); await f.app.monitor(f.env, { scheduled: true });
  assert.equal(f.calls.includes('/ykt-basics/oauth/token'), false);
  const health = (await f.request('/api/admin/status', {}, true)).body.sessionHealth;
  assert.equal(health.reason, 'refresh_expired'); assert.equal(health.refreshExpired, true);
  assert.equal(health.blocked, true);
});
test('refresh success with an unchanged refresh deadline is visible and warned once without claiming permanent login', async t => {
  const f = fixture(t); f.env.SESSION_MAINTENANCE_24H = 'true';
  const exp = Date.parse('2026-11-06T13:00:00Z') / 1000;
  f.env.UCLOUD_REFRESH_TOKEN = 'e30.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.signature';
  f.mode('fixed-refresh-deadline'); await f.app.monitor(f.env, { scheduled: true });
  const status = (await f.request('/api/admin/status', {}, true)).body;
  assert.equal(status.sessionHealth.refreshDeadlineExtended, false);
  assert.equal(status.sessionHealth.refreshExpiresAt, exp * 1000);
  assert.equal(status.sessionMaintenance24h, true);
  const warnings = () => f.pushes.filter(p => p.title === '云邮会话即将到期').length;
  assert.equal(warnings(), 1);
  f.advance(30 * 60000); await f.app.monitor(f.env, { scheduled: true });
  assert.equal(warnings(), 1);
});
