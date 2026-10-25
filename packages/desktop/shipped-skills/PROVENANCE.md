# shipped-skills — 随包分发的通用技能

本目录只收录**通用开发技能**，不内置开发 Corum 或 dsh 自身的技能。
打包时由 `packages/desktop/scripts/pack-macos.mjs` staging 到 host 运行时旁的
`<runtime>/shipped-skills/`；用户通过「设置 → 技能 → 导入内置技能」显式导入。

## 当前收录

| 技能 | 用途 | 来源 |
| --- | --- | --- |
| `record-browser-gif` | 通用浏览器录屏与 GIF 制作 | dsh 官方技能 |

Corum/dsh 项目专属技能统一由 `corum-dev-preset` 扩展包维护、分发和升级，
不再在本目录或本仓 `skills/` 留镜像。历史 dsh 技能按其专属机制是否适用于
Corum 分别迁移、重写、蒸馏或淘汰；决策与现行技能清单见该扩展包。

## 机制不变

`@corum/corum-skill-manager` 继续负责扫描和导入，应用启动期不写用户 home。
经典布局与历史 `shipped-modules/<module>/skills/` 布局均兼容；导入遵循
「已存在不覆盖、用户删过的不复活」。模块扫描兼容不代表仍会内置 corum-dev。

## 维护

新增通用技能时，将其目录放入本目录，剔除 `.versions/`、`skill-versions.json`、
`.git/`、`node_modules/`、`.DS_Store` 和构建产物，并同步
`corum-skill-manager/scripts/check-shipped-skills.mjs` 的 `EXPECTED`。
判断标准是技能对一般开发任务是否有用，而非它是否在 dsh 官方仓中存在。

```bash
pnpm --filter @corum/corum-skill-manager run build
pnpm --filter @corum/corum-skill-manager run check:shipped-skills
```
