import type { NewTaskOptions } from './contract/slots.ts'
interface TaskBackend {
  create(args: NewTaskOptions): Promise<{ sessionId: string }>
  open(sessionId: string): void
  selectTaskMode(): void
  selectModel(sessionId: string, model: NewTaskOptions['model']): Promise<void>
}
export function createNewTaskAction(backend: TaskBackend): (options?: NewTaskOptions) => Promise<void> {
  return async options => {
    backend.selectTaskMode()
    const { cwd, profileId, permission, model } = options ?? {}
    const args: NewTaskOptions = {
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
      ...(profileId === undefined || profileId === '' ? {} : { profileId }),
      ...(permission === undefined || permission === '' ? {} : { permission }),
      ...(model === undefined ? {} : { model }),
    }
    const { sessionId } = await backend.create(args)
    backend.open(sessionId)
    await backend.selectModel(sessionId, model)
  }
}
