import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../relay/server.mjs';

async function fixture(t, options = {}) {
  let time = 1800000000000;
  const pushes = [];
  const server = createRelay({ key: 'k'.repeat(40), signingKey: 's'.repeat(40), publicUrl: 'https://relay.example',
    push: async payload => { pushes.push(payload); }, now: () => time, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, data = {}, auth = true) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(auth ? { Authorization: 'Bearer ' + 'k'.repeat(40) } : {}) }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const event = { kind: 'attendance', title: '测试课程', accountBinding: 'test-account-binding-01', siteId: '10', groupId: '20', attendanceId: '30', expiresAt: time + 120000 };
  return { server, origin, request, pushes, event, advance: value => { time += value; } };
}

test('opening or previewing a notification never confirms; explicit confirmation is delivered once', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/events', f.event, false)).status, 401);
  await f.request('/api/events', f.event);
  await f.request('/api/events', f.event);
  assert.equal(f.pushes.length, 1);
  const token = new URL(f.pushes[0].url).hash.slice(1);
  assert.equal((await fetch(f.origin + '/confirm')).status, 200);
  assert.equal((await f.request('/api/confirmation/view', { token }, false)).body.status, 'pending');
  assert.deepEqual((await f.request('/api/commands/claim')).body.commands, []);
  assert.equal((await f.request('/api/confirmation/confirm', { token: token + 'x' }, false)).status, 403);
  await f.request('/api/confirmation/confirm', { token }, false);
  await f.request('/api/confirmation/confirm', { token }, false);
  const command = (await f.request('/api/commands/claim')).body.commands[0];
  assert.equal(command.attendanceId, '30');
  assert.deepEqual((await f.request('/api/commands/claim')).body.commands, []);
  assert.equal((await f.request('/api/results', { commandId: command.id, outcome: 'accepted' })).status, 200);
  await f.request('/api/results', { commandId: command.id, outcome: 'accepted' });
  assert.equal(f.pushes.length, 2);
  assert.equal((await f.request('/api/confirmation/view', { token }, false)).body.outcome, 'accepted');
});

test('expired confirmations cannot be submitted; multiple rounds have independent identities', async t => {
  const f = await fixture(t);
  await f.request('/api/events', f.event);
  const token = new URL(f.pushes[0].url).hash.slice(1);
  f.advance(120001);
  assert.equal((await f.request('/api/confirmation/confirm', { token }, false)).status, 410);
  assert.deepEqual((await f.request('/api/commands/claim')).body.commands, []);
  await f.request('/api/events', { ...f.event, attendanceId: '31', expiresAt: f.event.expiresAt + 120000 });
  assert.equal(f.pushes.length, 2);
});

test('claimed delivery survives restart without being reissued', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ucloud-relay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'state.json');
  const f = await fixture(t, { stateFile });
  await f.request('/api/events', f.event);
  const token = new URL(f.pushes[0].url).hash.slice(1);
  await f.request('/api/confirmation/confirm', { token }, false);
  await f.request('/api/commands/claim');
  const other = await fixture(t, { stateFile });
  assert.deepEqual((await other.request('/api/commands/claim')).body.commands, []);
  other.advance(180000);
  assert.equal((await other.request('/api/confirmation/view', { token }, false)).body.status, 'uncertain');
});

test('Bark failure can retry notification without duplicating the event', async t => {
  let failures = 1;
  const pushes = [];
  const f = await fixture(t, { push: async payload => { if (failures--) throw new Error('simulated outage'); pushes.push(payload); } });
  assert.equal((await f.request('/api/events', f.event)).status, 502);
  assert.equal((await f.request('/api/events', f.event)).status, 200);
  assert.equal(pushes.length, 1);
});
