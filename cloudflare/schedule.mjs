import { serverTime } from '../public/monitor/core.js';

// Plan a real platform alarm instead of waking every minute just to check the clock.
export function nextClassWake(env, now, timetable, activeUntil = 0, lastAttempt = 0) {
  if (env.ENABLED !== 'true') return null;
  const dayStart = Number(env.DAY_START_HOUR ?? 7), dayEnd = Number(env.DAY_END_HOUR ?? 21);
  const before = Number(env.PRECLASS_MINUTES ?? 10);
  const discovery = Number(env.CLASS_DISCOVERY_INTERVAL_MINUTES ?? 1);
  if (!Number.isInteger(discovery) || discovery < 1 || discovery > 30) throw new Error('课堂发现间隔无效');
  if (!Number.isInteger(dayStart) || !Number.isInteger(dayEnd) || dayStart < 0 || dayEnd > 24 || dayStart >= dayEnd || !Number.isInteger(before) || before < 0 || before > 60) throw new Error('监测时段无效');
  const windows = timetable?.windows ?? JSON.parse(env.CLASS_WINDOWS || '[]');
  if (!Array.isArray(windows)) throw new Error('课表窗口格式无效');
  const ranges = windows.map(window => {
    const start = serverTime(window.start), end = serverTime(window.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 12 * 3600000) throw new Error('课程起止时间无效');
    return [start - before * 60000, end, discovery];
  });
  if (activeUntil > now) ranges.push([now, activeUntil, 1]);
  let next = Infinity;
  for (const [start, end, interval] of ranges) {
    if (end <= now) continue;
    const firstDay = Math.floor((Math.max(start, now) + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
    for (let day = firstDay; day < end; day += 86400000) {
      const due = lastAttempt ? (Math.floor(lastAttempt / 60000) + interval) * 60000 : 0;
      const from = Math.max(start, day + dayStart * 3600000, now + 1, due);
      const until = Math.min(end, day + dayEnd * 3600000);
      const tick = Math.ceil(from / 60000) * 60000;
      if (tick < until) next = Math.min(next, tick);
    }
  }
  return Number.isFinite(next) ? next : null;
}

export function monitoringDue(env, now, lastAttempt, activeUntil) {
  if (env.ENABLED !== 'true') return false;
  const local = new Date(now + 8 * 3600000);
  const hour = local.getUTCHours();
  const start = Number(env.DAY_START_HOUR ?? 7), end = Number(env.DAY_END_HOUR ?? 21);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) throw new Error('白天监测时段无效');
  if (hour < start || hour >= end) return false;
  const interval = Number(env.IDLE_INTERVAL_MINUTES ?? 30);
  if (!Number.isInteger(interval) || interval < 1 || interval > 120) throw new Error('监测间隔无效');
  const windows = JSON.parse(env.CLASS_WINDOWS || '[]');
  if (!Array.isArray(windows)) throw new Error('课表窗口格式无效');
  const before = Number(env.PRECLASS_MINUTES ?? 10);
  if (!Number.isInteger(before) || before < 0 || before > 60) throw new Error('课前监测时长无效');
  const nearClass = windows.some(window => {
    const start = serverTime(window.start), end = serverTime(window.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 12 * 3600000) throw new Error('课表起止时间无效');
    return now >= start - before * 60000 && now < end;
  });
  const dense = nearClass || activeUntil > now;
  if (env.SCHEDULE_ONLY === 'true' && !dense) return false;
  const discovery = Number(env.CLASS_DISCOVERY_INTERVAL_MINUTES ?? 1);
  if (!Number.isInteger(discovery) || discovery < 1 || discovery > 30) throw new Error('课堂发现间隔无效');
  // Cron's trigger second varies. Compare minute buckets so a tick at :40 after :42
  // does not accidentally turn a one-minute schedule into a two-minute schedule.
  return !lastAttempt || Math.floor(now / 60000) - Math.floor(lastAttempt / 60000) >= (activeUntil > now ? 1 : nearClass ? discovery : interval);
}
