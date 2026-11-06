# 两项阻塞问题的验证说明

main 固定在 `6647d914`；本次补充修复为 `2b232e40`，只处理多 frame 压缩历史和跨项目草稿保护。

## 完整历史

使用真实 Agent 在同一新会话发送三轮消息并写入不同文件。迁移实现按物理 zstd frame 读取；验收另用官方公开 `JsonlSessionPersistence` reader，不调用迁移解码函数。

- 迁移前正常退出后读取 68 个事件；C→E 实际迁移及 Host 重启后，68 个事件逐项完全相同。
- 额外冷启动后，同一会话显示“3 轮 / 9 步”，实际滚动查看第一条旧消息；三条旧用户文本均保留。
- 原会话继续第四轮，真实写入新目录。退出后读到 90 个事件，原 68 个事件仍为完全相同前缀。

旧的整包 `zstdDecompressSync` suffix hash 校验只读首 frame，不能证明完整历史，相关旧结论已撤回；上述独立读取与真实界面结果替代它。

## 跨项目草稿

A 项目通过真实 EditorColumn 留下未保存内容，切换至 B 项目且 B 当前文件已保存，从设置实际点击迁移后被明确拒绝，根目录不变。返回 A 后草稿仍在，通过保存按钮落盘后方能迁移。

## 自动化与限制

- desktop：199 项，198 pass、1 既有 Windows symlink 条件 skip、0 fail；host/client 强制类型检查与完整构建通过。
- 真实 writer 多次 append/flush、官方 reader 重载、原事件压缩 frames 保持、截断尾 frame 拒绝，以及跨项目缓存/loading/只读 diff 有自动回归。
- Windows 仅操作独立 home/profile 与本地模型 fixture，无外部模型调用。原生目录选择器取消真实运行；成功选择由外部测试启动器提供返回值，后续生产设置、文件迁移、重启、导航真实执行。
- macOS/Linux 未实机验收；skip 不计为通过。既有基座归档还原 API 404、fork drift §17 失败与构建警告单独披露。

集中独立复审已确认两项阻塞均为 ADDRESSED，未发现新增 Critical / Important / Minor，允许提交 PR；该结论限定于修复及直接影响，不扩大平台或原生选择器验收范围。
