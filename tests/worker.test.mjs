import test from 'node:test';
import assert from 'node:assert/strict';

let store = {}, calls = [], queue = [], mode = 'normal';
globalThis.chrome = {
  storage: { local: {
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(store[key])])),
    set: async items => { Object.assign(store, structuredClone(items)); },
  }, onChanged: { addListener() {} } },
  alarms: { get: async () => ({}), create() {}, clear: async () => true, onAlarm: { addListener() {} } },
  runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  const input = options?.body ? JSON.parse(options.body) : undefined;
  calls.push({ url, path, input });
  if (url.startsWith('https://relay.example')) {
    if (path === '/api/commands/claim') { const commands = queue; queue = []; return Response.json({ commands }); }
    return Response.json({ ok: true });
  }
  let data;
  if (path === '/ykt-basics/info') data = { id: '9' };
  else if (path === '/ykt-site/site/list/student/current') data = { records: [{ id: '10', siteName: '测试课堂' }] };
  else if (path === '/blade-chat/web/chat/myCourse') data = [{ siteId: '10', groupId: '20' }];
  else if (path === '/ykt-site/attendancebasicinfo/basic') data = { attendanceBasicInfo: {
    id: mode === 'changed' ? '31' : '30', siteId: '10', attendanceBasicStatus: 1,
    attendanceStartTime: new Date(Date.now() - 60000).toISOString(), attendanceEndTime: new Date(Date.now() + 180000).toISOString(),
  }, person: { signed: mode === 'signed' ? 1 : 0 } };
  else if (path === '/ykt-site/common/v2/clock') {
    data = { data: 'offline-clock' };
    if (mode === 'token-change') store.token = 'different-offline-fixture';
    if (mode === 'disabled-in-flight') store.monitorConfig.enabled = false;
  }
  else if (path === '/ykt-site/attendancedetailinfo/sign') {
    if (mode === 'timeout') throw new Error('simulated timeout after submit');
    if (mode === 'rejected') return Response.json({ code: 400, data: null });
    data = {};
  } else throw new Error('unexpected request: ' + path);
  return Response.json({ code: 200, data });
};
const { run } = await import('../public/background.js');
function reset() {
  store = { token: 'offline-fixture-token', monitorConfig: { enabled: true, relayUrl: 'https://relay.example', relayKey: 'k'.repeat(40), openStatuses: ['1'], unsignedPath: 'person.signed', unsignedValues: ['0'] }, monitorSeen: { userId: '9', accountBinding: 'test-account-binding-01', initialized: true, classroom: [], attendance: [] } };
  calls = []; queue = []; mode = 'normal';
}
const command = () => ({ id: 'cmd-fixture', accountBinding: 'test-account-binding-01', siteId: '10', groupId: '20', attendanceId: '30', expiresAt: Date.now() + 120000 });
const submissions = () => calls.filter(call => call.path === '/ykt-site/attendancedetailinfo/sign');

test('disabled worker makes no requests; monitoring and unconfirmed commands never submit', async () => {
  reset(); store.monitorConfig.enabled = false;
  await run('classroom-monitor'); assert.equal(calls.length, 0);
  store.monitorConfig.enabled = true;
  await run('classroom-monitor'); await run('confirmation-commands');
  assert.equal(submissions().length, 0);
  assert.equal(calls.filter(c => c.path === '/api/events').length, 2);
  await run('classroom-monitor');
  assert.equal(calls.filter(c => c.path === '/api/events').length, 2);
});
test('uncalibrated attendance cannot create a confirmation or submit', async () => {
  reset(); store.monitorConfig.openStatuses = [];
  await run('classroom-monitor');
  assert.equal(calls.filter(c => c.path === '/api/events' && c.input.kind === 'attendance').length, 0);
  queue = [command()]; await run('confirmation-commands'); assert.equal(submissions().length, 0);
});
test('only matching, unexpired, explicitly confirmed activity submits exactly once', async () => {
  reset(); queue = [command()]; await run('confirmation-commands');
  assert.equal(submissions().length, 1);
  assert.equal(store.monitorAttempts['cmd-fixture'].outcome, 'accepted');
  queue = [command()]; await run('confirmation-commands'); assert.equal(submissions().length, 1);
});
test('expired, changed, or account-mismatched confirmations cannot submit', async () => {
  for (const scenario of ['expired', 'changed', 'account', 'signed', 'unknown-person-state', 'binding', 'token-change', 'disabled-in-flight']) {
    reset(); const item = command();
    if (scenario === 'expired') item.expiresAt = Date.now() - 1;
    if (scenario === 'changed') mode = 'changed';
    if (scenario === 'account') store.monitorSeen.userId = '8';
    if (scenario === 'signed') mode = 'signed';
    if (scenario === 'unknown-person-state') store.monitorConfig.unsignedPath = '';
    if (scenario === 'binding') item.accountBinding = 'different-account-binding';
    if (['token-change', 'disabled-in-flight'].includes(scenario)) mode = scenario;
    queue = [item]; await run('confirmation-commands');
    assert.equal(submissions().length, 0, scenario);
  }
});
test('timeout and HTTP-200 business rejection never become success or automatic retry', async () => {
  for (const scenario of ['timeout', 'rejected']) {
    reset(); mode = scenario; queue = [command()]; await run('confirmation-commands');
    assert.equal(store.monitorAttempts['cmd-fixture'].outcome, 'unknown');
    queue = [command()]; await run('confirmation-commands'); assert.equal(submissions().length, 1);
  }
});
test('restart with a durable in-flight attempt reports unknown, without resubmitting', async () => {
  reset(); store.monitorAttempts = { 'cmd-fixture': { createdAt: Date.now(), outcome: null, reported: false } };
  queue = [command()]; await run('confirmation-commands');
  assert.equal(submissions().length, 0);
  assert.equal(calls.find(c => c.path === '/api/results').input.outcome, 'unknown');
});
