/**
 * 图片组该落到哪个渲染槽（issue #201）。
 *
 * 这两个槽名是 0.2.1-rc.3 官方 `@deepseek-ai/dsh-client-ui-attachment` 注册 occupant
 * 用的名字（`conversation.chat.user.images` / `conversation.chat.message.images`）。
 * 本包原先用自己的 `conversation.message.images`：在那个名字下**没有任何 occupant**
 * （槽是 `single` kind，「没有 occupant ⇒ 图片被省略」），于是一行附件
 * （`[data-message-attachments]`）渲染出来但内容为空 —— 用户看到的是「单独发一张图，
 * 对话流里没有预览」。
 *
 * 本文件刻意不 import React / primitives：纯映射要能在 node 测试里直接断言
 * （primitives 的运行时产物在该 checkout 里缺 `simple-icons`，import 会整文件 fail）。
 *
 * @module @corum/corum-ui-chat/chat/image-slot
 */

/** 图片槽名的联合类型（与官方 occupant 注册名一致）。 */
export type MessageImageSlotName =
  | 'conversation.chat.user.images'
  | 'conversation.chat.message.images'

/**
 * 按对齐方向选槽名。
 *
 * @param align - 图片组在消息里的对齐方向（`end` = 用户消息，右对齐）。
 * @returns 对应官方 occupant 的槽名。
 */
export function imageSlotOf(align: 'start' | 'end' | undefined): MessageImageSlotName {
  return align === 'end' ? 'conversation.chat.user.images' : 'conversation.chat.message.images'
}
