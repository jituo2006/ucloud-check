# 云邮提醒部署记录

用户再次明确要求开启并尝试自动签到后的当前版本：`96f27850-0e22-49be-b1ee-35acd1bad94c`。`ENABLE_ATTENDANCE_MONITOR=true`、`ENABLE_SIGNING=true`、`AUTO_SIGN=true`、`SIGNING_PROTOCOL=plugin`，独立采样关闭。49 项模拟测试通过，原插件兼容的自动流程已部署，实际记录通过管理状态和 Bark 结果核对。此选择取代下文此前“只提醒”的阶段配置。见 [AUTOMATIC_SIGNING.md](AUTOMATIC_SIGNING.md)。

当前最终配置版本：`cc9bda52-2ed5-460c-be49-8171125be1a2`。用户要求仅保留开课 Bark 提醒，签到测试另行安排，因此 `ENABLE_ATTENDANCE_MONITOR=false`、`ENABLE_ATTENDANCE_PROBE=false`、`ENABLE_SIGNING=false`。`ENABLED=true`，课表调度、自动续期和课堂开启提醒继续运行。本轮准备过程见 [CLASS_TEST_2026-11-13.md](CLASS_TEST_2026-11-13.md)。

15:40 课堂测试准备版本：`5bf47db5-ac9a-46e3-9e90-65e90d29213a`。新增独立 `ENABLE_ATTENDANCE_MONITOR=true`，与提交开关分离；探针和监测共享基础接口查询，`ENABLE_SIGNING=false` 只限制提交。41 项模拟测试通过。

后续只读采样版本：`0929db60-7449-46b9-8856-d6dfcffef902`，已启用 `ENABLE_ATTENDANCE_PROBE=true`，调用原插件的基础签到查询自动采样字段；`ENABLE_SIGNING=false` 保持不提交。40 项模拟测试通过。对照说明见 [PLUGIN_SIGNING_COMPARISON.md](PLUGIN_SIGNING_COMPARISON.md)。

最新版本：`fc672eea-f0ca-46de-944b-c395e8bd92fa`，已将总时段改为 07:00–21:00，导入 `2026-2027-1` 学期 172 个上课时段，并改用课表驱动监测。见 [TIMETABLE_IMPORT.md](TIMETABLE_IMPORT.md)。

日期：2026-11-13（Asia/Shanghai）。

## 当前线上资源

- Worker：`ucloud-check`
- HTTPS： https://ucloud-check.studyhub-lab-7c42.workers.dev
- 确认页： https://ucloud-check.studyhub-lab-7c42.workers.dev/confirm
- 最终部署版本：`e6c041f9-086e-42df-a374-fdb325ff1ada`
- D1：`ucloud-check`，ID `f18e47d1-df29-4515-9545-e1042a7f4c86`，已应用 `0001.sql`。
- Cron：`* * * * *`。因 `ENABLED=false`，当前触发后直接返回，不查询云邮。
- `ENABLE_SIGNING=false`；开放状态和个人未签到字段尚未校准。
- Secrets 已上传：`ADMIN_KEY`、`CONFIRM_SECRET`、`BARK_DEVICE_KEY`。
- `UCLOUD_TOKEN` 未填写、未上传。没有开通或更改付费套餐。

## 验证结果

- 24 项自动测试全部通过；不调用真实云邮或提交真实签到。
- 本次修改的 `cloudflare/worker.mjs` 和 `tests/cloudflare.test.mjs` 按仓库对应 ESLint 规则检查，0 错误、0 警告；完整 `lint:monitor` 因既有依赖文件读取停滞而终止，未宣称本轮完整 lint 通过。
- `/health`、`/confirm`、`/app.js`、`/style.css` 均返回 HTTP 200，带 `Referrer-Policy: no-referrer`。
- 未鉴权 `/api/admin/status` 返回 401；鉴权后返回 200 和 `{"enabled":false,"status":null}`，确认 D1 可用。
- 本机 `pnpm bark:test` 被 Bark 接受，用户确认收到“云邮提醒测试”。
- 云端 `/api/admin/test-bark` 返回 200 和 `{"ok":true}`，用户确认收到“云邮提醒已连接”。这条通知由 Cloudflare 请求 Bark，不依赖 Mac 执行推送。
- 密钥文件 `cloudflare/.dev.vars` 被 Git 忽略，密钥未写入本记录或源码。

## 部署时修复

初次云端 Bark 调用返回 502。Cloudflare Workers 不支持 `redirect: 'error'`，与 Node 测试环境不同。将云邮和 Bark 请求改为 `redirect: 'manual'`；现有非 2xx 检查会拒绝重定向，避免向重定向目标发送凭据。新增运行时契约和 302 拒绝回归测试后重新发布，云端推送成功。

依据：[Cloudflare Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/)。

本地既有 Wrangler 依赖读取缓慢，部署使用同版本 `4.158.0` 的临时工具 `/tmp/ucloud-deploy-tools-20261113/node_modules/wrangler/bin/wrangler.js`。临时工具不应作为长期运维路径，正常环境使用仓库的 `pnpm exec wrangler`。

## 后续更新

同日已发布版本 `6731d8ce-87f6-4a22-8716-8f7557eb2413`（后续使用临时 Wrangler 4.161.0）：新增加密持久化的令牌刷新、白天每半小时/课前每分钟调度。共 30 项模拟测试通过。新增 Secret `SESSION_SECRET` 已上传，真实两个学校令牌仍为空，两个启用开关保持 false。详见 [SESSION_AUTOMATION.md](SESSION_AUTOMATION.md)。上文版本及验证描述保留为首次部署记录。

## 尚未完成的业务接入

最新进展：学校令牌已上传，生产版本 `96e8584f-3c1b-41fa-ad79-a3d4302d43b3` 已启用只读监测。门户客户端刷新实际返回成功，身份一致；随后监测返回 `ok=true, courseCount=19, activeClasses=0, signingReady=false`。33 项模拟测试和本轮修改的 ESLint 检查通过。课表窗口及真实签到字段仍未配置，签到提交仍关闭。以下首次接入清单中的第 1 步和第 2 步已完成。

1. 在本地配置中填入本人的 `UCLOUD_TOKEN`，通过 Cloudflare Secret 上传；不要写入 `wrangler.toml`、聊天或 Git。
2. 验证云端到云邮的本人身份、课程和课堂只读查询，再开启课堂提醒。
3. 在真实课堂核实签到活动状态、有效期和个人未签到字段，之后才启用手机显式确认功能。
4. 当前没有自动刷新登录会话；会话过期后需要更新。

当前部署成功不等于课堂提醒或签到业务已启用。手机实际网络访问确认页仍需验证；本轮仅确认了云端推送送达 iPhone。
