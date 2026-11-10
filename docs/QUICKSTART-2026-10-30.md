# 下个 session 的第一句话（可直接粘给 Agent）

读 `docs/HANDOFF-2026-10-30-cdp-router-builtin.md`，然后修 §2 那个 `dsh.client` 声明问题
（`corum-cdp-router` 缺 `@corum/corum-api-remotes` + `immediately` 应为 true），
重打包，我装上验证主界面能出。

---

## 一句话根因（给 Agent 的提示）

`packages/plugins/agent/corum-cdp-router/package.json` 的 `dsh.client` 写错了：

```json
"dsh": { "client": {
  "platform": "web",
  "inject": ["@deepseek-ai/dsh-client-ui-settings"],        // 缺 @corum/corum-api-remotes
  "immediately": false                                       // 应为 true
} }
```

参照同仓 `corum-artgen` / `corum-memory` / `corum-ollama`（三个完全一致）：
```json
"inject": ["@deepseek-ai/dsh-client-ui-settings", "@corum/corum-api-remotes"],
"immediately": true
```

因为主进程用轮询 `[data-session-band]` 判「主界面就绪」（30s 超时），
client 半加载失败就永不出现 ⇒ 表现为「启动失败：主界面加载超时」。

---

## 装之前必须做的事

```bash
# 杀干净所有 Corum 实例，否则撞单实例锁 → 表现成"起不来"
pkill -f "Corum.app/Contents/MacOS/Corum"
pkill -f "Corum.app/Contents/Resources/node.*bridge"
sleep 3
pgrep -lf "Corum.app" | head   # 必须为空
```

## 打包命令（必须带 NODE_MIRROR）

```bash
cd /Users/kukucai/work/Corum-Harness/Corum-Harness
pnpm install --frozen-lockfile=false
NODE_MIRROR=https://registry.npmmirror.com/-/binary/node pnpm --filter corum-desktop run pack
```
