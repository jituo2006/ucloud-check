import test from 'node:test';
import assert from 'node:assert/strict';
import { activeAttendance, confirmedUnsigned, eventKey, id, relayOrigin, unwrap } from '../public/monitor/core.js';

const course = { siteId: '10', groupId: '20' };
const now = Date.parse('2026-11-06T09:00:00Z');
const basic = { attendanceBasicInfo: { id: '30', siteId: '10', attendanceBasicStatus: 1,
  attendanceStartTime: '2026-11-06 16:59:00', attendanceEndTime: '2026-11-06 17:03:00' } };

test('requires calibrated status and a valid, current, matching attendance window', () => {
  assert.throws(() => activeAttendance(basic, course, [], now), /校准/);
  assert.equal(activeAttendance(basic, course, ['2'], now), null);
  assert.equal(activeAttendance(basic, course, ['1'], now).attendanceId, '30');
  assert.equal(activeAttendance(basic, course, ['1'], now + 180000), null);
  assert.equal(activeAttendance(basic, course, ['1'], now - 120000), null);
  assert.throws(() => activeAttendance({ attendanceBasicInfo: { ...basic.attendanceBasicInfo, siteId: '11' } }, course, ['1'], now), /不一致/);
  assert.throws(() => activeAttendance({ attendanceBasicInfo: { ...basic.attendanceBasicInfo, attendanceEndTime: '' } }, course, ['1'], now), /有效期/);
});
test('preserves long identifiers; separates attendance rounds; rejects false business success', () => {
  assert.equal(id('1823312437742391339'), '1823312437742391339');
  assert.throws(() => id(Number('1823312437742391339')), /精度/);
  assert.notEqual(eventKey({ ...course, kind: 'attendance', attendanceId: '30' }), eventKey({ ...course, kind: 'attendance', attendanceId: '31' }));
  assert.throws(() => unwrap({ code: 400, data: 'not accepted' }), /未确认/);
});
test('personal attendance state must be present and explicitly calibrated', () => {
  assert.equal(confirmedUnsigned({ person: { signed: 0 } }, 'person.signed', ['0']), true);
  assert.equal(confirmedUnsigned({ person: { signed: 1 } }, 'person.signed', ['0']), false);
  assert.equal(confirmedUnsigned({}, 'person.signed', ['0']), false);
  assert.equal(confirmedUnsigned({ person: { signed: null } }, 'person.signed', ['null']), false);
  assert.equal(confirmedUnsigned({}, '__proto__.signed', ['0']), false);
});
test('relay configuration accepts HTTPS or loopback only and no embedded credentials', () => {
  assert.equal(relayOrigin('https://relay.example'), 'https://relay.example');
  assert.equal(relayOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const url of ['http://relay.example', 'https://user:pass@relay.example', 'https://relay.example/secret', 'https://relay.example?token=x']) assert.throws(() => relayOrigin(url));
});
