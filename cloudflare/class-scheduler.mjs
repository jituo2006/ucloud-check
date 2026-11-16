import { nextClassWake } from './schedule.mjs';

export async function syncClassAlarm(env) {
  if (!env.CLASS_SCHEDULER) return null;
  const response = await env.CLASS_SCHEDULER.getByName('class-monitor').fetch('https://scheduler.internal/plan', { method: 'POST' });
  if (!response.ok) throw new Error('课堂唤醒计划更新失败');
  return response.json();
}

// The platform persists the alarm; there are no local timers or sleeping Workers.
export function createClassScheduler({ storage, env, monitor, now = Date.now }) {
  let pending = Promise.resolve();
  const serial = work => {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  };
  const read = async key => {
    const row = await env.DB.prepare('SELECT value FROM state WHERE key = ?').bind(key).first();
    return row ? JSON.parse(row.value) : null;
  };
  const plan = async () => {
    const timetable = await read('timetable');
    const activeUntil = await read('active-until');
    const lastAttempt = await read('last-monitor-attempt');
    const nextAt = nextClassWake(env, now(), timetable, activeUntil || 0, lastAttempt || 0);
    const previous = await storage.getAlarm();
    // A concurrent half-hour tick must not postpone an already due class alarm.
    if (nextAt === null) await storage.deleteAlarm();
    else if (previous !== nextAt && !(previous !== null && previous <= now())) await storage.setAlarm(nextAt);
    const state = { mode: 'class-alarm', nextAt: await storage.getAlarm(), updatedAt: now() };
    await env.DB.prepare('INSERT INTO state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .bind('class-alarm', JSON.stringify(state)).run();
    return state;
  };
  return {
    plan: () => serial(plan),
    alarm: () => serial(async () => {
      try { await monitor(env, { scheduled: true }); }
      finally { await plan(); }
    }),
  };
}
