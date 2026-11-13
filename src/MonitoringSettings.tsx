import { useEffect, useState } from 'react';

interface MonitorConfig { enabled: boolean; relayUrl: string; relayKey: string; openStatuses: string[]; unsignedPath: string; unsignedValues: string[] }
interface MonitorStatus { message: string; updatedAt: number; error: boolean }
interface Extension {
  storage: { local: { get(keys: string[]): Promise<{ monitorConfig?: MonitorConfig; monitorStatus?: MonitorStatus }>;
    set(items: { monitorConfig: MonitorConfig }): Promise<void> } };
  permissions: { request(details: { origins: string[] }): Promise<boolean> };
}
const empty: MonitorConfig = { enabled: false, relayUrl: '', relayKey: '', openStatuses: [], unsignedPath: '', unsignedValues: [] };

export function MonitoringSettings() {
  const [config, setConfig] = useState(empty);
  const [statuses, setStatuses] = useState('');
  const [unsignedValues, setUnsignedValues] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<MonitorStatus>();
  const extension = (globalThis as typeof globalThis & { chrome?: Extension }).chrome;
  useEffect(() => {
    void extension?.storage.local.get(['monitorConfig', 'monitorStatus']).then(items => {
      if (items.monitorConfig) {
        setConfig({ ...empty, ...items.monitorConfig });
        setStatuses(items.monitorConfig.openStatuses.join(','));
        setUnsignedValues(items.monitorConfig.unsignedValues?.join(',') || '');
      }
      setStatus(items.monitorStatus);
    });
  }, [extension]);

  async function save() {
    try {
      if (!extension) throw new Error('请在扩展设置页使用');
      if (!config.enabled) {
        await extension.storage.local.set({ monitorConfig: { ...config, enabled: false } });
        setMessage('后台监测已关闭。');
        return;
      }
      const url = new URL(config.relayUrl);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('请使用 HTTPS 服务地址');
      if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('请填写服务根地址');
      if (config.relayKey.length < 32) throw new Error('请填写中转服务生成的连接密钥');
      const granted = await extension.permissions.request({ origins: [url.origin + '/*'] });
      if (!granted) throw new Error('未授予中转连接权限，设置未保存');
      await extension.storage.local.set({ monitorConfig: { ...config, relayUrl: url.origin,
        openStatuses: statuses.split(',').map(s => s.trim()).filter(Boolean),
        unsignedValues: unsignedValues.split(',').map(s => s.trim()).filter(Boolean) } });
      setMessage('已保存。仅在手机明确确认后提交签到；电脑与浏览器需要保持在线。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
  }

  return <section style={{ marginTop: 32, borderTop: '1px solid #ddd', paddingTop: 20 }}>
    <h2>手机提醒与确认签到</h2>
    <p>通过 Bark 接收提醒，在手机确认页面点“确认签到”后才提交。未配置时不会后台签到。</p>
    <label style={{ display: 'block', margin: '12px 0' }}><input type="checkbox" checked={config.enabled}
      onChange={e => setConfig({ ...config, enabled: e.target.checked })} /> 启用后台监测</label>
    <label style={{ display: 'block', margin: '12px 0' }}>中转服务地址<br />
      <input aria-label="中转服务地址" style={{ width: '100%' }} placeholder="https://your-relay.example"
        value={config.relayUrl} onChange={e => setConfig({ ...config, relayUrl: e.target.value })} /></label>
    <label style={{ display: 'block', margin: '12px 0' }}>中转连接密钥<br />
      <input aria-label="中转连接密钥" type="password" autoComplete="off" style={{ width: '100%' }}
        value={config.relayKey} onChange={e => setConfig({ ...config, relayKey: e.target.value })} /></label>
    <details><summary>签到状态校准（首次接入）</summary>
      <p>需要先从本人正常课堂响应核实开放状态值与有效期。未校准时只监测开课，不发送签到确认。</p>
      <label>已核实的开放状态值（多个用逗号分隔）<br />
        <input aria-label="已核实的签到开放状态" value={statuses} onChange={e => setStatuses(e.target.value)} /></label>
      <p>还需要核实本人“未签到”字段，避免对已完成的签到重复提交。路径相对于接口 data 对象；请根据真实响应填写，不要猜测。</p>
      <label>本人状态字段路径<br /><input aria-label="本人签到状态字段路径" value={config.unsignedPath}
        onChange={e => setConfig({ ...config, unsignedPath: e.target.value.trim() })} /></label><br />
      <label>已核实的“未签到”状态值<br /><input aria-label="未签到状态值" value={unsignedValues}
        onChange={e => setUnsignedValues(e.target.value)} /></label>
    </details>
    <button type="button" onClick={() => void save()} style={{ marginTop: 16 }}>保存监测设置</button>
    <p role="status">{message}</p>
    {status && <p>最近状态：{status.message}（{new Date(status.updatedAt).toLocaleString()}）</p>}
  </section>;
}
