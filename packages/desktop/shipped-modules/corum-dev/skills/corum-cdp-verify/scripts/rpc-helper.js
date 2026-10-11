/**
 * corum RPC 调用助手（在 renderer 页面上下文里经**官方 loopback webserver** 调 host 服务）。
 * 用法：把本文件内容拼进你的 eval 脚本顶部（或在页面里 evalfile 一个包含它的脚本）。
 *
 *   const { call, callRaw } = <include rpc-helper.js>
 *   const { projects } = await call('corumProject', 'listProjects', {})
 *
 * ⚠️ 0.1.2 起**传输层变了**：桌面架构从「自定义 IPC transport」换成「官方 loopback
 * webserver + loadURL authenticatedUrl」，旧的 `window.corumDesktop.unary` IPC 桥
 * **已删除**（现役的 `window.corumDesktop` 只有 restartHost / openFloating /
 * pickDirectory / listCombos 等，**没有 `unary`**）。旧实现调用它会直接抛
 * `desktop bridge unavailable`，故本文件改为直接 `fetch` 官方端点。
 *
 * 形态（与官方 `connection.rpc.call` 同一线上协议）：
 *   POST `/api/<ns>/<method>`，信封 `{type:'client-request', rpcId, method, payload:{args}}`
 *   响应同信封：`{type:'server-response', rpcId, result:{ok, value|error}}`
 * 三个要点（实测踩过的）：① 路径必须是 `/api/<ns>/<method>`（POST 裸 `/api` 返回 404）；
 * ② 信封必须有 `type:'client-request'` 与 `rpcId`（缺则回 `gateway/bad-request`）；
 * ③ 用**相对路径**（页面 origin 就是 loopback 端口）。
 *
 * 服务端点一览（IDE/coding combo 常用）：
 *   corumProject/*  createProject / listProjects / listGroupMembers / addTeamToGroup
 *                   addMemberToGroup / removeGroupMember / listWorkTypes / addWorkType
 *   corumTeam/*     createTeam / listTeams / addMember / removeMember / deleteTeam
 *   corumAgent/*    listProfiles / saveProfile({input}) / deleteProfile
 *                   runPromptForType({projectId,profileId,type,prompt}) → 等回复（长耗时）
 *                   createAgentForType / getSessionEventsForType
 *   corumRuntime/*  enqueue({projectId,profileId,type,summary,transferNote?})
 *                   listTasks / listLanes / getDomainEvents({projectId,fromSeq})
 *                   getTaskEvents({projectId,profileId,fromSeq,type?})
 *                   steerTask / cancelTask / reassignTask
 */

/** 调用 RPC，result.ok=false 时抛错。 */
async function call(svc, method, args) {
  const r = await callRaw(svc, method, args)
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

/** 调用 RPC 返回完整 envelope（不抛错，用于验证拒绝路径）。 */
async function callRaw(svc, method, args) {
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `${svc}/${method}`, payload: { args: args ?? {} } }
  const response = await fetch(`/api/${svc}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  })
  if (response.status !== 200) throw new Error(`${svc}/${method}: HTTP ${response.status}`)
  const envelope = await response.json()
  // rpcId 回显核对：防止把别处的响应当成自己的（与官方网关同款纪律）。
  if (envelope.rpcId !== rpcId) throw new Error(`rpcId mismatch: ${envelope.rpcId} != ${rpcId}`)
  return envelope.result
}
