# kkc-desktop 项目规则（每次对话必加载）

## 项目定位

kkc-desktop（corum）是基于 DeepSeek Harness（dsh）fork 的桌面 IDE。壳层（shell）+ 插件（plugins）架构，大量 UI/能力是从官方 dsh 包 fork 后定制的（包名前缀 `@corum/*`），通过 `cordis.patch.yml` / `cordis.ide.patch.yml` 以 patch 层叠加替换官方实现。

## 参考源码地址

- **官方 dsh 源码（本地参考）**：`/Users/kukucai/dsh`
  - 这是 corum fork 的上游官方实现。遇到「参考官方实现」「对照官方逻辑」时，到该目录查找对应包的源码（`packages/` 下按领域分目录：client / host / llm / interaction / api / boot / bundle 等）。
  - 注意：本机 `node_modules` 里没有官方 `dsh-client-*` 的实体包，**官方源码以 `/Users/kukucai/dsh` 为准**，不要在本仓库 node_modules 里找。
- 用户记忆中的路径是 `/Users/kkc/dsh`，实际路径为 `/Users/kukucai/dsh`（注意是 `kukucai`，不是 `kkc`）。

## 关键架构事实

- **桌面 home**：`~/.corum-shell`（`CORUM_HOME` 可覆盖），插件启停持久化在 `~/.corum-shell/plugins.disabled.json`。
- **插件中心**：`packages/shell/src/host/plugin-manager.ts` 提供 list/setEnabled/install/uninstall；`@corum/*` 默认归类为可启停的 plugin，运行时基元归 runtime（只读）。
- **基础能力不可关闭**：`plugin-manager.ts` 中 `CORE_PLUGIN_PACKAGES` / `CORE_PLUGIN_ENTRIES` 白名单内的插件（当前：`@corum/ui-model-selection`）不可停用/卸载，boot 时会过滤其禁用残留。
- **模块加载**：fork 插件的浏览器半端是「闭包工厂」bundle，经 `window.__ModuleLoader__.load({id, factory})` 注册，`dsh.client` 声明的包才进 `__DSH_BOOT__` 图。**改完插件源码必须 `pnpm build` 并重启桌面应用**才生效（bundle rev 以内容 hash 为缓存键）。
- **浮层**：composer 卡片有 `backdrop-filter`，会建立 `position:fixed` 的新包含块。需要真正飞出卡片的浮层用 `createPortal(..., document.body)`；仓库通用浮层出口是 `packages/plugins/ui/shell-base/src/client/FloatingLayer.tsx`。

## 构建与验证

- 插件构建：`pnpm --filter <pkg> build`（`tsc -b && tsdown && node scripts/inline-css.mjs`）。
- 桌面模式：`minimal`（默认）/ `ide`（`CORUM_DESKTOP_MODE=ide`，挂载 IDE-shell 覆盖层）。启动日志看 `[corum-shell] desktop mode: ...`。

## Git 提交规范（可回溯）

**每次修改都要提交 git，做到可回溯。**

- 完成一个逻辑改动后立即提交，不要把多个不相关改动堆在一个提交里。
- commit message 用中文，遵循「类型: 简述」格式，说明"为什么"而非仅"是什么"，例如：
  - `fix: 修复模型选择器 hover 二级菜单被 backdrop-filter 包含块裁切`
  - `feat: 收录模型选择器为 corum 基础能力不可关闭`
- 不提交构建产物（`lib/`、`dist/`、`.tsbuildinfo` 等），除非该仓库本就跟踪它们。
- 提交前确认不混入 `.env`、凭证等敏感文件。
- 未经用户明确要求，不执行 `git push`、不 force push、不改 git config。
