/**
 * issue #201：纯图消息在对话流里没有预览。
 *
 * 真因不是「空文本被跳过」，而是**渲染槽名过期**：本包渲染 `conversation.message.images`，
 * 而 0.2.1-rc.3 官方附件插件 `@deepseek-ai/dsh-client-ui-attachment` 把 occupant 注册在
 * `conversation.chat.user.images` / `conversation.chat.message.images` 名下；该槽是
 * `single` kind，「没有 occupant ⇒ 图片被省略」。于是附件行渲染出来是空的。
 *
 * 本测试钉住映射关系（用户消息 ⇒ user 槽；assistant ⇒ message 槽）。
 *
 * @module @corum/corum-ui-chat/tests/image-slot-compat
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APPLY = join(HERE, '..', 'src', 'client', 'apply.ts')

const { imageSlotOf } = await import('../src/client/chat/image-slot.ts')

describe('图片渲染槽名与官方附件插件对齐（issue #201）', () => {
  it('用户消息（align=end）用 conversation.chat.user.images', () => {
    expect(imageSlotOf('end')).toBe('conversation.chat.user.images')
  })

  it('assistant 消息（align=start）用 conversation.chat.message.images', () => {
    expect(imageSlotOf('start')).toBe('conversation.chat.message.images')
  })

  it('缺省 align 按 assistant 处理（不落到无人认领的旧槽名）', () => {
    expect(imageSlotOf(undefined)).toBe('conversation.chat.message.images')
  })

  it('conversation.view 的 children 里声明了这两个槽（否则 occupant 挂不上）', () => {
    const source = readFileSync(APPLY, 'utf8')
    expect(source).toContain("'conversation.chat.user.images': { kind: 'single', scope: 'session' }")
    expect(source).toContain("'conversation.chat.message.images': { kind: 'single', scope: 'session' }")
  })
})
