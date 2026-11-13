if (!process.env.BARK_DEVICE_KEY) {
  console.error('请先在 cloudflare/.dev.vars 填写 BARK_DEVICE_KEY。');
  process.exitCode = 1;
} else {
  try {
    const response = await fetch('https://api.day.app/push', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_key: process.env.BARK_DEVICE_KEY, title: '云邮提醒测试',
        body: 'Bark 已连接。这是测试消息，没有执行签到。', group: 'ucloud-check' }),
    });
    if (!response.ok || (await response.json()).code !== 200) throw new Error('推送未被接受');
    console.log('Bark 已接受测试推送，请检查 iPhone 通知。');
  } catch {
    console.error('测试推送未确认，请检查设备 key、网络和 Bark 通知权限。');
    process.exitCode = 1;
  }
}
