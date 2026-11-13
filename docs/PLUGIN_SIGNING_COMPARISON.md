# 原插件与云端签到流程对照

2026-11-13 核对的实际参考目录：`/Users/tuoji/Documents/Projects/ucloud-check-chrome`。这是原 Chrome 插件完整源码副本；本次只读参考，没有修改该目录。

## 可以直接复用的实现

原插件 `src/App.tsx` 的 `autoSign()` 从第 254 行开始：

```text
getCheckoutBasic(siteId, groupId)
  → 读取 response.data.data.attendanceBasicInfo.id
  → ID > 0 时 getAttendanceEncryptionParam()
  → 读取 response.data.data.data 作为 clockV2
  → sign(attendanceId, siteId, info.id, groupId, clockV2)
```

接口定义在原插件 `src/req.tsx`：

| 函数 | 接口和参数 | 云端对应 |
|---|---|---|
| `getGoingSite()`，第 39 行 | `POST /blade-chat/web/chat/myCourse?siteIds=...` | `worker.mjs` 的 `courses()` |
| `getCheckoutBasic()`，第 55 行 | `POST /ykt-site/attendancebasicinfo/basic`，`{siteId, groupId}` | `attendance()` 及只读采样 |
| `getAttendanceEncryptionParam()`，第 51 行 | `GET /ykt-site/common/v2/clock` | `execute()` 中读取 `clock.data` |
| `sign()`，第 62 行 | `POST /ykt-site/attendancedetailinfo/sign` | `execute()` |

原插件明确把 `groupId` 作为 `classLessonId` 传给 `sign()`。提交体包含 `attendanceDetailInfo: {attendanceId, siteId, userId, classLessonId}` 和 `qrCodeCreateTime`。云端使用的提交协议已经沿用这套实现。

这里不能把“已有提交协议”和“所有监测条件仍未知”混为一谈；提交方法不需要重新发明。

## 原插件未判断的内容

`autoSign()` 本身只检查用户存在、活动 ID 大于 0；不读取开放状态、截止时间和个人是否已签到。它由人点击按钮触发，人的操作提供了额外上下文。

云端主动生成提醒时，现有校验还要求开放状态、有效期、账号/课次一致和明确的本人未签到状态。原插件没有提供这些字段的取值映射，因此不能把源代码里没有的映射补成猜测值。

原插件 `sign(...).then(...)` 收到 HTTP 成功响应就显示成功；云端要求业务 `code=200` 才记为 `accepted`，仍把独立到课记录核验和请求被接受分开。

## 本次接入的只读采样

新增 `cloudflare/attendance-probe.mjs`，生产开关为：

```toml
ENABLE_ATTENDANCE_PROBE = "true"
ENABLE_ATTENDANCE_MONITOR = "true"
ENABLE_SIGNING = "false"
```

在课表规定的监测时间内发现本人进行中课堂后，调用与插件相同的 `attendancebasicinfo/basic`，保存最近的活动基础字段、候选状态/时间字段和响应字段结构。数组不展开，不保存教师/同学姓名、令牌或任意字符串值。样本最多保留最近十个课堂，管理状态接口鉴权后可查看。

采样分支不读取动态 clock、不创建签到确认、不提交签到。独立的 `ENABLE_ATTENDANCE_MONITOR` 在字段校准后可以生成签到提醒，`ENABLE_SIGNING` 只控制手机确认后的提交；采样与检测共享同一份基础查询，避免每轮重复请求。用途是在真实老师开启活动后自动取得接口证据，不再要求用户手工导出整份 HAR。当天下一节课为 15:40，课表检测自 15:30 开始；实际是否产生样本取决于老师是否开启云邮课堂。

采样结果用于确定已有云端校验配置，再启用本人确认路径。至此是采样准备完成，不能宣称真实签到已经验证成功。

## 验证

40 项模拟测试通过；新增测试验证采样会调用基础查询、保留所需状态字段、排除个人字符串和名册内容，同时不调用 clock、不创建签到提醒、不提交签到。新增和修改代码 ESLint 检查通过。生产版本和真实采样结果另见部署记录及管理状态。
