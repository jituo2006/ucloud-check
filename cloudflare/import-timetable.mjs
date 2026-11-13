import { readFileSync } from 'node:fs';
import { expandTimetable } from './timetable.mjs';
import { relayOrigin } from '../public/monitor/core.js';

try {
  if (!process.env.ADMIN_KEY) throw new Error('缺少本地 ADMIN_KEY');
  const input = JSON.parse(readFileSync(process.argv[2] || 'cloudflare/timetable.local.json', 'utf8'));
  const timetable = expandTimetable(input);
  const origin = relayOrigin(process.env.UCLOUD_SERVICE_URL || 'https://ucloud-check.studyhub-lab-7c42.workers.dev');
  const response = await fetch(origin + '/api/admin/timetable', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${process.env.ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(timetable) });
  if (!response.ok) throw new Error('云端导入未成功，HTTP ' + response.status);
  const result = await response.json();
  if (result.ok !== true || result.count !== timetable.windows.length) throw new Error('云端未确认完整课表');
  console.log(`已导入 ${result.term} 学期，共 ${result.count} 个上课时段。`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
