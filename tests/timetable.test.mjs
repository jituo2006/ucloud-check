import test from 'node:test';
import assert from 'node:assert/strict';
import { expandTimetable } from '../cloudflare/timetable.mjs';
const base = { term: '2026-2027-1', firstMonday: '2026-08-31', periods: ['1 08:00-08:45', '2 08:50-09:35', '3 09:50-10:35'] };
test('semester import preserves discontinuous weeks, replacement sessions, and deduplicates repeated grid cells', () => {
  const regular = { weekday: 2, title: '示例课', rule: '3-11,13-18(周)[01-02节]' };
  const replacement = { weekday: 3, title: '示例课', rule: '12(周)[03节]' };
  const p = expandTimetable({ ...base, rules: [regular, regular, replacement] });
  assert.equal(p.windows.length, 16);
  assert.equal(p.windows.filter(w => w.week === 12).length, 1);
  assert.equal(p.windows.find(w => w.week === 12).start, '2026-11-18T09:50:00+08:00');
  assert.equal(p.windows.find(w => w.week === 11).start, '2026-11-10T08:00:00+08:00');
  assert.equal(p.windows.find(w => w.week === 11).end, '2026-11-10T09:35:00+08:00');
});
test('sections separated by an unscheduled block produce separate monitoring windows', () => {
  const p = expandTimetable({ ...base, rules: [{ weekday: 1, title: '示例课', rule: '1(周)[01-03节]' }] });
  assert.equal(p.windows.length, 2);
  assert.equal(p.windows[0].end, '2026-08-31T08:45:00+08:00');
});
test('unknown week syntax and missing period times fail rather than silently omitting classes', () => {
  for (const rule of ['1-18(单周)[01节]', '3-1(周)[01节]', '0(周)[01节]', '1(周)[14节]']) {
    assert.throws(() => expandTimetable({ ...base, rules: [{ weekday: 1, title: '示例课', rule }] }));
  }
});
