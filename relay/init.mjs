import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const content = [
  'HOST=127.0.0.1', 'PORT=8787', 'PUBLIC_BASE_URL=http://127.0.0.1:8787',
  `RELAY_KEY=${randomBytes(32).toString('hex')}`,
  `CONFIRM_SECRET=${randomBytes(32).toString('hex')}`,
  'BARK_DEVICE_KEY=', 'STATE_FILE=relay/data/state.json', '',
].join('\n');
try {
  writeFileSync(new URL('./.env', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('已创建 relay/.env。请在本地填写 Bark device key；现有配置不会被覆盖。');
} catch (error) {
  if (error.code === 'EEXIST') console.error('relay/.env 已存在，未覆盖。');
  else console.error('创建本地配置失败。');
  process.exitCode = 1;
}
