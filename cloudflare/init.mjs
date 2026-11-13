import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const content = `BARK_DEVICE_KEY=""\nUCLOUD_TOKEN=""\nUCLOUD_REFRESH_TOKEN=""\nSESSION_SECRET="${randomBytes(32).toString('hex')}"\nADMIN_KEY="${randomBytes(32).toString('hex')}"\nCONFIRM_SECRET="${randomBytes(32).toString('hex')}"\n`;
try {
  writeFileSync(new URL('./.dev.vars', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('已创建 cloudflare/.dev.vars；请在本地填写 Bark key 与云邮会话，现有配置不会被覆盖。');
} catch (error) {
  console.error(error.code === 'EEXIST' ? '配置已存在，未覆盖。' : '创建配置失败。');
  process.exitCode = 1;
}
