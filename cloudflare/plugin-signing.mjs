import { id, serverTime } from '../public/monitor/core.js';

// Compatibility with the original Chrome autoSign(): the basic endpoint's positive ID
// is the activity candidate. Do not invent mandatory personal-state fields it never used.
export function pluginActivity(data, course, now) {
  const basic = data?.attendanceBasicInfo;
  if (!basic || basic.id === undefined || basic.id === null || String(basic.id) === '0') return null;
  const attendanceId = id(basic.id), siteId = id(course.siteId), groupId = id(course.groupId);
  if (basic.siteId !== undefined && id(basic.siteId) !== siteId) throw new Error('签到课程不一致');
  if (basic.classLessonId !== undefined && id(basic.classLessonId) !== groupId) throw new Error('签到课次不一致');
  const startedAt = serverTime(basic.attendanceStartTime), end = serverTime(basic.attendanceEndTime);
  if (Number.isFinite(startedAt) && startedAt > now) return null;
  if (Number.isFinite(end) && end <= now) return null;
  return { attendanceId, siteId, groupId, startedAt: Number.isFinite(startedAt) ? startedAt : null,
    expiresAt: Number.isFinite(end) ? end : now + 300000 };
}

export function matchingRecord(data, activity) {
  if (!Array.isArray(data?.timeAndStatusList)) return null;
  const matches = data.timeAndStatusList.filter(row => {
    if (row.attendanceId !== undefined) return String(row.attendanceId) === activity.attendanceId;
    return activity.startedAt !== null && serverTime(row.time) === activity.startedAt;
  });
  return matches.length === 1 ? matches[0] : null;
}
