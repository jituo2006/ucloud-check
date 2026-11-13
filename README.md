# 云邮课堂监测与 Bark 提醒

当前主线是 **Cloudflare Workers + D1 云端服务**：从教务导入学期课表，自动维护云邮会话，按上课时间监测并发送 Bark 提醒。Mac 关机后服务仍可运行。

当前运行范围（2026-11-13 用户最新选择）：**课堂监测、Bark 提醒和自动签到试运行**。签到检测、提交和 `AUTO_SIGN` 已开启，独立采样关闭；使用原 Chrome 插件兼容协议，检测到当前课堂的正数签到 ID 后自动处理，同一活动只提交一次。

2026-11-13 已部署并验证一次真实令牌续期、课程查询、云端 Bark 推送及整学期课表导入。监测范围为北京时间 **07:00–21:00**，课前十分钟至下课每分钟检查，课外每半小时只维护登录。当前已导入 172 个上课时段；自动模式已通过 49 项模拟测试，真实课堂处理结果需查看云端状态与本人到课记录。

## 从哪里开始读

1. [文档导航](docs/README.md)：按当前云端服务、本地扩展和历史部署说明分类。
2. [实现流程与源码导读](docs/IMPLEMENTATION.md)：目录职责、函数调用顺序、登录刷新、课表调度、Bark 与手机确认。
3. [学期课表导入](docs/TIMETABLE_IMPORT.md)：当前课表来源、调课处理和导入命令。
4. [部署与 Bark 配置](docs/CLOUDFLARE_BARK.md)、[部署记录](docs/DEPLOYMENT_2026-11-13.md)。

## 代码目录

| 目录 | 职责 |
|---|---|
| `cloudflare/` | 当前云端主线：主入口、会话、课表、调度、部署配置、数据库迁移 |
| `public/monitor/` | 云端和扩展共享的协议校验函数 |
| `relay/web/` | 云端与本地共用的手机确认页面 |
| `src/`、`public/background.js` | Chrome 扩展弹窗、设置、会话同步及本地后台监测 |
| `relay/server.mjs` | 本地 Node 中转原型，运行依赖本机在线 |
| `tests/` | 云端、会话、课表、调度、扩展和本地中转的模拟测试 |
| `docs/` | 实现导读、配置说明和历史验证记录 |

## 常用命令

在本仓库目录运行；完整测试及 Wrangler 建议使用 Node.js 22.12+。

```bash
pnpm test                 # 模拟测试，不使用真实学校令牌
pnpm cf:dev               # 本地运行 Worker；会读取本地 .dev.vars 中的配置
pnpm cf:check             # 部署包预检，不发布
pnpm cf:import-timetable  # 将本地课表规则上传到既有云端服务
pnpm bark:test            # 向本人的 iPhone 发送真实测试通知
```

`cloudflare/.dev.vars` 和 `cloudflare/timetable.local.json` 均被 Git 忽略。实际密钥、令牌和个人课表不写入说明文档。云端 Secrets 中的初始令牌用于初始化，加密保存到 D1 的新令牌用于后续续期。

## Chrome 扩展

扩展保留课程卡片、手动操作与二维码功能。本地 Bark 扩展方案另见 [本地说明](docs/BARK_LOCAL.md)；它与当前云端方案是两条运行路径。

## 构建与安装

需要 Node.js 20.19+ 或 22.12+，以及 pnpm。

```bash
pnpm install --frozen-lockfile
pnpm build
```

1. 在 Chrome 中打开 `chrome://extensions/`。
2. 开启右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择构建生成的 `dist` 目录。
4. 打开插件设置，登录 UCloud 后刷新状态。
5. 打开插件弹窗，查看课程并进行操作。

更新代码并重新构建后，在扩展管理页点击刷新。

## 数据与权限

扩展使用 Cookie、本地存储和剪贴板权限同步登录会话。当前实现会将令牌以及用户选择保存的账号密码存入浏览器扩展本地存储；自动提取令牌时还会尝试写入剪贴板。相关请求发送至 UCloud 服务。

## 开发

基于 React、TypeScript、Vite、Semi Design 和 Tailwind CSS。

```bash
pnpm dev    # 开发页面预览；扩展 API 需在 Chrome 扩展环境中使用
pnpm lint   # 静态检查
pnpm build  # 类型检查并生成扩展文件
```
