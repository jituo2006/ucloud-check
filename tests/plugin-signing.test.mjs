import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginActivity, matchingRecord } from '../cloudflare/plugin-signing.mjs';
const now = Date.parse('2026-11-13T15:40:00+08:00');
const course = { siteId: '10', groupId: '20' };
test('original plugin positive-ID protocol works without invented state fields and respects known boundaries', () => {
  const active = pluginActivity({ attendanceBasicInfo: { id: '30' } }, course, now);
  assert.equal(active.attendanceId, '30'); assert.equal(active.expiresAt, now + 300000);
  assert.equal(pluginActivity({ attendanceBasicInfo: { id: '0' } }, course, now), null);
  assert.equal(pluginActivity({}, course, now), null);
  assert.equal(pluginActivity({ attendanceBasicInfo: { id: '30', attendanceEndTime: '2026-11-13 15:39:59' } }, course, now), null);
  assert.equal(pluginActivity({ attendanceBasicInfo: { id: '30', attendanceStartTime: '2026-11-13 15:41:00' } }, course, now), null);
  assert.throws(() => pluginActivity({ attendanceBasicInfo: { id: '30', siteId: '11' } }, course, now));
  assert.throws(() => pluginActivity({ attendanceBasicInfo: { id: '30', classLessonId: '21' } }, course, now));
});
test('record verification requires exact activity ID or exact start time, rejecting unrelated and ambiguous records', () => {
  const activity = { attendanceId: '30', startedAt: now };
  assert.equal(matchingRecord({ timeAndStatusList: [{ attendanceId: '31', time: '2026-11-13 15:40:00', status: 11 }] }, activity), null);
  assert.equal(matchingRecord({ timeAndStatusList: [{ time: '2026-11-13 15:40:01', status: 11 }] }, activity), null);
  assert.equal(matchingRecord({ timeAndStatusList: [{ time: '2026-11-13 15:40:00', status: 11 }] }, activity).status, 11);
  assert.equal(matchingRecord({ timeAndStatusList: [{ attendanceId: '30' }, { attendanceId: '30' }] }, activity), null);
});
