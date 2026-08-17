# 插件包模板与约定

每个插件包是 corum Agent OS 的最小单元。按类型分两种。

## 命名原则

- 自己写的插件**命名随意**，不加前缀，按功能归入 `packages/plugins/` 对应分组目录。
- 官方/社区现成插件**直接用**，不收录、不重命名、不改源码。

## dsh.client 插件（UI 功能）

浏览器端插件，声明 `dsh.client`，源码在 `src/client/`，构建出 `lib/client.js`。

```json
{
  "name": "<随意起名>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dsh": { "client": { "platform": "web", "inject": [], "immediately": false } },
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "dependencies": {
    "@deepseek-ai/cordis": "^0.1.0-rc.5"
  },
  "devDependencies": { "tsdown": "^0.22.2", "typescript": "^6.0.3" }
}
```

## dsh.bundle 插件（配置层 / Service Provider）

宿主端插件，声明 `dsh.bundle`，带 `cordis.patch.yml`，行引用自己的包名。

```json
{
  "name": "<随意起名>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {
    "@deepseek-ai/dsh-app-boot": "^0.1.0-rc.5"
  }
}
```

## 新增插件步骤

1. 在对应分组下 `mkdir packages/plugins/<group>/<name>`
2. 按类型写 `package.json` + `src/` + `cordis.patch.yml`（若 bundle）
3. 在 profile 的 `dsh.profile.bundles` 加入包名（或先在根 `cordis.patch.yml` insert）
4. `pnpm install && pnpm --filter <name> run build`
