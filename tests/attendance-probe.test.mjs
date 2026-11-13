import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAttendance } from '../cloudflare/attendance-probe.mjs';
test('protocol probe retains candidate status/time fields while excluding identity, credentials, and rosters', () => {
  const result = summarizeAttendance({ attendanceBasicInfo: { id: '1234567890123456789', attendanceBasicStatus: 7,
    attendanceStartTime: '2026-11-13 15:40:00', attendanceEndTime: '2026-11-13 15:45:00', teacherName: 'private-teacher' },
  person: { signed: 0, realName: 'private-student', token: 'private-token', signState: '0', status: 'private-status' },
  students: [{ name: 'private-roster-name', status: 1 }] });
  assert.equal(result.basic.id, '1234567890123456789');
  assert.equal(result.signals['person.signed'], 0);
  assert.equal(result.signals['person.signState'], '0');
  const saved = JSON.stringify(result);
  for (const value of ['private-teacher', 'private-student', 'private-token', 'private-status', 'private-roster-name']) assert.equal(saved.includes(value), false);
  assert.equal(result.shape.some(item => item.path === 'students' && item.type === 'array'), true);
});
