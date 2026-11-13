import { serverTime } from '../public/monitor/core.js';

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
  // Cron's trigger second varies. Compare minute buckets so a tick at :40 after :42
  // does not accidentally turn a one-minute schedule into a two-minute schedule.
  return !lastAttempt || Math.floor(now / 60000) - Math.floor(lastAttempt / 60000) >= (dense ? 1 : interval);
}
