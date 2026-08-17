# @corum/session-archive

corum Agent OS 桌面端的「会话日志归档」UI 插件（Web-only client 插件）：

- **保存日志到…**：注册到 `conversation.session.header.utilities` slot，点击调用 `window.corumDesktop.saveSessionLog(sessionId)`，通过原生保存对话框把会话日志 ZIP 写盘，并以 Modal 反馈保存路径 / 错误（取消则静默）。
- **导入会话日志**：注册到 `settings.general.item` slot，点击调用 `window.corumDesktop.importSessionLog()`，通过原生打开对话框（可多选）导入 ZIP 中的 session artifact，并展示 imported / skipped 列表。

两个入口都是桌面原生桥（不走 RPC），非桌面环境（`window.corumDesktop` 缺失）时导入按钮禁用并提示「仅桌面端可用」。

## 构建

```bash
pnpm --filter @corum/session-archive run build
```

产出 `lib/client.js`（CJS + `window.__ModuleLoader__.load({id, factory})` 包裹，id 为 `@corum/session-archive`）。
