# corum Agent OS

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 底座构建的**插件发行版**：一套符合我设计哲学的 Agent 系统（context、UI、agent、workflow），外加一个 Electron 桌面承载层。

> 定位类比：DeepSeek Harness 是「Linux 内核」（Cordis + agent-loop + capability seam），本项目是「发行版」（桌面环境 + 插件 + 默认配置）。**不改内核，只做用户空间。**

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
