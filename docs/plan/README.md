# corum 规划文档（plan/）

> 本目录统一存放 corum 的**规划 / 技术方案**类文档（PLAN-*）。这些是「互相引用的规划体系」，不是重复内容。
> 命名已全部对齐到代码现状（`packages/desktop`、`@corum/corum-*`、`~/.corum`，见 `PLAN-rename-corum.md` 映射表）。

## 文档清单

| 文档 | 定位 | 引用关系 |
|---|---|---|
| [PLAN-ide-roadmap.md](./PLAN-ide-roadmap.md) | **IDE 实施路线图**（S0-S5 阶段：壳可行性 → Combo 启动器 → 功能插件 → 对话区重写 → 动效打磨） | 主线，引用 architecture + combo + code-editor |
| [PLAN-ide-architecture.md](./PLAN-ide-architecture.md) | **IDE 技术架构**（壳 + 槽位 + 功能插件 + 浮动窗） | 被 roadmap 引用；设计事实源指向 `doc/UXDesign/DESIGN.md` |
| [PLAN-combo.md](./PLAN-combo.md) | **Combo 设计规范**（壳层启动器 + 独立应用，进程级隔离） | 被 roadmap 引用 |
| [PLAN-code-editor.md](./PLAN-code-editor.md) | **Monaco 编辑器集成方案**（worker 加载 / 内联 / 协议） | 被 roadmap 引用 |
| [PLAN-rename-corum.md](./PLAN-rename-corum.md) | **全局重命名方案**（旧→新映射表 + 影响清单，已执行） | 命名对齐的唯一事实源 |

## 阅读顺序

1. 想看「要做什么、分几个阶段」→ `PLAN-ide-roadmap.md`
2. 想看「IDE 怎么搭起来的」→ `PLAN-ide-architecture.md`
3. 想看「Combo / 多工作台机制」→ `PLAN-combo.md`
4. 想看「编辑器（Monaco）怎么集成」→ `PLAN-code-editor.md`
5. 想查「某个包/路径改名前叫什么」→ `PLAN-rename-corum.md`

## 相关文档（目录外）

- 设计规范 / 组件 / 布局 / 动效 / 设置中心：`doc/UXDesign/DESIGN.md`（唯一权威设计文档）
- 设置中心需求：`docs/prd/settings-prd.md`
- 项目规则（架构事实 / 依赖 / 调试 / 打包 / 命名）：`.trae/rules/project.md`
