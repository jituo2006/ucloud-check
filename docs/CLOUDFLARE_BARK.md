# Cloudflare Serverless 版与 Bark 配置

更新：2026-11-13。Workers + D1 已部署，Bark 本机测试和云端测试均成功，用户已在 iPhone 确认收到两条通知。学校会话已上传并完成一次真实云端续期；白天课堂监测已启用，签到提交仍关闭。最新状态见 [SESSION_AUTOMATION.md](SESSION_AUTOMATION.md)。

服务地址：https://ucloud-check.studyhub-lab-7c42.workers.dev 。确认页路径 `/confirm`，只有通知中携带的本轮有效链接才能确认活动；直接打开空白确认页不能签到。

本轮验证：24 项模拟测试通过，线上健康检查、确认页及静态文件返回 200；未鉴权的管理请求返回 401，鉴权状态查询返回 200 并成功读取 D1。完整记录见 [DEPLOYMENT_2026-11-13.md](DEPLOYMENT_2026-11-13.md)。真实云邮接口、签到字段和运行用量仍需验证。

## 先配置 Bark

1. 在 iPhone 安装官方 [Bark](https://bark.day.app/)，允许通知。
2. 使用 App 自带的测试示例，确认手机能收到推送。先保留默认推送服务 `api.day.app`，不必自建 Bark 服务端。
3. 找到 App 显示的推送地址，例如 `https://api.day.app/你的设备key/推送内容`。只复制中间的设备 key，不要复制整个地址。
4. 本轮已生成 `cloudflare/.dev.vars`，文件仅本人可读写，且被 Git 忽略。在本地将对应行填写为：

   ```dotenv
   BARK_DEVICE_KEY="你的设备key"
   ```

5. 在仓库目录运行：

   ```bash
   pnpm bark:test
   ```

   这会向自己的 iPhone 发送一条“云邮提醒测试”，不会执行签到。命令不输出 key；显示“Bark 已接受”后还需检查手机是否收到。

`ADMIN_KEY` 与 `CONFIRM_SECRET` 已由初始化脚本随机生成，保留即可。暂时不需要填写 `UCLOUD_TOKEN` 来测试 Bark。`.dev.vars` 不用发到聊天或上传 GitHub；新的 Serverless 版使用此文件，不要求再填旧的 `relay/.env`。

推送和确认分别负责不同事情：Bark 将通知送到 iPhone；Workers 承载确认页面并在本人确认后处理业务。部署 Worker 后，通知才会携带真实的手机确认页链接。

来源：[Bark 官方接口示例](https://github.com/Finb/Bark/blob/master/docs/tutorial.md)。

## Serverless 结构

```text
Cron 每分钟触发 Workers
  → 查询本人课堂与已校准的签到状态
  → D1 保存活动、去重和执行结果
  → Bark 推送
  → iPhone 打开 Workers 确认页
  → 本人明确点击确认
  → Workers 重查账号、活动和本人状态，再提交一次
```

此路线不依赖 Mac 或 Chrome 在线。云邮请求逻辑在 `cloudflare/worker.mjs` 内，D1 迁移在 `cloudflare/migrations/0001.sql`。现有插件可继续作为本地手动工具，无需强行唤起插件完成云端执行。

默认 `ENABLED=false`、`ENABLE_SIGNING=false`。签到开放状态、有效期和本人未签到字段仍需正常课堂抓包核实；未校准时不创建签到确认。首次课堂监测建立基线，之后新的课堂才产生开课提醒。

每轮确认最长 5 分钟，且不超过原活动有效期。确认、执行领取和通知领取通过 D1 条件更新去重。处理中的请求中断后只记录未知结果，不重新提交；最终业务接受与独立查询到课记录仍区分。Bark 接受请求后响应丢失时，通知重试可能产生重复提醒，签到提交不会因此自动重试。

## 免费计划与访问地址

按核对时的官方文档：Workers Free 每日 100,000 次请求、单次 10ms CPU 时间；D1 Free 每日 500 万行读取、10 万行写入、总存储 5GB。先用免费计划验证，不主动开通付费计划。实际 CPU、数据库使用量及账号内其他项目的用量仍需观察，不能只凭消息数量承诺长期零费用。

分钟级 Cron 一天触发 1,440 次，这只是调度次数，不是完整账单估算，也不代表对云邮的全部请求数。Cron 不是实时推送机制，短于监测间隔的活动仍可能错过。

可使用 Cloudflare 提供的 `workers.dev` HTTPS 地址，无需先购买独立域名。需要从常用 iPhone 网络实测该地址，并验证 Workers 到云邮的访问与登录会话是否可用。

来源：[Workers 费用](https://developers.cloudflare.com/workers/platform/pricing/)、[D1 费用](https://developers.cloudflare.com/d1/platform/pricing/)、[Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)。

## 本地验证

完整模拟测试需要 Node.js 22.12+；本轮使用 22.22。测试中的 SQLite 属于 Node 实验功能，只用于模拟 D1，云端使用 Cloudflare D1。

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint:monitor
pnpm cf:check
pnpm cf:db:local
pnpm cf:dev
```

`cf:check` 是 `deploy --dry-run`，不会部署；`cf:db:local` 只创建本地数据库。开发服务在 `http://127.0.0.1:8788`，`/health` 可检查路由，`/confirm` 在没有本轮能力链接时只显示提示。开发期间 Cron 不会自动运行；配置默认关闭监测，不会自行访问云邮。

首次生成配置可运行 `pnpm cf:init`，但本轮已经执行过；重复执行不会覆盖现有文件。

## 云端部署步骤（部署与 Bark 已完成）

以下保留为重建流程；当前已有线上服务和数据库，不要重复创建。`ADMIN_KEY`、`CONFIRM_SECRET` 和 `BARK_DEVICE_KEY` 已上传；`UCLOUD_TOKEN` 尚未配置。下一步从云邮会话和只读验证开始。

1. `pnpm exec wrangler login`，由本人完成 Cloudflare 授权。
2. `pnpm exec wrangler d1 create ucloud-check --config cloudflare/wrangler.toml`，把返回的数据库 ID 填入配置，替换全零占位符。
3. `pnpm exec wrangler d1 migrations apply DB --remote --config cloudflare/wrangler.toml`。
4. 保持两个启用开关为 `false`，运行 `pnpm exec wrangler deploy --config cloudflare/wrangler.toml`，取得实际 `workers.dev` 地址。
5. 将该根地址填入 `PUBLIC_BASE_URL`。通过下列形式分别录入 Secrets，不把 key 或令牌写进 `wrangler.toml`：

   ```bash
   pnpm exec wrangler secret put BARK_DEVICE_KEY --config cloudflare/wrangler.toml
   pnpm exec wrangler secret put UCLOUD_TOKEN --config cloudflare/wrangler.toml
   pnpm exec wrangler secret put ADMIN_KEY --config cloudflare/wrangler.toml
   pnpm exec wrangler secret put CONFIRM_SECRET --config cloudflare/wrangler.toml
   ```

   `.dev.vars` 只用于本地开发，不会自动成为线上 Secrets。[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

6. 先验证手机访问与服务到云邮的只读请求；再开启 `ENABLED`，保留 `ENABLE_SIGNING=false` 观察开课提醒。
7. 根据真实课堂校准 `OPEN_STATUSES`、`UNSIGNED_PATH` 和 `UNSIGNED_VALUES` 后，才开启 `ENABLE_SIGNING`。测试里的 `person.signed` 是模拟字段，不可当作真实配置。

已新增自动刷新逻辑，使用同次登录的 `UCLOUD_TOKEN`、`UCLOUD_REFRESH_TOKEN` 和 `SESSION_SECRET`，一次真实云端续期已成功。平台撤销会话或刷新失败时暂停监测，并限频发送 Bark 提醒；云端运行不意味着登录永久有效。更换确认签名密钥会使旧确认链接失效。调度与填写方式见 [SESSION_AUTOMATION.md](SESSION_AUTOMATION.md)。

管理接口均为鉴权 POST：`/api/admin/status` 查看运行状态、`/api/admin/monitor` 请求一轮监测、`/api/admin/test-bark` 发测试推送。Bearer 凭证为 `ADMIN_KEY`，接口不会返回云邮 token 或 Bark key。
