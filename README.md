# UCloud Check

云邮 Chrome 扩展与 Cloudflare Workers 服务，支持课表驱动的课堂监测、Bark 提醒、会话续期及可选签到处理。

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

1. 将 `cloudflare/wrangler.toml` 复制为 `cloudflare/wrangler.local.toml`，填写自己的 D1 数据库 ID、服务地址和功能开关。
2. 运行 `pnpm cf:init` 生成本地 `.dev.vars`，填写自己的 Bark 配置和同次登录的云邮访问/刷新令牌。
3. 创建 D1 并应用 `cloudflare/migrations/0001.sql`。本地配置和线上 Secrets 分开管理；部署前需将所需 Secrets 上传到自己的 Worker。
4. 使用 `pnpm cf:check` 检查构建，`pnpm cf:deploy` 发布。命令优先读取被 Git 忽略的 `wrangler.local.toml`。

公开模板默认关闭监测和提交。`ENABLE_ATTENDANCE_MONITOR` 控制签到检测，`ENABLE_SIGNING` 控制提交，`AUTO_SIGN` 控制自动执行；关闭自动执行时保留手机确认流程。`SIGNING_PROTOCOL=plugin` 使用原扩展协议。

```bash
pnpm cf:dev               # 本地开发，Cron 需显式触发
pnpm cf:db:local          # 仅应用本地 D1 迁移
pnpm cf:import-timetable  # 上传本地学期规则文件
pnpm bark:test            # 向自己的设备发送真实测试通知
pnpm privacy:check        # 检查待提交文件中的已知本地秘密及常见密钥格式
```

`cloudflare/.dev.vars`、`cloudflare/wrangler.local.toml`、`cloudflare/timetable.local.json`、本地运行数据和工作笔记不纳入 Git。实际凭据不要写入源码、测试样例或文档。后台收到成功响应与独立查询到课记录是不同结果，通知失败或写请求超时也不应导致重复提交。
