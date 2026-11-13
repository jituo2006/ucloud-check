import test from 'node:test';
import assert from 'node:assert/strict';
import { monitoringDue } from '../cloudflare/schedule.mjs';
const at = time => Date.parse('2026-11-13T' + time + '+08:00');
const env = { ENABLED: 'true' };
test('daytime interval is 30 minutes in Beijing time; nights and disabled monitoring make no queries', () => {
  assert.equal(monitoringDue(env, at('06:59:00'), 0, 0), false);
  assert.equal(monitoringDue(env, at('07:00:00'), 0, 0), true);
  assert.equal(monitoringDue(env, at('07:29:00'), at('07:00:00'), 0), false);
  assert.equal(monitoringDue(env, at('07:30:00'), at('07:00:00'), 0), true);
  assert.equal(monitoringDue(env, at('23:00:00'), 0, 0), false);
  assert.equal(monitoringDue(env, at('20:59:00'), 0, 0), true);
  assert.equal(monitoringDue(env, at('21:00:00'), 0, 0), false);
  assert.equal(monitoringDue({ ENABLED: 'false' }, at('09:00:00'), 0, 0), false);
});
test('an imported timetable suppresses idle classroom scans outside class windows', () => {
  const plan = { ...env, SCHEDULE_ONLY: 'true', CLASS_WINDOWS: JSON.stringify([{ start: '2026-11-13T08:00:00+08:00', end: '2026-11-13T09:40:00+08:00' }]) };
  assert.equal(monitoringDue(plan, at('07:49:00'), 0, 0), false);
  assert.equal(monitoringDue(plan, at('07:50:00'), 0, 0), true);
  assert.equal(monitoringDue(plan, at('10:00:00'), 0, 0), false);
});
test('Cron second jitter does not skip the next dense minute or re-run the same minute', () => {
  assert.equal(monitoringDue(env, at('10:01:40'), at('10:00:42'), at('10:03:00')), true);
  assert.equal(monitoringDue(env, at('10:01:59'), at('10:01:40'), at('10:03:00')), false);
  assert.equal(monitoringDue(env, at('10:30:40'), at('10:00:42'), 0), true);
});
test('dated classes start dense monitoring ten minutes before class; an active classroom also stays dense', () => {
  const plan = { ...env, CLASS_WINDOWS: JSON.stringify([{ start: '2026-11-13T08:00:00+08:00', end: '2026-11-13T09:40:00+08:00' }]) };
  assert.equal(monitoringDue(plan, at('07:49:00'), at('07:48:00'), 0), false);
  assert.equal(monitoringDue(plan, at('07:50:00'), at('07:49:00'), 0), true);
  assert.equal(monitoringDue(plan, at('09:40:00'), at('09:39:00'), 0), false);
  assert.equal(monitoringDue(env, at('10:01:00'), at('10:00:00'), at('10:02:00')), true);
  assert.equal(monitoringDue(env, at('10:01:30'), at('10:01:00'), at('10:02:00')), false);
});
