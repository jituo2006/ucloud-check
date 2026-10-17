# UCloud Check

～～BYR辅助签到～～

## 功能

- 查看课程列表及当前进行中的课堂。
- 通过课程卡片完成课堂回应。
- 根据课堂标识生成定时刷新的二维码。
- 读取已登录会话，支持手动设置令牌及实验性账号登录。

## 构建与安装

需要 Node.js 20.19+ 或 22.12+，以及 pnpm。

```bash
pnpm install --frozen-lockfile
pnpm build
```

1. 在 Chrome 中打开 `chrome://extensions/`。
2. 开启右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择构建生成的 `dist` 目录。
4. 打开插件设置，登录 UCloud 后刷新状态；也可手动设置令牌。
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
