# UCloud Check

云邮 Chrome 扩展与 Cloudflare Workers 服务，支持监测、Bark 提醒、会话续期。

## 目录

- `src/`、`public/`：Chrome 扩展与公共协议校验。
- `cloudflare/`：云端服务、课表转换、登录续期、部署模板和数据库迁移。
- `relay/`：本地中转及共用手机页面。
- `tests/`：模拟接口、调度、去重和结果核验测试。

## 开发

需要 Node.js 22.12+ 和 pnpm。

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

在 Chrome 扩展管理页加载构建后的 `dist/`。

## 云端配置
~~这些均为ai生成，个性化配置还是具体根据自己的agent为妙~~
1. 将 `cloudflare/wrangler.toml` 复制为 `cloudflare/wrangler.local.toml`，填写自己的 D1 数据库 ID、服务地址和功能开关。
2. 运行 `pnpm cf:init` 生成本地 `.dev.vars`，填写自己的 Bark 配置和同次登录的云邮访问/刷新令牌。
3. 创建 D1 并应用 `cloudflare/migrations/` 中的全部迁移；更新旧服务时先应用新增迁移，再发布代码。本地配置和线上 Secrets 分开管理；部署前需将所需 Secrets 上传到自己的 Worker。
4. 使用 `pnpm cf:check` 检查构建，`pnpm cf:deploy` 发布。命令优先读取被 Git 忽略的 `wrangler.local.toml`。

公开模板默认关闭监测和提交。`ENABLE_ATTENDANCE_MONITOR` 控制签到检测，`ENABLE_SIGNING` 控制提交，`AUTO_SIGN` 控制自动执行；关闭自动执行时保留手机确认流程。`SIGNING_PROTOCOL=plugin` 使用原扩展协议。

基础 Cron 每半小时触发；`SESSION_MAINTENANCE_24H=true` 启用全天登录续期。课表另由 SQLite Durable Object Alarm 保存下次唤醒时间：课前 `PRECLASS_MINUTES` 分钟开始，每 `CLASS_DISCOVERY_INTERVAL_MINUTES` 分钟检查，默认值为 1，即课前十分钟至下课每分钟检测课堂和签到，无需等待平台先报告课堂开启；课外停止密集唤醒。发布会创建所需的 Durable Object 绑定；导入课表时自动重排闹钟，也可通过已认证的 `POST /api/admin/scheduler-sync` 重排。定期刷新能否延长刷新令牌有效期取决于平台。

固定期限的 refresh token 通过正常重新认证替换：在 Worker Secrets 中配置 `UCLOUD_CAS_USERNAME`、`UCLOUD_CAS_PASSWORD` 并启用 `AUTO_REAUTH=true`，默认提前 `REAUTH_BEFORE_EXPIRY_MINUTES=120` 分钟获取 CAS ticket 并换取新会话。SSO Cookie 和新令牌一并加密保存，优先复用 SSO；账号核对成功后才替换旧会话。SSO ticket 被拒绝时尝试一次全新正常登录；网络、令牌兑换或临时身份核验失败按维护周期退避，仍有效的 access token 继续使用。验证码、密码拒绝和账号不一致会停止自动尝试并通知本人。状态接口仅保留阶段、HTTP 状态和白名单错误码，不记录服务端原始错误描述。已认证的 `POST /api/admin/reauthenticate` 可显式重试一次，`{"freshLogin":true}` 可不复用 SSO 会话。

`POST /api/admin/status` 的 `lastFailure` 保留恢复前最近一次故障的接口和脱敏错误码。登录暂时失败与需要本人验证使用不同提醒；后台核实登录恢复后补发一次 Bark 通知。只读请求的 HTTP 401 或业务码 401 可触发一次会话恢复，签到提交不重发。

原插件协议提交后立即查询学校到课记录；尚未核实时，每分钟只读复核，最多五次，并受十分钟总期限限制。核实同一活动的记录后更新为 `verified` 并补发 Bark 成功通知；`unknown` 显示为“提交结果待核验”。待复核任务存入 D1，课堂结束后仍由闹钟完成有限复核。已认证的 `POST /api/admin/reconcile-attendance` 可只读复核近期旧记录，不重新提交签到。

```bash
pnpm cf:dev               # 本地开发，Cron 需显式触发
pnpm cf:db:local          # 仅应用本地 D1 迁移
pnpm cf:import-timetable  # 上传本地学期规则文件
pnpm bark:test            # 向自己的设备发送真实测试通知
pnpm privacy:check        # 检查待提交文件中的已知本地秘密及常见密钥格式
```

`cloudflare/.dev.vars`、`cloudflare/wrangler.local.toml`、`cloudflare/timetable.local.json`、本地运行数据和工作笔记不纳入 Git。实际凭据不要写入源码、测试样例或文档。后台收到成功响应与独立查询到课记录是不同结果，通知失败或写请求超时也不应导致重复提交。
