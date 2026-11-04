/** 让新审批或展开的菜单避开实际 composer；不依赖可选的布局 CSS 测量值。 */
export function revealApproval(card: Element | null | undefined): void {
  const scroller = card?.closest<HTMLElement>('[data-conversation-scroll]')
  if (card === null || card === undefined || scroller === null || scroller === undefined) return
  const composer = scroller.querySelector('[data-composer-seat]')
  const visibleBottom = (composer ?? scroller).getBoundingClientRect()[composer === null ? 'bottom' : 'top']
  const hidden = card.getBoundingClientRect().bottom - visibleBottom
  if (hidden > 0) scroller.scrollTop += hidden
}
