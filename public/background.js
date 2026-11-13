import { activeAttendance, confirmedUnsigned, eventKey, id, relayOrigin, unwrap } from './monitor/core.js';

const API = 'https://apiucloud.bupt.edu.cn';
const defaults = { enabled: false, relayUrl: '', relayKey: '', openStatuses: [], unsignedPath: '', unsignedValues: [] };
let busy = false;

async function config() {
  return { ...defaults, ...(await chrome.storage.local.get('monitorConfig')).monitorConfig };
}

async function api(path, method = 'GET', data, sessionToken) {
  const token = sessionToken ?? (await chrome.storage.local.get('token')).token;
  if (!token) throw new Error('缺少登录会话，请先登录云邮并同步令牌');
  const response = await fetch(API + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Blade-Auth': token, Authorization: 'Basic c3dvcmQ6c3dvcmRfc2VjcmV0',
      'Tenant-Id': '000000', ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  if (response.status === 401) throw new Error('云邮登录已失效，请重新登录并同步令牌');
  if (!response.ok) throw new Error(`平台请求失败（HTTP ${response.status}）`);
  return unwrap(await response.json());
}

async function relay(settings, path, body) {
  const origin = relayOrigin(settings.relayUrl);
  const response = await fetch(origin + path, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${settings.relayKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`通知中转连接失败（HTTP ${response.status}）`);
  return response.json();
}

async function going(siteIds, sessionToken) {
  const result = await api('/blade-chat/web/chat/myCourse?siteIds=' + siteIds.join(','), 'POST', {}, sessionToken);
  if (!Array.isArray(result)) throw new Error('课堂列表响应格式未确认');
  return result.map(course => ({ siteId: id(course.siteId), groupId: id(course.groupId) }));
}

async function basic(course, settings, sessionToken) {
  const result = await api('/ykt-site/attendancebasicinfo/basic', 'POST', course, sessionToken);
  const activity = activeAttendance(result, course, settings.openStatuses);
  return activity && { ...activity, unsigned: confirmedUnsigned(result, settings.unsignedPath, settings.unsignedValues) };
}

async function status(message, error = false) {
  await chrome.storage.local.set({ monitorStatus: { message, error, updatedAt: Date.now() } });
  await chrome.action.setBadgeText({ text: error ? '!' : '' });
  if (error) await chrome.action.setBadgeBackgroundColor({ color: '#b42318' });
}

async function monitor(settings) {
  const user = await api('/ykt-basics/info');
  const userId = id(user.id);
  const sites = await api(`/ykt-site/site/list/student/current?userId=${userId}&siteRoleCode=2&current=1&size=9999`);
  if (!Array.isArray(sites?.records)) throw new Error('课程响应格式未确认');
  const names = new Map(sites.records.map(site => [id(site.id), String(site.siteName || '当前课程')]));
  const courses = names.size ? await going([...names.keys()]) : [];
  const stored = await chrome.storage.local.get('monitorSeen');
  const previous = stored.monitorSeen;
  const seen = previous?.userId === userId && previous.accountBinding ? previous :
    { userId, accountBinding: crypto.randomUUID(), initialized: false, classroom: [], attendance: [] };
  const classroom = [];
  const attendance = [];
  const uncalibrated = !settings.openStatuses.length || !settings.unsignedPath || !settings.unsignedValues.length;
  for (const course of courses) {
    const room = { ...course, accountBinding: seen.accountBinding, kind: 'classroom', title: names.get(course.siteId) || '当前课程', expiresAt: Date.now() + 300000 };
    const roomKey = eventKey(room);
    classroom.push(roomKey);
    // First observation is a baseline: old classes do not flood the phone.
    if (seen.initialized && !seen.classroom.includes(roomKey)) await relay(settings, '/api/events', room);
    if (!settings.openStatuses.length) continue;
    const activity = await basic(course, settings);
    if (!activity || !activity.unsigned) continue;
    const event = { ...activity, accountBinding: seen.accountBinding, kind: 'attendance', title: room.title };
    const key = eventKey(event);
    attendance.push(key);
    // Initial active attendance is actionable, unlike historical classroom messages.
    if (!seen.attendance.includes(key)) await relay(settings, '/api/events', event);
  }
  await chrome.storage.local.set({ monitorSeen: { userId, accountBinding: seen.accountBinding, initialized: true, classroom, attendance } });
  await status(uncalibrated ? '课堂监测正常；签到开放状态尚未校准，暂不发送签到确认' : `监测正常：${courses.length} 个进行中课堂`);
}

async function commands(settings) {
  const stored = await chrome.storage.local.get(['monitorAttempts', 'monitorSeen']);
  const attempts = stored.monitorAttempts || {};
  // Flush durable outcomes first. Unknown is never silently converted to success.
  for (const [commandId, attempt] of Object.entries(attempts)) {
    if (attempt.reported) continue;
    const outcome = attempt.outcome || 'unknown';
    await relay(settings, '/api/results', { commandId, outcome });
    attempts[commandId] = { ...attempt, outcome, reported: true };
    await chrome.storage.local.set({ monitorAttempts: attempts });
  }
  const { commands: queue } = await relay(settings, '/api/commands/claim', {});
  for (const command of queue) {
    if (attempts[command.id]) continue;
    let outcome = 'failed';
    try {
      if (!settings.enabled || command.expiresAt <= Date.now()) throw new Error('确认已过期');
      const sessionToken = (await chrome.storage.local.get('token')).token;
      const user = await api('/ykt-basics/info', 'GET', undefined, sessionToken);
      if (id(user.id) !== stored.monitorSeen?.userId || !command.accountBinding ||
          command.accountBinding !== stored.monitorSeen?.accountBinding) throw new Error('登录账号已变化');
      const course = { siteId: id(command.siteId), groupId: id(command.groupId) };
      const classrooms = await going([course.siteId], sessionToken);
      if (!classrooms.some(c => c.siteId === course.siteId && c.groupId === course.groupId)) throw new Error('课堂已结束');
      const current = await basic(course, settings, sessionToken);
      if (!current || !current.unsigned || current.attendanceId !== id(command.attendanceId)) throw new Error('签到已完成、状态不明或活动已变化');
      const clock = await api('/ykt-site/common/v2/clock', 'GET', undefined, sessionToken);
      if (typeof clock?.data !== 'string' || !clock.data) throw new Error('未取得有效动态参数');
      const latest = await config();
      const latestSession = await chrome.storage.local.get(['token', 'monitorSeen']);
      if (!latest.enabled || latest.relayUrl !== settings.relayUrl || latest.relayKey !== settings.relayKey ||
          latestSession.token !== sessionToken || latestSession.monitorSeen?.accountBinding !== command.accountBinding ||
          command.expiresAt <= Date.now() || current.expiresAt <= Date.now()) throw new Error('监测已停用或确认已过期');
      // Persist before the write: a worker crash cannot cause a blind second submission.
      attempts[command.id] = { createdAt: Date.now(), outcome: null, reported: false };
      await chrome.storage.local.set({ monitorAttempts: attempts });
      outcome = 'unknown';
      await api('/ykt-site/attendancedetailinfo/sign', 'POST', {
        attendanceDetailInfo: { attendanceId: current.attendanceId, siteId: current.siteId,
          userId: id(user.id), classLessonId: current.groupId }, qrCodeCreateTime: clock.data,
      }, sessionToken);
      // This means the server accepted the business request, not an independent record audit.
      outcome = 'accepted';
    } catch {
      // Do not log platform responses or credentials. A submitted-but-unanswered request stays unknown.
    }
    attempts[command.id] = { createdAt: Date.now(), outcome, reported: false };
    await chrome.storage.local.set({ monitorAttempts: attempts });
    await relay(settings, '/api/results', { commandId: command.id, outcome });
    attempts[command.id].reported = true;
    // Keep bounded local history; relay never reclaims delivered commands.
    const entries = Object.entries(attempts).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 200);
    await chrome.storage.local.set({ monitorAttempts: Object.fromEntries(entries) });
  }
}

async function configure() {
  const settings = await config();
  if (!settings.enabled) {
    await chrome.alarms.clear('classroom-monitor');
    await chrome.alarms.clear('confirmation-commands');
    await status('后台监测未启用');
    return;
  }
  relayOrigin(settings.relayUrl);
  if (!settings.relayKey) throw new Error('请先配置中转连接密钥');
  if (!await chrome.alarms.get('classroom-monitor')) chrome.alarms.create('classroom-monitor', { periodInMinutes: 1 });
  if (!await chrome.alarms.get('confirmation-commands')) chrome.alarms.create('confirmation-commands', { periodInMinutes: 0.5 });
}

export async function run(name) {
  if (busy) return;
  busy = true;
  try {
    const settings = await config();
    if (!settings.enabled) return;
    if (name === 'classroom-monitor') await monitor(settings);
    else await commands(settings);
  } catch (error) { await status(error instanceof Error ? error.message : '监测暂不可用', true); }
  finally { busy = false; }
}

chrome.alarms.onAlarm.addListener(alarm => { void run(alarm.name); });
chrome.runtime.onInstalled.addListener(() => { void configure().catch(() => status('请检查监测设置', true)); });
chrome.runtime.onStartup.addListener(() => { void configure().catch(() => status('请检查监测设置', true)); });
chrome.storage.onChanged.addListener(changes => {
  if (changes.monitorConfig) void configure().catch(() => status('请检查监测设置', true));
});
// Alarms may be lost after a browser restart; restore them on every worker startup.
void configure().catch(() => status('请检查监测设置', true));
