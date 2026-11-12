# 交接 · 2026-11-12 · issue 清账 + 候选集机制 + 排队图片两轮修

> 会话范围：2026-11-11 夜 → 2026-11-12 上午（跨夜，用户中途睡了一觉，醒来继续验收）。
> 起点 `dec0445c` 之前，终点 **`5b49dfdc`**（本文件提交后为新的 HEAD）。
> 产品仓 `main`：**0 个 open issue**；用例仓 `corum-dev-preset` main：`495f479`。
> 下个会话从这个文件开始读。

---

## §1 本场交付（按主题，全部已合入 main）

### ① issue 清账（16 个 open issue → 0 个）

| PR | 内容 | 关联 issue |
|---|---|---|
| #202 | 官方五模式显示名回退（`standard` → 标准模式）+ preset 目录启动自愈 | 报障：切 Agent 失败 / 模式显示英文 |
| #204 | 用户消息图片预览槽名改对（`conversation.chat.user.images`） | #201 |
| #205 | 审批卡进会话流 + 本会话「始终允许」的授权台账（connection 代际/会话列表清空） | #171 #172 |
| #206 | 指挥模式写工具按**名字**拒绝（注册时机无关） | #194 |
| #186 | 报告落盘到会话目录（`session-report-directory.ts`） | #167 |
| #187 | TODO 卡片展开箭头方向 | #125 |
| #188 / #189 | 归档删除 / 会话排序的回归网（适配当前契约） | #121 #122 |
| #156 系列 | 批量添加模型入口 | #149 |
| #208 | Linux 自动更新：按安装形态选资产 + **安装前**拒绝（deb 形态）+ 失败可诊断 | #151 缺陷一 |

### ② #166 子 Agent 模型失败处置（两批）

- **#207**：新增 `retry`（再试一次，不写任何状态）+ 临时档支持**指定模型**（host 校验候选路由，落不实要如实回落）。
- **#209**：删掉「永久跟随主模型」（`follow-main` 哨兵）——想跟随就在 permanent-route 里直接选主 Agent 那条路由；`decline` 改名 `cancel`（「取消本次委派」）。**语义边界**：只取消这一次派发，**不是**会话级禁用委派（`model-ask-run.ts` 注释与测试钉着）。

### ③ #165 子 Agent 候选模型集（四批，本场最大的一块）

- **#210**（第一步）：全局候选集 + 能力标注 `tags`/`note` + 机制段 `corum:subagent-model-candidates` + `list_subagent_models` 带标注 + 预设闸门 `modelSelectionSettings: true`。
- **#213**（第二步）：预设级 `childModelCandidates` 覆盖 —— 用户裁定优先级 **预设（开启且非空）> 全局（enabled）> 无候选（回到锁定面）**；设置入口 + 预设编辑页。
- **#218**（第一轮反馈）：**删掉独立设置入口**，全局候选并入「设置 → 智能体设置」；交互重做为「添加 → 从已配置的供应商模型里选 供应商/模型/思考程度 + 常用标签可点」；并就用户裁定**放开模型锁**（见 §3 决策 ①）。
- **#219**（第三轮反馈）：每行候选可勾 **「可给哪类子 Agent」（执行类 / 调研类）**，`routesForRole` 在 `install()` 收敛一次，喂给提示词段 / `list_subagent_models` / 白名单校验。

### ④ 两处用户实测 bug

- **#212**：子 Agent 通知被渲染成「You」气泡 → 新增 `TurnTriggerCard`（按持久化 `source.kind` 分流：`agent-message` / `subagent-settled` / `goal` / `schedule` / `webhook` …；用户自己的提交 `{kind:'user'}` 仍走气泡）。
- **#214**：删供应商最后一个模型时报 `llm-pi-ai: provider "mac" resolves no models…` → 真因是「删完留下一个空供应商」。裁定：**删最后一个模型 = 删整个供应商**（弹确认），`planModelDeletion` 对 0 剩余直接 `unset` 整节；**#214 后续**（`8323ee2c`）补了「删完自动回到供应商列表」。

### ⑤ #211 排队图片（两轮）

- **#215**（第一轮）：核实「图片其实没丢」——1261 份会话日志里带图入队 19 次（13 次真 busy），**19/19 都原样到达 `user/message`**；丢的是展示：`ChatView` 过滤 queued 回显 + `QueueDock` 只取 text 块 ⇒ 纯图片行是空白。修法：排队行画缩略图 + 占位，并（当时）禁用带附件行的编辑。
- **#220**（第二轮，用户实测后）：① 编辑**重新放开**，保存时把非文本块**原样带回**，host 的 `QUEUE_EDIT_NON_TEXT` 从「无条件拒绝非文本」放宽为「非文本块必须与队列里逐字相同」；② **撤回连图一起回**（`restoreDraft` → `restoreDraftAttachment`：durable 引用取字节→`File`→`createDrafts`）；③ 那句「附件与图片无法随文本回填，已从队列中一并移除」是假话 → 删除，换成「有 N 个附件没恢复」；顺带修掉 **info 提示常驻无关闭**（关闭按钮 + 8 秒自动消失）。

### ⑥ #151 缺陷二（deb 启动即退）

- **#216**：根因 = electron-builder 默认 `postinst` 判「**root** 能不能建用户命名空间」（恒真）⇒ 永远 `chmod 0755`；而 Ubuntu 23.10+ 的 `kernel.apparmor_restrict_unprivileged_userns=1` 让**普通用户**用不了 namespace 沙箱 ⇒ Electron 必须靠 setuid。
  修法 = `scripts/deb-after-install.sh` 挂 **`build.deb.afterInstall`**（⚠️ `deb` 键不能写在 `build.linux` 下，electron-builder 25 会 `ValidationError`）。

### ⑦ 工具/基础设施

- **#217**：冲烟脚本收尾引用已删除的 `reap` 变量 → 会在**全绿之后**抛 `ReferenceError` 把 `result.json` 与退出码一起吞掉。
- **corum-dev-preset** 三笔：`c3d8666`（登记 8 条新用例 + D3 改成会话流语义）、`f378846`（E27 删最后模型 / B40 排队图片）、`f5c15df`（修 `run-log` 时区断言，本地 00:00–08:00 必红）、`495f479`（B40 跟着 #220 改成「带图也能编辑」）。

---

## §2 当前状态（可直接开工）

- 产品仓 `main` = **`5b49dfdc`**，工作树干净，无未推送提交，无 stash，无残留 worktree。
- **open issue：0**。**open PR：2**（都是旧账，见 §5）。
- 远端只剩 3 个分支：`main` / `feat/default-session-directories`（#153）/ `fix/windows-validation-portability`（#185）。
- 打包产物：`packages/desktop/dist/mac-arm64/Corum.app`（09:01 打，含全部本场改动）+ 同名 zip；冲烟 **8 通过 / 0 失败 / 3 跳过**（跳过项都带原因：非 Linux 无需 bwrap、无 DISPLAY、未开 opt-in 回收）。
- Linux 真机（Ubuntu 24.04.4 / 192.168.1.87）：装的是当前 main 打出的 deb，**已回归通过**（INSTALL/BUILD/PACK 全 0，`chrome-sandbox` 4755，Xvfb 下窗口数 2 / 进程 9，CDP 断言 `#root` 挂载 + 22 个按钮 + **console 零错误**）。用户已决定**把这台机器改成 Windows**。

---

## §3 本场用户裁决（下个会话必须遵守）

1. **模型锁放开**（2026-11-12）：`modelSelectionEnabled`（用户开启候选集）时，委派工具 schema **声明** `provider` / `model` / `reasoning_effort` 三个参数；仍受候选白名单约束（列表外路由由 `preflightChildLlmRoute` 拒绝）。关闭候选集时行为与 2026-09-18 的模型锁完全一致。`model-policy.spec.ts` 已改成「条件展开」两条断言（开/关各一条）。
2. **候选集优先级**：预设 `childModelCandidates`（开启且非空）> 全局 `subagent-model-selection-settings`（enabled）> 无候选（回到按 preset 锁定的模型跑）。只影响**新会话**。
3. **候选适用角色**：每条候选可勾 worker（执行类）/ research（调研类），缺省 = 两类都可用；`routesForRole` 是唯一收敛点。
4. **删最后一个模型 = 删整个供应商**：绝不写空 suppliers；删完自动回列表。
5. **排队消息**：带附件也能编辑（只改文字、附件原样带回）；撤回要连图片一起回输入框；提示必须能关且自动过期。
6. **不要单独设置入口**：候选集放在「设置 → 智能体设置」，不进独立 nav 项（原本给它在 `settings.section` 单开了一页，用户明确否掉）。

---

## §4 未验证项（照实列，别当成已验）

| 项 | 状态 | 怎么补 |
|---|---|---|
| **#211 排队图片三条**（改字不丢图 / 撤回连图回 / 提示可关） | ❌ 只有单测（52 条）与源码断言；探针实例**没有模型凭据**，起不出真实 busy 轮次 | 用一台带 Key 的实例：跑长任务 → busy 时发图 → ①改字保存看图是否还在 ②删除看输入框是否出现图；这同时是 CTS B40 的「人工核」两段 |
| 候选路由**端到端**（主 Agent 真按候选挑 + 带思考程度） | ❌ 只有 schema/条件展开断言与 `routesForRole` 单测 | 配一条候选、开开关，派一个子任务，看的 `agentOptions` 里是否带 `reasoningEffort` |
| `#151` 「旧版 deb → 新版 deb」完整升级序列 | ❌ 只验了直装（`postinst` 首装/升级同一条，机制等价） | 真机装旧版再 `dpkg -i` 新版 |
| CTS **E27 / B40** 实机跑 | ❌ 未跑（无 busy 前置 / 无模型密钥） | 有 Key 的实例上跑这两个 case，通过后可把 automation 从 manual 升 behavior |
| 全局候选组「保存后重启仍生效」 | ✅ 实机验过（刷新重进回填）；重启未单独验 | 重启一次复核 |

---

## §5 下个会话的起点建议

1. **Windows 真机**（用户正在切）：先把 **#185**（`fix/windows-validation-portability`）在真机上跑通——它是唯一一个卡在「没真机」的 PR。顺手把 #190 的 Windows 面（Windows 验证/安装）一起看。链路：`corum-win-verify` 技能（交叉打包 → SSH 部署 → 启动带 CDP → 隧道回 Mac 验）。
2. **#153**（默认独立会话目录与可迁移设置）：产品级特性，等用户点头再动。
3. **补 §4 的验证**：尤其 #211 那三条——它已经上线但没在真 busy 队列上验过，是当前最大的「已知未知」。
4. 需要重新开 Linux 验证时：`corum-linux-verify` 技能有从裸机 bootstrap 的完整步骤（`git clone → pnpm install → node scripts/build-all.mjs → pnpm --filter corum-desktop run pack:app:linux → dpkg -i → Xvfb + xwininfo/CDP 断言`），本场已完整走过一遍；注意**原生依赖必须在 Linux 上 install**，交叉打包不通。

---

## §6 环境与操作要点（本场踩过的）

- **Linux 真机必须经 SOCKS 代理**：直连 `192.168.1.87:22` 是 `No route to host`，要
  `ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:7890 %h %p' root@192.168.1.87`（`sshpass` 在 `/opt/homebrew/bin`）。机器上留着 `/root/ch` 完整 checkout 与已装 deb，**切 Windows 后这些都没了**。
- **探针实例**：`./scripts/corum-instance.sh start --home=/tmp/corum-x-home --port=9333`，用完 `stop --force` + `rm -rf`；别碰用户的 `:9222`。
- **渲染/UI 包必须三步构建**：`tsc -b && tsdown && corum-inline-css`（少一步样式会静默丢）。
- **package 级命令**：一律用包内 `node_modules/.bin/*`（`pnpm` 在本仓会因依赖检查强制重装）。`corum-dev-preset` 的 `plugins-src/corum-test-suite` 里 **vitest 是悬空软链**，用 `npx --yes vitest@5.0.3 run`。
- **跨 client 插件包不要做值 import**（tsdown 会内联成第二份闭包）；共享只能走 cordis service 或 `@corum/corum-ui-base/client`。
- **`docs/` 在 `.gitignore` 里，但历史文件是被跟踪的** ⇒ 新增交接文档要 `git add -f` 才会进仓。
- **electron-builder 配置键位**：`deb.afterInstall` 在**顶层 `build.deb`**，写进 `build.linux` 会 `ValidationError`（25.x）。
- **`simple-icons` 缺失**：官方 `dsh-client-ui-primitives` 的运行时产物 import 了未安装的 `simple-icons`，任何 import 它的 vitest 都要 `vi.mock` 掉（本场好几次踩，mock 列表要覆盖用到的图标名）。
- **冲烟**：`node scripts/corum-smoke.mjs --fast --launch --packaged`；`CORUM_SMOKE_REAP=1` 才是 opt-in 回收进程，否则会留下 app 进程要手动 `pkill`。

---

## §7 本场最贵的三条经验

1. **「用户看到的」和「机制里发生的」通常是两件事**（#211）：图没丢、队列没丢，丢的是**展示路径**（`ChatView` 过滤 + `QueueDock` 只读 text）。先拿会话日志/运行时数据证明「到底哪一层丢的」，再改 UI——否则会去修一个没坏的机制。
2. **判据要盯住「事故形态本身」**：删最后一个模型的事故形态是「写了一个空 `models`」，所以 `planModelDeletion` 的单测直接断言**不出现任何 `set …/models` op**；B40 同理，反向控制（纯文字行仍可编辑）是为了防「一律禁用」这种退化骗过判据。
3. **别用「禁用功能」当修复**（#215 → #220）：带附件禁用编辑确实防住了「图片被换成纯文本」，但用户立刻发现「我要改字」。正解是**允许操作 + 保住数据**（原样带走非文本块，host 只拒绝「换掉附件」），而不是把入口关掉。