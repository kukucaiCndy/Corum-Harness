# corum Agent OS

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 底座构建的**插件发行版**：一套符合我设计哲学的 Agent 系统（context、UI、agent、workflow），外加一个 Electron 桌面承载层。

> 定位类比：DeepSeek Harness 是「Linux 内核」（Cordis + agent-loop + capability seam），本项目是「发行版」（桌面环境 + 插件 + 默认配置）。**不改内核，只做用户空间。**

## 项目目标：自由插件式 GUI

corum Agent OS 的 GUI 是一个**自由组合的插件式工作台**——用户可以像搭积木一样自由编排界面：

- **壳只定义区域几何与槽位注册表**，不含任何业务内容。槽位是运行时动态注册的（非硬编码），任何插件都可以注册新槽位。
- **凡是有 UI 的插件都能插入界面**。dsh 底座通过 `package.json` 的 `dsh.client` 字段 + `exports["./client"]` 判定插件是否有 UI——扫描加载图的 `ClientModuleRegistry` entries 即可发现所有有 UI 的插件。
- **插件的功能和 UI 可以统一在一个包里**（dsh 称为"双面包" dual-face package）。一个 `apply()` 注册 host 端能力（tools/commands/settings），同时 `dsh.client` 声明 + `exports["./client"]` 提供 UI bundle——这是常规模式而非例外。
- **用户自由编排**：拖窗格标题栏四边 split、中心 swap、拖出窗口脱出为浮动窗；sash 拖拽调宽；关闭/恢复区域；布局持久化到 localStorage。（原状态栏「添加区域」入口已随底部状态栏一并移除。）

## 设计哲学：区域组合 = 工作流 = Agent 团队

corum Agent OS 的终极愿景是让 **UI 区域组合、工作流、Agent 团队** 三者统一：

- **不同的工作区域组合 = 不同的工作流**。一个"编码工作流"可能是编辑器 + 文件树 + 终端 + 对话区；一个"设计工作流"可能是设计稿面板 + 对话区 + 资源管理器；一个"调试工作流"可能是终端 + 日志面板 + 编辑器 + 对话区。用户自由拖拽组合，存为「Combo」布局预设。
- **不同的工作流配合不同的 Agent 团队**。每个 Combo 绑定一个 Agent preset（如 designer preset 绑定 Pencil MCP），切换 Combo 即切换整个工作上下文：界面布局 + Agent 团队 + MCP 工具集。
- **插件即区域，区域即能力**。添加一个插件 = 添加一个 UI 区域 = 扩展一个能力维度。用户不需要理解"插件"这个技术概念，只需要看到"我有哪些区域可以放到工作台上"。
- **未来愿景**：扫描到有 `dsh.client` 声明的官方/社区插件，自动出现在「添加区域」面板里，用户拖入即用——无需改壳代码、无需 overlay 配置。Combo 预设可分享、可导入导出。

## 插件收录原则

- **复用为主**：不忌讳使用官方和社区的现成插件，能满足的就不自建。
- **差异化才自建**：只有当官方/社区插件不满足设计哲学时，才自行实现，归入 `packages/plugins/` 对应分组目录。
- **命名随意**：自己写的插件起什么名都行，不加前缀，按功能归组即可。

## 目录契约

```
packages/
├── shell/            # 承载层（Electron 壳 + 宿主桥 + IPC + 协议 + 打包）——基础设施
└── plugins/          # 插件（自建的、差异化的能力收纳于此，按功能分组）
    └── ui/           # 桌面 UI 能力（当前重点：换肤等可视化）
profile/
└── corum/              # 发行版 profile（dsh.profile 清单）
cordis.patch.yml      # 发行版 overlay（disable 官方行 + insert 插件行）
```

## 依赖边界（守住红线）

- **官方底座**（`@deepseek-ai/dsh-*`、`@deepseek-ai/cordis`）一律从 **npm registry** 引用，不 fork、不 vendored、不改源码。
- **不改** vendored cordis、agent-loop 核心驱动、capability seam 协议。
- **所有定制**通过「写插件 + overlay 覆盖默认行」完成。

## 快速开始

```sh
pnpm install
pnpm --filter corum-shell run start      # 开发期跑桌面壳
pnpm --filter corum-shell run pack       # 打包 .app/.dmg
```

## 插件开发约定

每个插件包是标准的 `dsh.client`（UI）或 `dsh.bundle`（配置层）/ Service Provider。新增一个插件 = 在对应分组下建包 + 在 `cordis.patch.yml` 加一行。详见 `docs/plugin-template.md`。
