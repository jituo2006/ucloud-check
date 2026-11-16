import test from 'node:test';
import assert from 'node:assert/strict';
import { createClassScheduler } from '../cloudflare/class-scheduler.mjs';

const at = time => Date.parse(`2026-11-13T${time}+08:00`);
function fixture() {
  const state = new Map([['timetable', { windows: [{ start: '2026-11-13T08:00:00+08:00', end: '2026-11-13T09:40:00+08:00' }] }]]);
  let time = at('00:00:00'), alarm = null;
  const calls = [];
  const env = { ENABLED: 'true', DB: { prepare(sql) { if (sql.includes('MIN(CASE')) return { first: async () => ({ next_at: state.get('verification-next') ?? null }) }; return { bind(key, value) { return {
    first: async () => state.has(key) ? { value: JSON.stringify(state.get(key)) } : null,
    run: async () => { state.set(key, JSON.parse(value)); },
  }; } }; } } };
  const storage = { getAlarm: async () => alarm, setAlarm: async value => { alarm = value; }, deleteAlarm: async () => { alarm = null; } };
  const scheduler = createClassScheduler({ storage, env, now: () => time, monitor: async (_env, options) => {
    calls.push({ time, options });
    state.set('last-monitor-attempt', time);
    state.set('active-until', env.active ? time + 120000 : 0);
    if (env.fail) throw new Error('simulated monitor failure');
  } });
  return { scheduler, state, env, calls, alarm: () => alarm,
    time: value => { time = at(value); },
    fire: () => { alarm = null; return scheduler.alarm(); },
  };
}

test('no minute polling outside class: one durable alarm jumps to class, ticks, then stops', async () => {
  const f = fixture();
  await f.scheduler.plan();
  assert.equal(f.alarm(), at('07:50:00'));
  assert.equal(f.calls.length, 0);
  f.time('07:50:00'); await f.fire();
  assert.deepEqual(f.calls, [{ time: at('07:50:00'), options: { scheduled: true } }]);
  assert.equal(f.alarm(), at('07:51:00'));
  f.time('09:39:00'); await f.fire();
  assert.equal(f.alarm(), null);
  assert.equal(f.state.get('class-alarm').nextAt, null);
});
test('timetable changes and disabling monitoring replace or cancel pending class alarms', async () => {
  const f = fixture(); await f.scheduler.plan();
  f.state.set('timetable', { windows: [{ start: '2026-11-13T13:00:00+08:00', end: '2026-11-13T14:40:00+08:00' }] });
  await f.scheduler.plan(); assert.equal(f.alarm(), at('12:50:00'));
  f.env.ENABLED = 'false'; await f.scheduler.plan(); assert.equal(f.alarm(), null);
});
test('half-hour planning preserves an already due alarm; monitor failures still plan the next minute', async () => {
  const f = fixture(); await f.scheduler.plan();
  f.time('07:50:10'); await f.scheduler.plan(); assert.equal(f.alarm(), at('07:50:00'));
  f.env.fail = true;
  await assert.rejects(f.fire(), /simulated/);
  assert.equal(f.alarm(), at('07:51:00'));
});
test('persistent alarms switch from five-minute discovery to minute attendance checks and back', async () => {
  const f = fixture(); f.env.CLASS_DISCOVERY_INTERVAL_MINUTES = '5';
  await f.scheduler.plan(); assert.equal(f.alarm(), at('07:50:00'));
  f.time('07:50:00'); await f.fire(); assert.equal(f.alarm(), at('07:55:00'));
  f.env.active = true;
  f.time('07:55:00'); await f.fire(); assert.equal(f.alarm(), at('07:56:00'));
  f.env.active = false;
  f.time('07:56:00'); await f.fire(); assert.equal(f.alarm(), at('08:01:00'));
});
test('pending record verification adds only a bounded follow-up alarm after classroom hours', async () => {
  const f = fixture(); f.time('21:00:00');
  f.state.set('verification-next', at('21:01:00'));
  await f.scheduler.plan(); assert.equal(f.alarm(), at('21:01:00'));
  f.time('21:01:00'); f.state.delete('verification-next');
  await f.fire(); assert.equal(f.alarm(), null);
  assert.equal(f.calls.length, 1);
});
