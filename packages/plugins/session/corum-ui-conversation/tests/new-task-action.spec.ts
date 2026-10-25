import { expect, it } from 'vitest'
import { createNewTaskAction } from '../src/client/new-task-action.ts'
it('无参数新建直接请求默认目录，不继承工作区；创建后打开并应用选中模型', async () => {
  const events: unknown[] = []
  const newTask = createNewTaskAction({ create: async args => { events.push(args); return { sessionId: 'new' } },
    open: id => { events.push(['open', id]) }, selectTaskMode: () => { events.push('task') }, selectModel: async (id, model) => { events.push(['model', id, model]) } })
  await newTask()
  expect(events).toEqual(['task', {}, ['open', 'new'], ['model', 'new', undefined]])
  events.length = 0
  const options = { cwd: 'E:/explicit', profileId: 'agent', permission: 'read-only', model: { provider: 'p', model: 'm', reasoningEffort: 'high' } }
  await newTask(options)
  expect(events).toEqual(['task', options, ['open', 'new'], ['model', 'new', options.model]])
})
