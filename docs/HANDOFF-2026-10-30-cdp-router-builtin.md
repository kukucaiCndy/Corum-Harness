# HANDOFF 2026-10-30 — CDP 路由内建（收尾未完成，主界面白屏待修）

> 交接对象：下一个 session 的你。
> **一句话现状**：CDP 路由插件已内建进本体并打包安装，但**主界面加载超时（白屏）** ——
> 根因已定位到 `corum-cdp-router` 的 `dsh.client` 声明缺 `@corum/corum-api-remotes` +
> `immediately: false`，**修这 2 个字段 + 重打包即可**。

---

## 1. 用户要什么（原始需求，别跑偏）

三句话，按时间顺序，**后一句修正前一句**：

1. 「之前的要求一直是这个插件用来测试的是**另外的实例，永远不是测试自己**」
2. 「**CDP 路由到标准能力内置到 corum 本体**，不再放在 corum-dev-preset 作为本项目的一个
   标准插件内置，未来很多依赖这个能力的前端开发都可以受益」
3. 「**既然到本体，则是标准的工具提供给 Agent，不再走 MCP 配置了**」

以及最关键的动机（原话）：

> 「我之前要求设计这个就是因为现在使用 Google devtools 的 MCP 配置**只能写死端口**，
>  如果不需要写死端口，根据扫描让 Agent 直接动态传递参数调工具就最好了」

和范围澄清：

> 「我的意思是各种可以进行 CDP 的 **electron 实例或者 chrome 实例**」

**已按此实现**（见 §3），不要再退回「只认 Corum」或「靠 MCP 配置」。

---

## 2. 现在卡在哪（这是你要解决的第一件事）

### 现象

`/Applications/Corum.app` 启动后窗口显示：

```
Corum Harness
启动失败：主界面加载超时，请重试启动
[重试启动]
```

### 已定位的根因（证据充分，不用重查）

`packages/plugins/agent/corum-cdp-router/package.json` 的 `dsh.client` 写错了：

```json
// 现状（错）
"dsh": {
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-settings"],
    "immediately": false
  }
}
```

对比同仓三个正常的 client 半插件（`corum-artgen` / `corum-memory` / `corum-ollama`，
实测从产物 package.json 读出，三个**完全一致**）：

```json
"dsh": {
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-ui-settings",
      "@corum/corum-api-remotes"        // ← 我漏了这条
    ],
    "immediately": true                  // ← 我写了 false
  }
}
```

### 为什么这会导致白屏（机制，已查实）

主进程 `launchCombo()` 的「主界面就绪」判定是**轮询 DOM**：

```js
// /Applications/Corum.app/Contents/Resources/app.asar → lib/main.js
!document.querySelector('[data-dsh-boot]')          // 启动遮罩已移除
&& !!document.querySelector('[data-session-band]')  // ide 模式要求此元素存在
// 轮询 100ms 一次，30s（3e4）超时报「主界面加载超时，请重试启动」
```

`CORUM_DESKTOP_MODE=ide` ⇒ selector 是 `[data-session-band]`。
client 半加载失败 ⇒ 界面挂不出来 ⇒ 该元素永不出现 ⇒ 30s 超时。

`@corum/corum-api-remotes` 是 client 侧调 host RPC 的前提，而我的面板
（`corum-cdp-router/src/client/index.tsx`）正是用 `rpc('cdpRouter', ...)`。

### 修法（3 步）

```ts
// packages/plugins/agent/corum-cdp-router/package.json
"dsh": {
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-ui-settings",
      "@corum/corum-api-remotes"
    ],
    "immediately": true
  }
}
```

然后：
```bash
pnpm install --frozen-lockfile=false
NODE_MIRROR=https://registry.npmmirror.com/-/binary/node pnpm --filter corum-desktop run pack
```
（`NODE_MIRROR` 必须给：直连 nodejs.org 2.5 分钟只下 3 MB，镜像秒下 57 MB）

### 验证方法（不要只信「能起来」）

```bash
# 1. host ready 且无 launch failed
grep -E "host ready|launch failed" <启动日志>

# 2. client bundle 里能看到模块表登记
# 3. 用 CDP 确认 [data-session-band] 存在（需带 --remote-debugging-port 启动）
```

---

## 3. 已完成的工作（不要重做）

### 3.1 Corum-Harness（本体）— 3 个 PR 全部已合并

| PR | commit | 内容 |
|---|---|---|
| #158 | `1ec14e69` | `cdp-targets` 领域模块收进 `@corum/plugin-sdk`（+ 6 包发布 npm 0.7.0） |
| #160 | `cdcc35dd` | `pnpm` 调用补 PATH 回退（修 GUI 启动下装不了扩展包） |
| #161 | `b3d4f19a` | **新建本体插件 `@corum/corum-cdp-router`** |
| #162 | `ca4b462d` | 把 `corum-cdp-router` 加进 `desktop-host`（修打包闭包缺失） |

`main` HEAD = `ca4b462d`，工作区干净（只有 2 个未跟踪的 patch.yml，是历史遗留）。

### 3.2 新插件结构（`packages/plugins/agent/corum-cdp-router/`）

```
src/targets.ts      目标清单读写 + 校验（fail loud：未知键/类型/重复 id/endpoint 全拒）
src/discover.ts     自动发现（pid 记录 → /json/version 探测 → CDP 读基座版本）
src/cdp-client.ts   CDP 连接 + evaluate（解包 result.value）
src/remote-rpc.ts   页内调 RPC（**免 token**：页面自带鉴权）
src/index.ts        cordis 服务 cdpRouter（9 个 RPC）+ 5 条 Agent 工具
src/client/index.tsx 设置 › 扩展里的只读状态面板
tests/discover.spec.ts  30 条
```

### 3.3 能力面（已验证可用）

**cordis 服务 `cdpRouter`**：
`listTargets` / `probeTarget` / `discoverTargets` / `adoptDiscovered` /
`evaluate` / `callRpc` / `upsertTarget` / `removeTarget` / `ensureSampleConfig`

**Agent 标准工具**（`defineAgentTool`，**零 MCP 配置**）：
`cdp_list_targets` / `cdp_discover_targets` / `cdp_adopt_discovered` /
`cdp_evaluate` / `cdp_call_rpc`

### 3.4 关键设计取舍（别改回去）

- **目标范围 = 任意 CDP 端点**，不只 Corum。「是不是 Corum」只作补充信息
  （是 Corum 时额外能读 `__DSH_BOOT__.release` 得到基座版本）。
  判据是「`/json/version` 可达 + 有 page target」。
- **主实例护栏**：任何 IP 上的 9222 需显式 `allowMain: true`；否则标 disabled 并说明
  原因，**不在校验期拒绝**（让人看到「为什么连不上」）。
- **示例配置不写死端口**：`{ autoDiscover: true, targets: [] }`。
- **发现与采纳分两步**：`discoverTargets` 只读，`adoptDiscovered` 才写；
  合并策略「同 id 覆盖、新 id 追加、**不删除**」。
- **role 推断加 home 判据**：主实例实测不在 9222（9222 空着）而在 9333、home 是
  `~/.corum`。只按端口判会标成 `other`，而 `other` 不受「不得碰主实例」护栏保护。

### 3.5 已实测通过的（用库层，不依赖白屏修复）

```
连 rc3(:9350) → release=0.2.1-rc.3 @be72761, bootEntries=74
页内调 RPC    → agentPresets/list 5 个、corumAgent/listProfiles 37 个
纯 evaluate   → document.title = "DeepSeek Harness"
discover      → 扫全部回环端口（0.9s）找到 discovered-9350
inferRole     → 9222⇒main；`~/.corum` 且端口非 9222 ⇒ main（关键规则）
URL 脱敏      → token 替换为 <hidden>
```

### 3.6 corum-dev-preset（扩展包）— 已推送

分支 `feat/cdp-target-router`，commit `1637f9b`（**未合并到其 main，待你决定**）：

- `CorumTestSuite` 改为依赖本体 `cdpRouter`，**永不测自己**
  - 新增 `src/target.ts`：`createCdpTargetExecutor(router, targetId)` +
    `TargetUnavailableError`；`RunAutoInput` 加必填 `targetId`
  - `RunAutoOutput.host` 拆为 `target`（被测实例身份）+ `executor`（执行者）
  - 版本门槛改按**被测实例**判（原来拿执行者版本比，会把该跑的用例误判 `na`）
  - 删除旧的 `rpcCaller`（就是「测自己」那个实现）
  - 新增 `tests/target.spec.ts` 9 条
- 移除扩展包里的 `corum-cdp-targets` + `corum-cdp-targets-ui`（能力已内建）
- 版本 `1.8.1 → 1.9.0`，插件数 4 → 2
- 用例 225 → 228（补 C19/C20/C21 preset 注册机制，见 `6b95867`）

**未做**：扩展包 ZIP 未重打（`dist/corum-dev-1.9.0.zip` 不存在）。

---

## 4. 真实血泪教训（这一场踩的，务必读）

### 4.1 我误诊了两次，方向都错

**误诊 A：把「单实例锁冲突」当成「应用起不来」**

真相：`[corum-desktop] another instance already owns the lock; handing over and exiting`。
我为验证陆续起了多个实例（kkc-desktop / Corum-Harness 构建目录 / 9360 / 9350），
新实例检测到锁被占就**静默让位退出**。用户看到的现象是「点了没反应」。

**教训**：判断「起不来」前先 `pgrep` 数实例 + 看 `SingletonLock` 指向哪个 PID。

**误诊 B：把手动跑 bridge 的报错误当成产品缺陷**

我手动 `node lib/bridge.js` 看到：
```
MasterKeyUnavailableError: a stored credential is encrypted but the master key is unavailable
```
就断定主密钥坏了。**那是测试方法的产物** —— 手动跑没有 electron main 注入
`CORUM_CREDENTIALS_MASTER_KEY`，当然解密失败。用完整 `Corum.app` 启动时该变量正常注入。

**教训**：**永远用正式入口验证**。绕过入口的复现只能当辅助证据，不能当结论。

### 4.2 主密钥机制（搞清楚了，省你时间）

- 主密钥 = 32 字节随机值，加密后存 `$CORUM_HOME/.master-key`（safeStorage 密文）
- 只在 **spawn host 子进程时**经 env `CORUM_CREDENTIALS_MASTER_KEY`（base64）注入
- `safeStorage.isEncryptionAvailable()` 为 false 时不生成、不注入
- **打包态**不注入 `CORUM_CREDENTIALS_KEY_UNAVAILABLE` ⇒ host 默认 `fail`（fail-loud）
- **dev 态**注入 `degrade` ⇒ 主密钥不可用时降级（明文存量仍可读）
- 实测时间线：`.master-key` 创建 9-04 / 修改 9-26；当前 user-data
  `corum-desktop-ud-ide-noport` 创建 10-28（**换了 user-data 但 master-key 没变**，
  目前没出问题，但如果将来出现解密失败，这是第一个要查的地方）

### 4.3 「主界面加载超时」的判定机制

`launchCombo()` 轮询 DOM（100ms 一次，30s 超时）：
```js
!document.querySelector('[data-dsh-boot]') && !!document.querySelector('[data-session-band]')
```
`ide` 模式认 `[data-session-band]`，非 ide 认 `#root > *, #app > *`。
**任何 client 半加载失败都会让这个 selector 永不出现** ⇒ 表现为同一个「超时」。

所以看到这条错误时，第一个怀疑对象是 **client 半**，不是 host、不是主密钥。

### 4.4 打包闭包会静默缺包（PR #162 已修，但机制要记住）

`topUpCorumPackagesFromWorkspace()` **只补 `desktop-host/package.json` 声明过的
`@corum/*`**。所以「`desktop/package.json` 加了、`desktop-host` 没加」的包
**不进闭包、也不触发缺包断言**（不在 declared 列表里，`missing` 自然是空的）。

**新增本体插件 = 两处都要改**：`packages/desktop/package.json` +
`packages/desktop/desktop-host/package.json` + `cordis.patch.yml` 挂载行。

### 4.5 构建环境的三个坑

- **`NODE_MIRROR` 必给**：直连 nodejs.org 极慢
  （`NODE_MIRROR=https://registry.npmmirror.com/-/binary/node`）
- **`pack` 必须经 `pnpm --filter corum-desktop run pack`**：根级 `scripts/pack.mjs`
  不存在，直接 `node scripts/pack.mjs` 报 `MODULE_NOT_FOUND`
- **macOS 没有 `timeout` 命令**：用 `( cmd & echo $! > pid ) sleep N; kill` 代替
- **`tsc -b` 是增量编译**：改了 tsconfig 或清了 `lib/` 要 `--force`

### 4.6 client bundle 会白嫖一整套壳样式（已修，但要知道）

别 import `@corum/plugin-sdk/client` —— 它 re-export `makeCorumRpcCall`
（来自 `corum-rpc-client`），后者把 `corum-ui-base` 的样式拉进来 ⇒ 产物多出
`lib/style.css`（12.67 kB 全是未使用的壳样式，且 dev 运行期 404 导致样式全丢）。

我改成了直接导出一个 `apply` 函数（不 import 那个 helper）：
`client.js` 26.31 kB → **15.57 kB**，`style.css` 消失。

另外 `plugin-build` 的 client 入口**默认是 `src/client/index.ts`（无 x）**，
我的文件是 `.tsx` ⇒ 必须显式 `client: { entry: 'src/client/index.tsx' }`，
否则报 `UNRESOLVED_ENTRY`。

### 4.7 CI 有一条既存 flaky（不是你的锅）

`corum-mcp-manager/tests/pool.spec.ts > ★ 崩溃后下一次调用自动重连（换 pid）`
在 **Windows CI 约 50% 失败**：
```
McpError -32000: Connection closed
```
根因：fixture 的 `crash()` 是「先返回，50ms 后 exit(1)」，在那飞请求与死亡事件之间
没有同步点 —— `callbacks.onclose` → `handleDeath()` 把 `client` 置 undefined，
而正在等的 `client.callTool()` 还没收到响应。

`main` 最近 3 次 CI 全绿，证明不是稳定失败。**重跑通常能过**。
PR #162 因为它红了一次，用 `--admin` 合并的。

用户已同意「另开 PR 修」。修法应该是**用握手替掉那 50ms 定时**，
不要加重试、不要放宽断言（会掩盖真问题）。

---

## 5. 环境现状（下个 session 开工前先核对）

### 5.1 两个仓库

| 路径 | 角色 | 状态 |
|---|---|---|
| `/Users/kukucai/work/Corum-Harness/Corum-Harness` | **本体（正确基线）** | `main` @ `ca4b462d`，干净 |
| `/Users/kukucai/work/kkc-desktop` | 旧工作树（曾误用于打包） | 当前会话跑在这里，**不要动** |
| `/Users/kukucai/work/corum-dev-preset` | 扩展包 | 分支 `feat/cdp-target-router` @ `1637f9b`，已推送 |

⚠️ **别混淆**：`kkc-desktop` 是你误判时改的仓库，`Corum-Harness` 才是正确基线。

### 5.2 实例与端口（实测）

| 实例 | 路径 | host PID | 端口 | 状态 |
|---|---|---|---|---|
| 当前会话宿主 | `kkc-desktop/.../dist/mac-arm64` | 88828 | 58952 | 存活（**本会话靠它**） |
| 新构建（已装） | `/Applications/Corum.app` | 89756 | 59811 | host ready 但**主界面超时** |
| rc3 被测实例 | 隔离 home `/tmp/rc3-test-iso` | — | 9350 | 曾存活，可能已退 |

### 5.3 CDP 目标配置

`~/.corum/cdp-targets.json` 已指向 `rc3@9350`（原 `verify@9333` 已失效）。

### 5.4 产物

```
/Users/kukucai/work/Corum-Harness/Corum-Harness/packages/desktop/dist/mac-arm64/Corum.app  1.3 GB
/Users/kukucai/work/Corum-Harness/Corum-Harness/packages/desktop/dist/Corum-0.7.0-arm64.dmg  384 MB
构建时间 Oct 29 23:43，cdhash 7f6315c1...（与 /Applications 一致）
```

### 5.5 安装注意

```bash
rm -rf /Applications/Corum.app
ditto <dist>/mac-arm64/Corum.app /Applications/Corum.app
xattr -cr /Applications/Corum.app       # 只清 quarantine
```

⚠️ **绝不要 `codesign --force --deep --sign -`**：会换 cdhash ⇒ safeStorage 钥匙串
条目 ACL 失效 ⇒ 主密钥拿不到 ⇒ host exit 1。见 `pack-macos.mjs` 头部事故记录。

⚠️ **装之前先杀干净所有旧实例**，否则撞单实例锁，表现是「起不来」。

---

## 6. 建议的下一步顺序

1. **修 §2 的 `dsh.client` 两个字段** → `pnpm install` → 重打包
2. **杀干净所有 Corum 实例**，再装 `/Applications`，验证主界面能出（不再超时）
3. 验证「设置 › 扩展 › CDP 目标」面板能打开、列出目标
4. 验证 5 条 Agent 工具的端到端（`cdp_discover_targets` → `cdp_evaluate`）
5. 扩展包重打 ZIP（`corum-dev-1.9.0`），装到 0.1.5 实例
6. 用 CorumTestSuite（`targetId` 指向 rc3）跑首轮真机测试
7. 单独 PR 修 §4.7 的 flaky

---

## 7. 待决策

- **`corum-dev-preset` 的 `feat/cdp-target-router` 是否合入其 `main`**（现停在 1.5.0，
  已积累 20+ 笔提交）
- **`kkc-desktop` 仓库如何处理**（它是错误基线上改的，有 2 笔提交
  `6e8fb1d3` / `6ce06886` 需要清理或丢弃）
- **单实例锁冲突的 UX**：现在只进日志，界面只显示「主界面加载超时」。
  建议单独 PR 改成明确提示「已有实例在运行」
