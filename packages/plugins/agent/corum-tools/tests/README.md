# corum-tools/tests —— 官方 dsh-tools 测试套件的**版本匹配**移植

## 为什么要这份说明

`@corum/corum-tools` 是官方 `@deepseek-ai/dsh-tools` 的**整包 fork**（唯一增量见包
`package.json` 的描述：`errorMessage` 对「无 string message 的普通对象」改走 `JSON.stringify`）。
fork 时官方那套测试**没有被搬过来**，而这个包的 `package.json` 一直写着 `"test": "vitest run"`
⇒ 仓库门禁 `pnpm -r --if-present run test` 在这个包上直接
`No test files found, exiting with code 1` ⇒ **整个递归测试中止**（后面所有包都不跑）。
结果就是：**每个 PR 的门禁都是红的**，而红的原因与被测内容无关。

## 移植来源（**关键：必须是版本匹配的那个 tag**）

| 项 | 值 |
|---|---|
| 来源仓 | `/Users/kukucai/dsh`（官方 checkout） |
| **来源 tag** | **`dsh-v0.1.5-rc.3`** |
| 来源路径 | `packages/core/tools/tests/` |

⚠️ **不要用官方 checkout 的工作树**：它当前是 `0.1.7-rc.2`，而本 fork 跟踪 `0.1.5-rc.3`。
用工作树取测试会得到一批**版本错配**的假红（并且诱使人去改测试迎合，那是伪造）。

判据（本目录搬迁时实测，可复现）：把 fork 的 `src/` 与 tag 那版逐文件 sha256 对比，
**10 个模块里 9 个逐字节相同**，唯一差异是 `index.ts`（= 上表那处 fork 增量）：

```bash
cd /Users/kukucai/dsh
for f in index invariant json-schema presentation ptc py-types schema ts-types types testing; do
  git show dsh-v0.1.5-rc.3:packages/core/tools/src/$f.ts | shasum -a 256 | cut -c1-16
done
# 与本仓 packages/plugins/agent/corum-tools/src/$f.ts 的同法结果对照
```

⇒ 所以这套测试是**对着同一份源码**跑的，除 `index.ts` 那一处。

## 搬来了 11 个、**没搬** 1 个

搬来（内容与 tag 逐字节一致，用 `git show … | shasum` 对照过）：

```
execution-mode.spec.ts        execution-signal-types.spec.ts
invariant.spec.ts             json-schema.spec.ts
properties.spec.ts            ptc.spec.ts
py-types.spec.ts              schema.spec.ts
scoped.spec.ts                tools.spec.ts
ts-types.spec.ts
```

**没搬 `gen-tool-catalog.spec.ts`**：它测的对象是**官方仓库根部的 `scripts/gen-tool-catalog.ts`**
（spec 里 `import … from '../../../../scripts/gen-tool-catalog.ts'`），而本仓**没有这个脚本**
（`ls scripts/gen-tool-catalog.ts` 不存在、全仓 grep 无引用）——那是官方仓自己的工具目录生成器，
与本 fork 的被测面（工具注册/执行管线）无关。要搬它得先把官方那个脚本连同它的输入约定一起搬来，
属于另一件事。**这一条是唯一的覆盖缺口**，其余 spec 全部照搬。

## 依赖

`package.json` 的 devDependencies 里，为这套测试新补了两个（其余早已在）：
`fast-check`（`properties.spec.ts` 的属性测试，官方用 `^4.8.0`）与
`@deepseek-ai/dsh-agent-loop`（若干 spec 构造 agent 循环，同族包一律写 `^0.1.5-rc.3`，
根 `pnpm-workspace.yaml` 的 overrides 会把它钉到 `0.1.5-rc.3`）。

## 与 fork 增量冲突时怎么办

若某条断言失败且原因**确实**是 `index.ts` 那处增量（它编码的是官方旧行为），
正确做法是：更新该断言 + 就地写注释说明「官方如此 / 本 fork 为何不同」并指回
`docs/fork-delta.md` 与本包 `package.json` 的描述。
若失败原因是**版本错配 / 缺包 / 官方专有工具**，必须停下如实报告，**不许**改测试迎合。

升级 runbook：官方 `dsh-tools` 升级时，按 `docs/fork-delta.md` §5 第 3 步三方合并本 fork 的
`index.ts`，并把测试**同步换到新 tag 的那一版**（`git show <新 tag>:packages/core/tools/tests/…`）。
