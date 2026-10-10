/** Host loader entry for the browser implementation exported from `./client`. */

/** Host plugin body — no host-side behavior for the models settings plugin.
 *  （`ui-onboarding` 命名空间注册由本包的 `./settings-registrar` boot 常驻行负责：
 *  IDE overlay 禁用官方 ui-settings-general 后，壳经该行接管注册，见
 *  `cordis.patch.yml` 的 `corum-ui-onboarding-settings` 行。） */
export function apply(): void {}
