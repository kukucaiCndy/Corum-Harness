# @corum/corum-ide-conversation-ui

> **已退役，代码保留备查**——对话区已由 B 方案 fork 基座接管：`@corum/corum-ui-conversation`
> （官方数据流骨架 fork）+ `@corum/corum-ui-chat`（消息节点渲染层 fork）。本包的自研数据通路
> （getTaskSessionEvents/streamFollow/buildCards）与自研 composer 被官方数据流取代。
> 如需回退，见 packages/desktop/cordis.ide.patch.yml 中被注释的挂载行（重新挂载本包并禁用
> 上面两行 fork）。

corum IDE 对话区（design.pen ② Agent 对话区，flex）：Convo Header + Session Stats +
View Tabs + Chat Flow + Review Card + Chat Input。注册进壳的 conversation 槽。
