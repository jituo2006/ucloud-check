import { spawnSync } from 'node:child_process';
import { configurationPath } from './config.mjs';

const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'wrangler', ...process.argv.slice(2), '--config', configurationPath()], { stdio: 'inherit' });
if (result.error) console.error('无法启动 Wrangler，请先安装项目依赖。');
process.exitCode = result.status ?? 1;
