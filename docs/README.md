# 文档导航

建议先读 [实现流程与源码导读](IMPLEMENTATION.md)，再打开对应模块。本文档目录完成整理于 2026-11-13。

| 文档 | 用途 | 阅读时注意 |
|---|---|---|
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | 当前实现的主流程、函数位置、状态机和接口地图 | 以源码与当前配置为依据 |
| [AUTOMATIC_SIGNING.md](AUTOMATIC_SIGNING.md) | 用户最新授权的自动签到模式与结果含义 | 自动模式已启用，真实结果与部署成功分开核对 |
| [PLUGIN_SIGNING_COMPARISON.md](PLUGIN_SIGNING_COMPARISON.md) | 原完整 Chrome 插件与云端签到协议对照 | 提交参数已复用；只读采样用于补齐监测字段 |
| [CLASS_TEST_2026-11-13.md](CLASS_TEST_2026-11-13.md) | 15:40 课堂测试准备与实际证据 | 准备、采样与真实提交分别记录 |
| [TIMETABLE_IMPORT.md](TIMETABLE_IMPORT.md) | 当前整学期课表来源、展开规则和调度方式 | 无明确节次课程未推测时间，调课需重新同步 |
| [CLOUDFLARE_BARK.md](CLOUDFLARE_BARK.md) | Workers、D1、Bark 初始化和部署操作 | 保留分阶段记录；当前已部署，已有资源不必重建 |
| [SESSION_AUTOMATION.md](SESSION_AUTOMATION.md) | 登录续期机制和客户端适配过程 | 开头为最新状态，后文部分是前阶段记录 |
| [DEPLOYMENT_2026-11-13.md](DEPLOYMENT_2026-11-13.md) | 版本、资源、实测与修复的历史证据 | 按版本阅读，不把早期关闭状态当成当前状态 |
| [BARK_LOCAL.md](BARK_LOCAL.md) | Chrome 扩展 + 本地中转原型 | 属于依赖 Mac 在线的另一条运行路径 |

当前主线源码在 `cloudflare/`，手机页面位于 `relay/web/`，公共校验位于 `public/monitor/core.js`。实际学校令牌和个人课表在被 Git 忽略的本地配置文件中。
