/**
 * corum RPC 调用助手（在 renderer 页面上下文里经 window.corumDesktop IPC 桥调 host 服务）。
 * 用法：把本文件内容拼进你的 eval 脚本顶部（或在页面里 evalfile 一个包含它的脚本）。
 *
 *   const { call, callRaw } = <include rpc-helper.js>
 *   const { projects } = await call('corumProject', 'listProjects', {})
 *
 * 服务端点一览（dev-agent combo 常用）：
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
  const bridge = window.corumDesktop
  if (bridge?.unary === undefined) throw new Error('desktop bridge unavailable（页面未就绪或非 corum 窗口）')
  const rpcId = crypto.randomUUID()
  const message = { type: 'client-request', rpcId, method: `${svc}/${method}`, payload: { args } }
  const { status, body } = await bridge.unary(`/api/${svc}/${method}`, JSON.stringify(message))
  if (status !== 200) throw new Error(`${svc}/${method}: HTTP ${status}`)
  const envelope = JSON.parse(body)
  if (envelope.rpcId !== rpcId) throw new Error('rpcId mismatch')
  return envelope.result
}
