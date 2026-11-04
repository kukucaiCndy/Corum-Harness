# HANDOFF 2026-10-30b — 白屏真因已修（不是 dsh.client 字段）

> 上一份 `HANDOFF-2026-10-30-cdp-router-builtin.md` §2 的「根因」是**错的**。
> 本文件是更正 + 实测证据 + 已交付状态。下个 session 从这里开始。

---

## 1. 结论：白屏两个真因（都已修并实机验穿）

### 真因 A（致命，导致整页挂掉）：client 半有 `export default`

`src/client/index.tsx` 末尾写了 `export default apply`。cordis 的
`Loader.unwrapExports` 对 ESM 模块只取 `exports.default ?? exports`：

```js
// @deepseek-ai/cordis-plugin-loader/lib/index.js
unwrapExports(exports) {
  if (isNullable(exports)) return exports
  exports = exports.default ?? exports
  if (!exports.__esModule) return exports
  return exports.default ?? exports
}
```

一旦有 default 导出，**插件对象就是那个裸函数**，命名空间上的
`export const inject = [...]` 被整个丢掉 ⇒ fiber 的 inject 集合为空 ⇒
`ctx.slots` 抛 `cannot get property "slots" without inject` ⇒ 该 entry apply 失败 ⇒
web boot 的 `assertEntriesActive` 抛错 ⇒ 整页「Failed to load plugins」⇒
`[data-session-band]` 永不出现 ⇒ 主进程 30s 轮询超时 ⇒ 用户看到
「启动失败：主界面加载超时」。

安装态实测原文（/Applications/Corum.app + `--remote-debugging-port=9400` + CDP）：

```
body: "HARNESS / Failed to load plugins / @corum/corum-cdp-router
       failed to apply loader entry d1b748c0 (@corum/corum-cdp-router):
       cannot get property \"slots\" without inject"
[console.error] Error: failed to apply loader entry d1b748c0 … without inject
```

**判据**：`[data-session-band] === false` 且 `[data-dsh-boot] === true` 且
body 里出现 `Failed to load plugins` ⇒ 去 renderer console 找
`failed to apply loader entry`，**不要**去猜 host / 主密钥 / 打包闭包。

### 真因 B（面板 100% 不可用）：typert gateway 的 args 必须按形参名套一层

面板第一版调用 `rpc('cdpRouter','discoverTargets',{ scanPorts: true })`，网关报：

```
gateway/arguments-invalid: typert gateway: cdpRouter/discoverTargets:
args fields do not match the descriptor: unexpected "scanPorts"
```

typert 的 args 描述符是**按方法形参名**建的。本服务 9 个 RPC 的形参都是
`input: Record<string, unknown> | undefined` ⇒ 描述符里只有一个字段 `input`
⇒ 实参必须写 `{ input: { scanPorts: true } }`。

实测（同 token 在页面内打 `/api/<ns>/<method>`）：

| args | 结果 |
|---|---|
| `{}` | ok（不扫端口） |
| `{scanPorts:true}` | ✗ `unexpected "scanPorts"` |
| `{input:{scanPorts:true}}` | ✓ ok 且真扫了（853 ms，扫到 `discovered-9400`） |
| `{input:{bogus:1}}` | ok（`input` 是宽松对象，内部字段不校验） |

> **系统性坑**：本仓 `@Remote` 的惯例是**位置形参**（`corum-artgen`：
> `deleteModel(fileName: string)` ← 客户端传 `{fileName}`）。cdp-router 全部用
> 「一个 input 大对象」⇒ 外部调用方必须多套一层。后续建议把这 9 个方法改成位置
> 形参（**纯内部调用面不受影响**：Agent 工具是进程内直调
> `service['xxxRemote'](args)`，不走网关）。

### 上一份交接的两个「根因」为什么是错的

| 交接的说法 | 机制事实 |
|---|---|
| `dsh.client.inject` 缺 `@corum/corum-api-remotes` | `inject` 里的包名边只影响**模块到达顺序**；`arriveGraphRow` 对图里没有的包**静默跳过**（不报错）。而且本插件 client bundle 只 `require('react')` / `react/jsx-runtime`，压根没引用 api-remotes。 |
| `immediately: false` 应为 true | `immediately` 只喂 `prefetchImmediateTier()`（预取），`false` 只是不预取，不影响 apply 与渲染。已顺手改成 `true`（与三个兄弟插件一致），但它**不是**白屏原因。 |

---

## 2. 已交付（本轮实际改动）

`packages/plugins/agent/corum-cdp-router/`

- `src/client/index.tsx`
  - **删掉 `export default apply`**（真因 A）。
  - `export const inject = ['slots','connection']`（拿到 `connection` 才能发 RPC）。
  - `apply` 改为 `ctx.inject(['slots','connection'], cb)` 再注册面板（红线 4）。
  - 自造 `makeRpc(connection)`（三行，不 import `@corum/plugin-sdk/client`，
    避免把 `corum-ui-base` 样式链拉进 bundle —— 上一场的 §4.6 结论仍成立）。
  - 面板 `rpc` 由 section 的 `inject: () => ({ rpc })` 下发（壳只下发 `{close}`，
    原来从 props 取 `rpc` 恒为 `undefined`）。
  - `discoverTargets` 实参改成 `{ input: { scanPorts: true } }`（真因 B）。
- `package.json`：`dsh.client.immediately` `false → true`。

产物 & 环境：

```
packages/desktop/dist/mac-arm64/Corum.app        重打包完成（两轮，exit 0）
packages/desktop/dist/Corum-0.7.0-arm64.dmg     同批产物
/Applications/Corum.app                          已装最新构建（ditto + xattr -cr，未重签名）
```

---

## 3. 实机验穿（三层）

1. host：启动日志 `combo "coding" host ready`，无 `launch failed`。
2. 界面：CDP 读到 `[data-session-band] === true`、`[data-dsh-boot] === false`、
   body 为正常工作区列表；`Page.reload` 后 **0 条 console.error / exception**。
3. 功能：设置 › 扩展 › **CDP 目标** 打开即出真实数据：

```
配置文件：/Users/kukucai/.corum/cdp-targets.json（autoDiscover 已关）
已配置的目标（1）  rc3  127.0.0.1:9350  —  可用
发现的实例（1）    discovered-9400  9400  other  （旧基座，无 release 字段）  port-scan
诊断（3）          三个 run/*.pid 记录的端口不可达（实例已退出）
```

插件单测：`tests/discover.spec.ts` 30/30 通过。

---

## 4. 未做 / 下一步（按建议顺序）

1. **扩展包 ZIP 未重打**（`corum-dev-preset` 分支 `feat/cdp-target-router` @ `1637f9b`，
   `dist/corum-dev-1.9.0.zip` 不存在）；其「是否合入 main」仍待拍板。
2. **5 条 Agent 工具的端到端**（`cdp_discover_targets` → `cdp_evaluate`）未验：
   需要在一个活着的被测实例上跑（rc3 的 9350 现在已退出）。启动方式：
   `./scripts/corum-instance.sh start --home=verify` 之类，或手起一个带
   `--remote-debugging-port` 的旧版本实例。
3. **把 9 个 RPC 改成位置形参**（见 §1 的系统性坑），否则任何外部调用方都要
   `{input:{…}}` 这层套娃。
4. `corum-mcp-manager` 的 Windows flaky（上一份 §4.7）仍待单独 PR。
5. 单实例锁 UX：仍是「静默让位 + 界面显示主界面超时」，建议单独 PR 给明确提示。
6. `kkc-desktop` 旧工作树（本会话宿主就在这里）待清理。

---

## 5. 环境现状（下个 session 开工前核对）

| 实例 | 路径 | 端口 | 状态 |
|---|---|---|---|
| 本会话宿主 | `kkc-desktop/.../dist/mac-arm64/Corum.app` | — | 存活（**不要重启/kill 它**） |
| 新构建（已装） | `/Applications/Corum.app` | 61711（host）、9400（CDP 调试口） | **主界面正常** |

⚠️ 杀实例时**只杀 `/Applications/Corum.app`**：
`pkill -f "Corum.app/Contents/MacOS/Corum"` 会把**本会话宿主**（kkc-desktop 路径）一起杀掉，
上一份交接 §「装之前必须做的事」里那条命令在「宿主不是 /Applications」时是危险的。
用 `pkill -f "^/Applications/Corum.app"`。

⚠️ `/Applications` 的实例当前是**带 9400 调试口**启动的（我为了取证起的）。
正常使用可以直接从 Dock/LaunchServices 启动，不需要该参数。

⚠️ 装之前仍必须杀干净旧实例；装法仍是 `rm -rf` + `ditto` + `xattr -cr`，
**绝不要** `codesign --force --deep --sign -`。
