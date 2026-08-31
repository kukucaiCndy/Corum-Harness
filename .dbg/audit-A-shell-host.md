# 子 Agent A 报告：Electron 壳 + host 承载层（已收）

成熟度高于平均：三层边界清晰，0.1.2 换 loopback webserver 后攻击面收敛干净，preload 仅 11 个白名单方法，协议层只读静态 scheme。boot 层序复刻官方 dsh-app-boot。主要问题：会话归档复制官方物理编码格式、spawn 缺 timeout/env 合并、IPC 参数缺校验、官方规范（i18n/ctx.effect/JSDoc）未遵守。

## P0
1. main.ts:243 remote-allow-origins '*' + CDP 绑 0.0.0.0 → 任意网页可接管调试会话。建议 pin remote-debugging-address=127.0.0.1 + 收窄 allow-origins。
2. session-archive.ts:47-83 projectKey/encodeSegment 逐行复制官方 format.ts:122-167（官方未导出、无兼容承诺）。格式漂移→导入写错路径/删除误删别的会话目录。建议要求官方导出 helpers 或 createRequire require lib/format.js + 版本断言；至少校验 SESSION_FORMAT_VERSION。
3. boot.ts:326 每次启动无条件重写 profile 根 cordis.yml → 使官方 HMR live-reload（watchUserPatches）失能 + 与官方 tree write-back 竞态，被迫发明 plugins.disabled.json 第二持久层，丢 withFileLock 跨进程保护。建议仅内容不同时写 + 接 withFileLock；长期上推官方做成 Loader 显式选项。
4. bridge-client.ts:134-141 + bridge.ts:49-55 stdio JSON 协议无校验：zipBase64 无大小上限（zip-bomb 打爆 host 内存）、sessionExport 无超时（host 卡住→before-quit 永久挂住退出）、stdin 帧无 type 判别。建议超时+64MB 上限+帧校验。
5. boot.ts:253-278 healProfilesModuleFallbackRegistry 复制官方契约但丢 withFileLock（官方在 withFileLock 内写 symlink）→ 多实例并发 heal 不同 target 来回覆盖。建议引入 dsh-atomic-write withFileLock。
6. bridge-client.ts:74-78 spawn env 整体替换语义（类型允许传无 SystemRoot/PATH 的 env）+ combo.env 无校验透传（combos.json 可写 NODE_OPTIONS=--require /evil）。建议强制合并最小白名单 + env 黑名单过滤（抄官方 BOOTSTRAP_NAMES）。

## P1
7. ipc.ts 多 handler 入参零校验（slotKey/sessionId 直接拼标题/URL/文件名）。
8. ipc.ts:55-58 host-restart 无并发保护 + restart 不清 pendingSessionOp → 旧 pending 悬挂永不 resolve。
9. main.ts:194-199 spawnHost onReady 仅打印日志，host 崩溃重启后窗口停旧 dead URL；ready 无超时。
10. main.ts:226-228 user-data-dir 默认落 os.tmpdir() → 多用户可读 dsh-auth cookie + tmp 清理删 profile。建议改 appData。
11. boot.ts:419-435 settings 服务 100ms 短轮询 15s 静默放弃（破坏 fiber 语义，onboarding 注册静默缺失）。
12. plugin-manager.ts:419-512 runPnpm/spawnPnpm 无超时无并发互斥；重抄官方 apps/cli plugin.ts reconcile（应复用/上推官方导出）；profileName 与 boot.ts:193 重复实现。
13. plugin-manager.ts:287-308 search 无超时无缓存 + registry 硬编码 registry.npmjs.org（企业镜像搜不到，应走 Config）。
14. boot.ts:144-151 OFFICIAL_DEV_PRESETS 硬编码 '/Users/kukucai/dsh' fallback + cli.ts DSHSANITIZE 清单删了 DSH_CHECKOUT → dev fallback 永远读硬编码路径（bug）。Misconfiguration 应 fail loud。
15. combos.ts:24 COMBO_CONFIG_PATH 用 ~/.corum-desktop 而 host home 是 ~/.corum（命名不一致未迁移）+ 全程同步 IO + writeUserCombos 无原子写（应用 dsh-atomic-write）。
16. ipc.ts:130-155 Input HAL getInputHal 单例从不 dispose + startPoll 首帧 wasDown 恒 true 误吸附。
17. client/index.ts:45-47 window.__corumNotify 调试钩子无 DEV 守卫，第三方插件 UI 可发伪通知。
18. client/editor/EditorColumn.tsx 演示数据混 production + 裸 CustomEvent 字符串协议做槽位关闭（无类型安全，应用共享常量/ctx 服务）。
19. corum-fs.ts:106-176 revertWrites 的 root 来自渲染层请求参数 → 渲染帧可指定任意绝对路径 root 写任意文件（realpath 只防逃出 root，root 本身调用方给）。**权限放大，升 P0 候选**。root 应来自服务端会话注册表。另 175 行 void dirname 死 import。
20. session-archive.ts:125-136 static inject 声明后又强转 ctx.sessions as SessionStore（service presence 断言）；bridge.ts:72 在 boot 后 new，inject 语义未验证。
21. index.ts:36-93 DesktopWebServerShim 手工模拟官方 webServer 服务面（as unknown as 双断言），对官方组合内容做时间点假设，官方一旦调 webServer.register 静默 no-op。建议 shim 加 warn 把假设变可观测信号。
22. package.json description 仍写「zero HTTP」与 0.1.2 loopback 架构矛盾；dependencies 混入 25 个 client UI 包（healProfiles BFS 白做 25 次 symlink）。

## P2
23. JSDoc 缺 @param/@returns（combos.ts 等），中英混排建议公共 API 统一英文。
24. i18n：combo-page/ipc 原生对话框/NotificationHost 中文硬编码；lang=zh-CN 与窗口标题双语不一致。
25. protocol.ts:57 registerProtocols 返回恒 {} 死返回值；worker.ts:36-41 两常量死代码。
26. cli.ts:14 require('electron') as unknown as string 双断言可收紧。
27. session-archive.ts:167 new AbortController().signal 永不可 abort（误导，应传 undefined 或注释）。
28. main.ts:149-159 console-message Electron<30 legacy 分支已死（devDep pin ^43）可删。
29. boot.ts:373 展开后断言易误读；agent-presets 注入与 comboOverlays 层栈两处手工对齐（应收敛同一数组派生）。
30. scripts/pack-macos.mjs:26-33,112,230 大量 packages/shell 路径（包已改名 desktop）→ 跑这个脚本会写错目录或失败；230 行 smokeHome 内层 shadow。
31. session-archive.ts:294-297 「Belt and braces」轮询 agents registry 防御性死代码/throw 信息无用。
32. desktop-host/package.json 66 个依赖推导依据未固化，官方升级无法 diff。

## 与官方对齐好的
- boot 层序完全复刻官方 CLI；composeEntries 用官方函数算行索引。
- CorumPluginManager FIBER_STATE/FIBER_PHASE 镜像官方 plugin-inventory（但缺 satisfies 收束）。
- Electron 安全姿态与官方壳一致（contextIsolation/nodeIntegration:false/sandbox:true）。
- authenticatedUrl 契约、cordis.patch.yml 写法、web-runtime 四字段与官方逐字段对齐。

## 偏离（有正当理由）
- packageDirFromRealAnchor（pnpm isolated 布局 symlink 锚点看不到 sibling）——论证充分，但 heal 连 withFileLock 也丢了超出必要。
- 根 cordis.yml 重写——有理由但牺牲 HMR/官方持久化，技术债。
- agent-presets roots 注入（桌面壳绕过 CLI 自行注入）——正当；trust 分级（official=system/corum=user）是本地新增语义，可上推官方。
- DSH_CHECKOUT 被 cli 净化斩断是 bug 非设计。
- session-archive 的 flush/export/import/delete 是官方没有的新增能力，exportZip 复用官方 streamSessionLogZip 是好做法。

## 值得肯定
模块头注释质量极高（含历史决策/事故引用）；main.ts dsh-auth cookie 清理精准；protocol.ts 路径穿越防护双路由一致；bridge.ts fatal 错误聚合；cli 环境净化；input-hal 失败安全降级；tsdown client-purity 插件把「跨插件只走 cordis 服务」做成构建期强制。
