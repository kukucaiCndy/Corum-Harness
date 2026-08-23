/** Host loader entry for the browser implementation exported from `./client`. */

/** Host plugin body — no host-side behavior for the models settings plugin.
 *  （`ui-onboarding` 命名空间注册由 ide-shell 的 host 半负责：IDE overlay 禁用
 *  官方 ui-settings-general 后，壳接管该注册，见 @corum/corum-ide-ui host index。） */
export function apply(): void {}
