// Pure protocol helpers, shared by the worker and offline tests.
export function id(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('服务端标识精度不明确');
  const result = String(value ?? '');
  if (!/^[1-9]\d*$/.test(result)) throw new Error('缺少有效的课程或活动标识');
  return result;
}

export function unwrap(body) {
  if (!body || body.code !== 200) throw new Error('平台未确认业务请求成功');
  return body.data;
}

export function serverTime(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const text = value.trim();
  // The platform's unzoned display timestamps use Asia/Shanghai.
  const zoned = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d)?$/.test(text)
    ? text.replace(' ', 'T') + '+08:00' : text;
  return Date.parse(zoned);
}

export function activeAttendance(data, course, openStatuses, now = Date.now()) {
  const basic = data?.attendanceBasicInfo;
  if (!Array.isArray(openStatuses) || !openStatuses.length) throw new Error('签到开放状态尚未校准');
  if (!basic || !openStatuses.includes(String(basic.attendanceBasicStatus))) return null;
  const attendanceId = id(basic.id);
  const siteId = id(course.siteId);
  const groupId = id(course.groupId);
  if (basic.siteId !== undefined && id(basic.siteId) !== siteId) throw new Error('签到课程与当前课堂不一致');
  if (basic.classLessonId !== undefined && id(basic.classLessonId) !== groupId) throw new Error('签到课次不一致');
  const start = serverTime(basic.attendanceStartTime);
  const end = serverTime(basic.attendanceEndTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('签到有效期尚未确认');
  if (start > now || end <= now) return null;
  return { siteId, groupId, attendanceId, expiresAt: end };
}

export function eventKey(event) {
  return [event.accountBinding || '', event.kind, id(event.siteId), id(event.groupId), event.kind === 'attendance' ? id(event.attendanceId) : 'class'].join(':');
}

export function confirmedUnsigned(data, path, values) {
  if (!path || !Array.isArray(values) || !values.length) return false;
  let current = data;
  for (const key of path.split('.')) {
    if (!key || ['__proto__', 'prototype', 'constructor'].includes(key) ||
        !current || typeof current !== 'object' || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  if (!['string', 'number', 'boolean'].includes(typeof current)) return false;
  return values.includes(String(current));
}

export function relayOrigin(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('中转服务须使用 HTTPS，本地测试可使用 localhost');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请填写中转服务根地址，不要附带密钥或路径');
  return url.origin;
}
