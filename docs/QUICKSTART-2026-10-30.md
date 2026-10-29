# 下个 session 的第一句话（可直接粘给 Agent）

读 `docs/HANDOFF-2026-10-30b-cdp-router-white-screen-fixed.md`。

**白屏已修完并实机验穿**（真因 = client 半的 `export default` 让 cordis 丢掉
`inject` 声明，不是上一份说的 `dsh.client` 字段；详见交付文档 §1）。
`/Applications/Corum.app` 已是最新构建，主界面正常、设置 › 扩展 › CDP 目标 面板有真实数据。

接着做 §4 的下一步：
1. 重打扩展包 ZIP（`corum-dev-preset` 分支 `feat/cdp-target-router` @ `1637f9b`，
   `dist/corum-dev-1.9.0.zip` 还不存在）——顺带拍板「是否合入其 main」。
2. 起一个**被测实例**（带 `--remote-debugging-port`）跑 5 条 Agent 工具的端到端
   （`cdp_discover_targets` → `cdp_adopt_discovered` → `cdp_evaluate`）；
   验证时永远测**别的实例**，不测自己。
3. 把 `corum-cdp-router` 的 9 个 RPC 从「一个 input 大对象」改成**位置形参**
   （现在外部调用方必须写 `{ input: { … } }` 才能过 typert 网关描述符）。

---

## 已确认的失败判据（省你排查时间）

看到「启动失败：主界面加载超时」时，**先看 renderer console**：

```bash
"/Applications/Corum.app/Contents/MacOS/Corum" --remote-debugging-port=9400 &
curl -s http://127.0.0.1:9400/json/list       # 拿 page target 的 ws 地址
# 然后 CDP: Runtime.enable + Log.enable，读 document.body.innerText
```

- body 含 `Failed to load plugins` ⇒ client 半某个 entry apply 失败
  （典型：`cannot get property "<服务>" without inject`）。
- `[data-session-band]` 存在且 body 是工作区列表 ⇒ 界面其实是好的。

## 装之前必须做的事（**别照上一份的命令**）

```bash
# 只杀 /Applications 的实例。用 "Corum.app/Contents/MacOS/Corum" 通配会连
# 本会话宿主（kkc-desktop 构建）一起杀掉，那是自毁。
pkill -f "^/Applications/Corum.app"
sleep 3
pgrep -lf "^/Applications/Corum.app" | head   # 必须为空
```

## 打包命令（必须带 NODE_MIRROR；`node`/`pnpm` 不在 GUI 继承的 PATH 里）

```bash
cd /Users/kukucai/work/corum-harness/Corum-Harness
export PATH=/opt/homebrew/bin:$PATH          # node v26.4.0 / pnpm 11.7.0
pnpm install --frozen-lockfile=false
NODE_MIRROR=https://registry.npmmirror.com/-/binary/node pnpm --filter corum-desktop run pack
```
