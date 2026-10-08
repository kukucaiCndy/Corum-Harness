import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os, { platform } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, Notification, Tray, app, dialog, ipcMain, nativeImage, protocol, safeStorage, session } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
//#region lib/types/electron/combo-page.js
/**
* corum-desktop 壳 combo 管理页。
*
* 壳（Electron 第一进程）的首页：零 dsh 依赖的静态页面，展示所有已配置且
* 可用的 combo，点击后通知主进程按该 combo 注入环境变量 / 工作目录 / 覆盖
* 规则并 spawn 对应的 dsh host 子进程。页面通过 preload 暴露的
* window.corumDesktop（listCombos / launchCombo / onComboStatus）与主进程
* 交互，不依赖任何 dsh 客户端代码。
* @module corum-desktop/electron/combo-page
*/
/** 渲染一个内置 lucide 图标名的 emoji fallback（与旧 launcher 一致）。 */
const LUCIDE_FALLBACK = {
	"code-2": "💻",
	"palette": "🎨",
	"bug": "🐛",
	"message-circle": "💬",
	"monitor-smartphone": "📱"
};
/**
* 生成 combo 管理页 HTML。每次请求时构建（页面无状态，纯静态）。
*/
function renderComboPageHtml() {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>矩道 Corum Harness</title>
<style>
  :root {
    color-scheme: light dark;
    --brand: #5b8cff;
    --bg: #f5f6fa;
    --card: rgba(255, 255, 255, 0.72);
    --card-hover: rgba(255, 255, 255, 0.92);
    --text: #1c2333;
    --text-soft: #6b7280;
    --border: rgba(28, 35, 51, 0.10);
    --shadow: 0 8px 28px rgba(28, 35, 51, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #10131a;
      --card: rgba(28, 33, 45, 0.72);
      --card-hover: rgba(34, 40, 54, 0.92);
      --text: #e8ecf4;
      --text-soft: #8b93a7;
      --border: rgba(232, 236, 244, 0.10);
      --shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
    background:
      radial-gradient(1200px 600px at 15% -10%, rgba(91, 140, 255, 0.18), transparent 60%),
      radial-gradient(900px 500px at 90% 10%, rgba(124, 92, 255, 0.12), transparent 55%),
      var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
  }
  .launcher { width: min(960px, 100%); }
  .launcher-header { text-align: center; margin-bottom: 40px; }
  .launcher-title { font-size: 30px; font-weight: 700; letter-spacing: 0.02em; }
  .launcher-subtitle { margin-top: 8px; font-size: 15px; color: var(--text-soft); }
  .launcher-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 20px;
    border-radius: 14px;
    background: var(--card);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    text-align: left;
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition: transform 0.12s ease, background 0.12s ease;
    min-height: 132px;
  }
  .card:hover { transform: translateY(-2px); background: var(--card-hover); }
  .card:disabled { opacity: 0.55; cursor: progress; }
  .card-icon { font-size: 26px; line-height: 1; }
  .card-name { font-size: 16px; font-weight: 600; }
  .card-desc { font-size: 13px; color: var(--text-soft); line-height: 1.5; flex: 1; }
  .status {
    margin-top: 24px;
    text-align: center;
    font-size: 13px;
    color: var(--text-soft);
    min-height: 20px;
  }
  .status.error { color: #e5484d; }
</style>
</head>
<body>
  <main class="launcher">
    <header class="launcher-header">
      <h1 class="launcher-title">矩道 Corum Harness</h1>
      <p class="launcher-subtitle">选择一个工作流开始</p>
    </header>
    <div id="grid" class="launcher-grid"></div>
    <div id="status" class="status"></div>
  </main>
  <script>
    (() => {
      const LUCIDE_FALLBACK = ${JSON.stringify(LUCIDE_FALLBACK)};
      const grid = document.getElementById('grid');
      const status = document.getElementById('status');
      const bridge = window.corumDesktop;
      if (bridge === undefined) {
        status.textContent = '壳桥接不可用（preload 未加载）';
        status.className = 'status error';
        return;
      }
      const iconOf = (icon) => {
        if (icon === null || typeof icon !== 'object') return '⚡';
        if (icon.type === 'emoji' || icon.type === 'text') return icon.value;
        if (icon.type === 'image') return '🖼';
        return LUCIDE_FALLBACK[icon.value] ?? '⚡';
      };
      const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
      const launch = async (id, name) => {
        if (bridge.__launching) return;
        bridge.__launching = true;
        status.textContent = '正在启动「' + name + '」…';
        status.className = 'status';
        try {
          const r = await bridge.launchCombo(id);
          if (r.ok) {
            status.textContent = '已启动「' + name + '」，加载工作台…';
          } else {
            status.textContent = '启动失败：' + (r.error ?? '未知错误');
            status.className = 'status error';
            bridge.__launching = false;
          }
        } catch (e) {
          status.textContent = '启动失败：' + String(e);
          status.className = 'status error';
          bridge.__launching = false;
        }
      };
      const render = (combos) => {
        grid.innerHTML = '';
        for (const combo of combos) {
          const card = document.createElement('button');
          card.type = 'button';
          card.className = 'card';
          card.title = combo.description ?? '';
          card.innerHTML =
            '<div class="card-icon">' + iconOf(combo.icon) + '</div>' +
            '<div class="card-name">' + esc(combo.name) + '</div>' +
            '<div class="card-desc">' + esc(combo.description) + '</div>';
          card.addEventListener('click', () => launch(combo.id, combo.name));
          grid.appendChild(card);
        }
        if (combos.length === 0) {
          status.textContent = '没有可用 Combo';
        }
      };
      bridge.listCombos()
        .then(render)
        .catch((e) => {
          status.textContent = '读取 Combo 列表失败：' + String(e);
          status.className = 'status error';
        });
    })();
  <\/script>
</body>
</html>
`;
}
//#endregion
//#region lib/types/electron/protocol.js
/**
* Custom-protocol handlers for the desktop surface. One scheme remains:
* `corumapp://` serves ONLY the shell-owned pages — the combo launcher page
* and shell static assets (brand logo / ambient background, Monaco language
* workers). The dsh surface itself is served by the host's official webserver
* over loopback HTTP (dist + /plugins bundles + the injected __DSH_BOOT__
* graph), so the renderer loads it via `loadURL(authenticatedUrl)` rather than
* a custom scheme. The `corump://` plugin-bundle scheme is retired with the
* old IPC transport.
* @module corum-desktop/electron/protocol
*/
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
	".map": "application/json",
	".webmanifest": "application/manifest+json",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".png": "image/png",
	".ico": "image/x-icon"
};
/** Image extensions the shell's /assets/ route serves. */
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".ico"
]);
/**
* Register the privileged scheme. Must run before app ready. Only `corumapp`
* remains (the dsh surface uses loopback HTTP); `corump` is retired.
*/
function registerSchemes() {
	protocol.registerSchemesAsPrivileged([{
		scheme: "corumapp",
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true
		}
	}]);
}
/**
* Register the shell protocol handler. Run after app ready, before any host
* child is spawned: the combo launcher page (corumapp://combo/…) is served
* without a host. The dsh page no longer transits this scheme.
* @param monacoWorkersDir - directory of the bundled Monaco language workers.
* @param assetsDir - directory of the shell-owned static images (brand logo /
* ambient background). Served at `corumapp://app/assets/<name>`.
*/
function registerProtocols(monacoWorkersDir, assetsDir) {
	protocol.handle("corumapp", async (request) => {
		const url = new URL(request.url);
		if (url.host === "combo") return new Response(renderComboPageHtml(), { headers: { "content-type": MIME[".html"] ?? "text/html; charset=utf-8" } });
		const pathname = decodeURIComponent(url.pathname === "" ? "/" : url.pathname);
		if (monacoWorkersDir !== void 0 && pathname.startsWith("/monaco/")) {
			const workerName = pathname.slice(8);
			const workerPath = resolve(normalize(join(monacoWorkersDir, workerName)));
			if (!workerPath.startsWith(monacoWorkersDir + sep) && workerPath !== monacoWorkersDir) return new Response("forbidden", { status: 403 });
			try {
				const body = await readFile(workerPath);
				return new Response(body, { headers: {
					"content-type": "text/javascript; charset=utf-8",
					"cache-control": "no-cache",
					"access-control-allow-origin": "*"
				} });
			} catch {
				return new Response("not found", { status: 404 });
			}
		}
		if (assetsDir !== void 0 && pathname.startsWith("/assets/") && IMAGE_EXTENSIONS.has(extname(pathname))) {
			const assetName = pathname.slice(8);
			const assetPath = resolve(normalize(join(assetsDir, assetName)));
			if (!assetPath.startsWith(assetsDir + sep) && assetPath !== assetsDir) return new Response("forbidden", { status: 403 });
			try {
				const body = await readFile(assetPath);
				return new Response(body, { headers: { "content-type": MIME[extname(assetPath)] ?? "application/octet-stream" } });
			} catch {
				return new Response("not found", { status: 404 });
			}
		}
		return new Response("not found", { status: 404 });
	});
	return {};
}
//#endregion
//#region lib/types/electron/combos.js
/**
* corum-desktop 壳层 combo 数据模型。
*
* 壳（Electron 第一进程）是 combo 管理页面：读取所有已配置且可用的 combo，
* 为每组 combo 注入环境变量 / 工作目录 / 覆盖规则，然后按 combo spawn 一个
* 独立的 dsh host 子进程。combo 切换 = 换进程，不做进程内动态插件增删。
*
* 与旧版（@corum/corum-ide-ui 插件内 combos.ts）的区别：
* - 数据从渲染端 localStorage 迁到壳层文件（~/.corum-desktop/combos.json）
* - 新增 env / cwd / patches 三个启动注入字段（combo 的启动参数）
* - 切换从「运行时 loader.create/remove」改为「按 combo 起新进程」
*
* plugins 字段决定 composition：壳层在 spawn host 时把它以
* CORUM_COMBO_PLUGINS（逗号分隔包名）注入环境，boot 端把它作为 insert 行
* 加入 composition（见 boot.ts resolveComboOverlays）。
* @module corum-desktop/electron/combos
*/
/** 壳层 combo 配置文件。壳自己的数据，不通过环境变量传给 dsh 进程。 */
const COMBO_CONFIG_PATH = join(os.homedir(), ".corum-desktop", "combos.json");
const now = Date.now();
/**
* 内置 Combo：当前只保留 IDE（coding）一个。combo 是独立 Agent 应用的启动
* 入口，后续新应用通过用户自定义 combo 或新增内置项扩展。plugins 字段当前
* 用 S0 测试插件占位，S3 替换为真实功能插件。`corum-agent-dev` 为 IDE 侧栏
* 提供 corumProject RPC（项目列表 / 打开 / 创建）。env.CORUM_DESKTOP_MODE=ide
* 使 boot 叠加 IDE overlay（cordis.ide.patch.yml）。
*
* agentPreset 仅记录该 combo 的默认 Agent；combo 未来可能管理多个 Agent，
* 该字段不限定 combo 内的 Agent 数量。
*/
const BUILTIN_COMBOS = [{
	id: "coding",
	name: "编码",
	description: "全栈编码：会话列表 + 对话 + 编辑器 + 文件树",
	agentPreset: "standard",
	plugins: [
		"@corum/corum-agent",
		"@corum/corum-skill-manager",
		"@corum/corum-mcp-manager"
	],
	env: { CORUM_DESKTOP_MODE: "ide" },
	cwd: "",
	patches: [],
	icon: {
		type: "lucide",
		value: "code-2"
	},
	createdAt: now,
	lastUsedAt: now,
	builtin: true
}];
/**
* 校验 combo.cwd（S2）：非空时必须是「存在的绝对路径目录」。cwd 决定 host
* 子进程的工作目录，来自用户可写的 combos.json，无校验会把 host 起到任意目录。
* 非法时降级为空（继承壳进程 cwd）并 warn（对齐 sanitizeComboEnv 的告警风格），
* 不拒绝整个 combo（cwd 只是启动便利项，不是能力入口）。
* @returns 合法原样返回；非法返回 '' 并写 stderr 告警。
*/
function sanitizeComboCwd(comboId, cwd) {
	if (cwd === "") return "";
	if (!isAbsolute(cwd)) {
		process.stderr.write(`[corum-desktop] combo "${comboId}" cwd dropped (not an absolute path): ${cwd}\n`);
		return "";
	}
	try {
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
			process.stderr.write(`[corum-desktop] combo "${comboId}" cwd dropped (not an existing directory): ${cwd}\n`);
			return "";
		}
	} catch {
		process.stderr.write(`[corum-desktop] combo "${comboId}" cwd dropped (stat failed): ${cwd}\n`);
		return "";
	}
	return cwd;
}
/**
* 校验 combo.patches（S2）：每个路径必须「存在且是 .yml/.yaml 文件」。patches
* 会作为最高 patch 层叠加进 boot composition（高权限入口），来自用户可写的
* combos.json，无校验可把任意 yml 注进 host。非法路径逐条剔除并 warn（对齐
* sanitizeComboEnv 的告警风格），合法项保留。
* @returns 剔除非法项后的新数组（不修改入参）。
*/
function sanitizeComboPatches(comboId, patches) {
	const out = [];
	for (const patch of patches) {
		if (typeof patch !== "string" || patch === "") continue;
		if (!/\.(ya?ml)$/i.test(patch)) {
			process.stderr.write(`[corum-desktop] combo "${comboId}" patch dropped (not a .yml/.yaml file): ${patch}\n`);
			continue;
		}
		try {
			if (!existsSync(patch) || !statSync(patch).isFile()) {
				process.stderr.write(`[corum-desktop] combo "${comboId}" patch dropped (not an existing file): ${patch}\n`);
				continue;
			}
		} catch {
			process.stderr.write(`[corum-desktop] combo "${comboId}" patch dropped (stat failed): ${patch}\n`);
			continue;
		}
		out.push(patch);
	}
	return out;
}
function readUserCombos() {
	if (!existsSync(COMBO_CONFIG_PATH)) return [];
	try {
		const raw = JSON.parse(readFileSync(COMBO_CONFIG_PATH, "utf8"));
		if (!Array.isArray(raw)) return [];
		const combos = [];
		for (const item of raw) {
			const c = item;
			if (typeof c.id !== "string" || typeof c.name !== "string") continue;
			combos.push({
				id: c.id,
				name: c.name,
				description: c.description ?? "",
				agentPreset: c.agentPreset ?? "standard",
				plugins: Array.isArray(c.plugins) ? c.plugins : [],
				env: c.env !== null && typeof c.env === "object" ? c.env : {},
				cwd: sanitizeComboCwd(c.id, c.cwd ?? ""),
				patches: sanitizeComboPatches(c.id, Array.isArray(c.patches) ? c.patches : []),
				icon: c.icon ?? {
					type: "text",
					value: "?"
				},
				theme: c.theme ?? null,
				createdAt: c.createdAt ?? Date.now(),
				lastUsedAt: c.lastUsedAt ?? Date.now(),
				builtin: c.builtin === true
			});
		}
		return combos;
	} catch {
		return [];
	}
}
function writeUserCombos(combos) {
	const dir = dirname(COMBO_CONFIG_PATH);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const payload = combos.filter((c) => !c.builtin).map((c) => ({
		...c,
		theme: c.theme ?? null
	}));
	const tmp = `${COMBO_CONFIG_PATH}.tmp`;
	writeFileSync(tmp, JSON.stringify(payload, null, 2));
	renameSync(tmp, COMBO_CONFIG_PATH);
}
/**
* 禁止 combo.env 注入的危险环境变量（大小写不敏感精确匹配）：这些 key 会改变
* Node 解释器/动态链接器的启动行为，被注入即等于在 host 子进程里执行任意代码
* （如 ELECTRON_RUN_AS_NODE 让 Electron 变 Node、NODE_OPTIONS=--require 注入
* 任意脚本、DYLD_INSERT_LIBRARIES 注入动态库）。语义对齐官方 BOOTSTRAP_NAMES
* （dsh app-boot）里「进程启动与模块解析」一类，但收敛为本壳实际危险的清单。
*/
const COMBO_ENV_BLOCKLIST = /* @__PURE__ */ new Set([
	"NODE_OPTIONS",
	"NODE_PATH",
	"ELECTRON_RUN_AS_NODE",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH"
]);
/**
* 过滤 combo.env：剔除黑名单 key 并逐条告警（stderr）。combo 定义来自用户可
* 写的 ~/.corum-desktop/combos.json，env 直进 host 子进程 spawn，必须钳制。
* @returns 剔除危险 key 后的新对象（不修改入参）。
*/
function sanitizeComboEnv(env) {
	const out = {};
	for (const [key, value] of Object.entries(env)) {
		if (COMBO_ENV_BLOCKLIST.has(key.toUpperCase())) {
			process.stderr.write(`[corum-desktop] combo env key blocked (interpreter/linker takeover risk): ${key}\n`);
			continue;
		}
		out[key] = value;
	}
	return out;
}
/** 读取所有 Combo（内置 + 用户自定义）。 */
function loadAllCombos() {
	return [...BUILTIN_COMBOS, ...readUserCombos()];
}
/** 按 ID 查找 Combo。 */
function findCombo(id) {
	return loadAllCombos().find((c) => c.id === id) ?? null;
}
/** 记录 Combo 最后使用时间（内置同样更新文件时间戳语义除外：内置只落内存）。 */
function touchCombo(id) {
	const all = loadAllCombos();
	const combo = all.find((c) => c.id === id);
	if (combo === void 0) return null;
	combo.lastUsedAt = Date.now();
	if (!combo.builtin) writeUserCombos(all);
	return combo;
}
//#endregion
//#region lib/types/electron/input-hal.js
/**
* Input HAL —— 跨平台全局输入状态抽象层（Hardware Abstraction Layer）。
*
* 主进程需要「全局鼠标按键状态」来做可靠的拖拽松手判定（macOS 系统拖拽
* app-region:drag 期间渲染层收不到 mouseup，主进程也没有现成的全局鼠标
* API）。本层向上暴露平台无关的查询接口，向下按平台走系统级适配：
*
*   - macOS：koffi 调 CoreGraphics 的 CGEventSourceButtonState（Quartz 事件
*     源状态，全局、无需辅助功能权限即可读左键）。
*   - Windows：GetAsyncKeyState(VK_LBUTTON)（user32，同为全局键状态）。
*   - Linux：**尚未实现**（`createLinuxHal` 恒返回不可用）。理论上可走 X11
*     XQueryPointer 的 button mask，但 Wayland 下没有全局指针 API，且本层至今
*     未写；后果仅是浮窗「松手自动吸附」不可用。
*
* 任何平台加载失败（库缺失 / 符号变化 / 非桌面环境）都安全降级为
* 「查询不可用」，调用方据此选择保守行为（不做自动吸附），绝不抛错。
*
* @module corum-desktop/electron/input-hal
*/
const requireKoffi = createRequire(import.meta.url);
/** 不可用的空 HAL：所有查询返回 null。 */
const nullHal = (reason) => {
	console.warn(`[input-hal] unavailable: ${reason}`);
	return {
		available: false,
		isPrimaryButtonDown: () => null,
		dispose: () => {}
	};
};
/**
* macOS 实现：CoreGraphics CGEventSourceButtonState。
* 原型：bool CGEventSourceButtonState(CGEventSourceStateID stateID, CGMouseButton button)
* stateID = kCGEventSourceStateCombinedSessionState (1)；button = kCGMouseButtonLeft (0)。
*/
function createMacHal() {
	try {
		const lib = requireKoffi("koffi").load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
		const CGEventSourceButtonState = lib.func("bool CGEventSourceButtonState(int stateID, int button)");
		const COMBINED_SESSION = 1;
		const LEFT_BUTTON = 0;
		return {
			available: true,
			isPrimaryButtonDown: () => CGEventSourceButtonState(COMBINED_SESSION, LEFT_BUTTON),
			dispose: () => {
				lib.unload();
			}
		};
	} catch (error) {
		return nullHal(`macOS CoreGraphics load failed: ${String(error)}`);
	}
}
/**
* Windows 实现：user32 GetAsyncKeyState。高位（0x8000）= 键当前按住。
* VK_LBUTTON = 0x01。
*/
function createWindowsHal() {
	try {
		const lib = requireKoffi("koffi").load("user32.dll");
		const GetAsyncKeyState = lib.func("short __stdcall GetAsyncKeyState(int vKey)");
		const VK_LBUTTON = 1;
		return {
			available: true,
			isPrimaryButtonDown: () => (GetAsyncKeyState(VK_LBUTTON) & 32768) !== 0,
			dispose: () => {
				lib.unload();
			}
		};
	} catch (error) {
		return nullHal(`Windows user32 load failed: ${String(error)}`);
	}
}
/**
* Linux 实现：X11 XQueryPointer 的 button 掩码。Wayland 无全局指针 API，
* 降级为不可用（调用方退化为保守行为）。仅在有 DISPLAY 时尝试。
*/
function createLinuxHal() {
	if (process.env.DISPLAY === void 0 || process.env.DISPLAY === "") return nullHal("no X11 DISPLAY (Wayland has no global pointer API)");
	return nullHal("linux adapter not yet implemented");
}
/**
* 创建当前平台的输入 HAL（失败安全降级）。
*
* 平台选路以**运行时平台**为准（行为事实源）；`capabilities.globalPointer=false`
* 的平台（Linux Wayland 等）走 createLinuxHal → nullHal（不可用，调用方退化为
* 保守行为）。这是「该平台当前无全局指针能力」的显式降级，不是错误。
*/
function createInputHal() {
	const os = platform();
	if (os === "darwin") return createMacHal();
	if (os === "win32") return createWindowsHal();
	return createLinuxHal();
}
//#endregion
//#region lib/types/electron/platform/darwin.js
const darwinPlatform = {
	capabilities: {
		platform: "darwin",
		tray: true,
		dock: true,
		globalPointer: true,
		secretStore: "keychain",
		pathSep: "/"
	},
	terminalShell() {
		return {
			shell: process.env.SHELL ?? "/bin/zsh",
			args: ["-l"]
		};
	},
	revealCommand(realPath) {
		return {
			cmd: "open",
			args: ["-R", realPath]
		};
	},
	windowChromeOptions(kind) {
		if (kind === "floating") return {
			titleBarStyle: "hiddenInset",
			trafficLightPosition: {
				x: 16,
				y: 27
			}
		};
		return {
			titleBarStyle: "hiddenInset",
			trafficLightPosition: {
				x: 12,
				y: 13
			}
		};
	},
	passwordStore() {
		return "";
	}
};
//#endregion
//#region lib/types/electron/platform/linux.js
const linuxPlatform = {
	capabilities: {
		platform: "linux",
		tray: false,
		dock: false,
		globalPointer: false,
		secretStore: "gnome-libsecret",
		pathSep: "/"
	},
	terminalShell() {
		return {
			shell: process.env.SHELL ?? "/bin/zsh",
			args: ["-l"]
		};
	},
	revealCommand(_realPath, dirname) {
		return {
			cmd: "xdg-open",
			args: [dirname]
		};
	},
	windowChromeOptions(_kind) {
		return {};
	},
	passwordStore() {
		return process.env.CORUM_LINUX_PASSWORD_STORE ?? "gnome-libsecret";
	}
};
//#endregion
//#region lib/types/electron/platform/win32.js
/**
* Windows 平台实现（P1）。能力事实：托盘 ❌（未做，关窗即退出）/ Dock ❌（N/A）/
* 全局指针 ✅（user32 GetAsyncKeyState）。终端探测链 pwsh → powershell → cmd。
* @module corum-desktop/electron/platform/win32
*/
/** 返回 PATH 上第一个可执行的名字（探测 shell 用；候选名已带 .exe）。 */
function firstOnPath(candidates) {
	const pathEnv = process.env.PATH ?? "";
	for (const dir of pathEnv.split(";")) {
		if (dir === "") continue;
		for (const name of candidates) try {
			if (existsSync(join(dir, name))) return name;
		} catch {}
	}
}
//#endregion
//#region lib/types/electron/platform/index.js
/** 当前运行平台的实现（单例；process.platform 在进程内不变）。 */
const current = process.platform === "darwin" ? darwinPlatform : process.platform === "win32" ? {
	capabilities: {
		platform: "win32",
		tray: false,
		dock: false,
		globalPointer: true,
		secretStore: "dpapi",
		pathSep: "\\"
	},
	terminalShell() {
		const shell = firstOnPath(["pwsh.exe", "powershell.exe"]) ?? "cmd.exe";
		return {
			shell,
			args: shell === "cmd.exe" ? [] : ["-NoLogo"]
		};
	},
	revealCommand(realPath) {
		return {
			cmd: "explorer",
			args: ["/select,", realPath]
		};
	},
	windowChromeOptions(_kind) {
		return {};
	},
	passwordStore() {
		return "";
	}
} : linuxPlatform;
/** 取当前平台的实现面（行为事实源 = 实际运行平台）。 */
function getPlatformModule() {
	return current;
}
//#endregion
//#region lib/types/electron/shell-menu.js
/**
* 壳层「常驻入口」的共用菜单模板（菜单栏托盘 + Dock 右键菜单）。
*
* **为什么要共用**：macOS 上应用有两个常驻入口 —— 顶部菜单栏的 status item 与底部
* Dock 图标。同一个应用在两个入口里给出**不一样的菜单**是常见事故源：用户记不住两套
* 功能树，我们也会修一处漏一处（本仓已有「同一功能两处实现，占位那份盖住真实现」的
* 前车之鉴，见 LESSONS §4.12）。所以菜单模板只在这里写一遍，`tray.ts` 与 `dock.ts`
* 各自 `buildShellMenu()` 出一份实例（不共享同一个 Menu 对象实例：两处挂载时机与
* 重建节奏不同，各自持有更省心）。
*
* **菜单保持极简**（5 个可点项 + 状态行）：常驻入口是「回到应用」的入口，不是第二个
* 主界面 —— 调研报告里 LM Studio / Ollama 的长菜单正是用户抱怨的来源
* （`docs/plan/RESEARCH-tray-menu-bar.md` §5.3-1）。
*
* @module corum-desktop/electron/shell-menu
*/
/** 状态行文案：「3 条未读 · 共 7 条」/「7 条通知 · 全部已读」/「暂无通知」。 */
function statusLabel(count) {
	if (count.total === 0) return "暂无通知";
	if (count.unread === 0) return `${count.total} 条通知 · 全部已读`;
	return `${count.unread} 条未读 · 共 ${count.total} 条`;
}
/**
* 数字标签（菜单栏标题文字 / Dock 徽标共用）：超过 99 封顶为 `99+`。
*
* 为什么不写原值：三位数会把状态项撑宽、挤压右侧系统图标（菜单栏空间稀缺），
* Dock 徽标同理会被撑成一条；且到那个量级精确值已无决策价值。与应用内 bell 的
* `99+` 上限保持一致 —— 三处不同步会显得像 bug。
* @param unread - 未读条数（调用方保证已钳成非负整数）。
*/
function countLabel(unread) {
	return unread > 99 ? "99+" : String(unread);
}
/**
* 开机自启开关的状态。**OS 是唯一事实源**：用户在「系统设置 → 登录项」里改过之后，
* 我们这边任何缓存都会撒谎，所以每次现读。
*/
function loginItemOn() {
	try {
		return app.getLoginItemSettings().openAtLogin;
	} catch {
		return false;
	}
}
/**
* 切换开机自启。
*
* dev 态必须显式给 `path` + `args`：打包态的 execPath 就是 app 本身，而 dev 态它是
* `node_modules` 里的 Electron 二进制，不传参登录后只会打开一个空 Electron。
* （Windows 未签名时不要传 `guid`：GUID 会与可执行路径永久绑定，见调研报告 §5.3-8。）
* @param next - 目标状态。
*/
function setLoginItem(next) {
	try {
		app.setLoginItemSettings({
			openAtLogin: next,
			...app.isPackaged ? {} : {
				path: process.execPath,
				args: [process.argv[1] ?? ""]
			}
		});
	} catch (error) {
		process.stderr.write(`[corum-desktop] login item toggle failed: ${String(error)}\n`);
	}
}
/**
* 构造常驻入口菜单（菜单栏托盘与 Dock 右键菜单共用这一份模板）。
* @param count - 当前未读状态。
* @param host - 菜单动作。
* @returns 可直接交给 `tray.setContextMenu()` / `app.dock.setMenu()` 的菜单实例。
*/
function buildShellMenu(count, host) {
	return Menu.buildFromTemplate([
		{
			label: "显示主窗口",
			click: () => {
				host.showMainWindow();
			}
		},
		{
			label: count.unread > 0 ? `通知中心（${count.unread} 条未读）` : "通知中心",
			click: () => {
				host.openNotificationCenter();
			}
		},
		{ type: "separator" },
		{
			label: statusLabel(count),
			enabled: false
		},
		{ type: "separator" },
		{
			label: "开机自动启动",
			type: "checkbox",
			checked: loginItemOn(),
			click: (item) => {
				setLoginItem(item.checked);
				item.checked = loginItemOn();
			}
		},
		...getPlatformModule().capabilities.dock ? [{
			label: "隐藏 Dock 图标（只留菜单栏）",
			type: "checkbox",
			checked: host.isDockHidden(),
			click: (item) => {
				host.setDockHidden(item.checked);
			}
		}] : [],
		{ type: "separator" },
		{
			label: "退出 矩道 Corum",
			click: () => {
				host.quit();
			}
		}
	]);
}
//#endregion
//#region lib/types/electron/shell-state.js
/**
* 壳层状态文件（`~/.corum-desktop/shell.json`）。
*
* 存**主进程语义**的少量开关，与 `combos.json` 同目录同风格（`combos.ts` 先例）：
*   - `trayResidentHintShown`：常驻模式的一次性引导是否已给过（`tray.ts`）；
*   - `dockHidden`：是否隐藏 Dock 图标（只留菜单栏，`dock.ts`）。
*
* 为什么放壳层文件而不是设置中心：这些都是**随壳启动就要决定**的事（关窗是否退出、
* Dock 图标在不在），等 host / 设置服务起来就晚了；而且它们属于「这台机器的壳层
* 偏好」，不是产品级配置。
*
* @module corum-desktop/electron/shell-state
*/
/** 壳层状态文件路径（`~/.corum-desktop/shell.json`）。 */
const SHELL_STATE_PATH = join(os.homedir(), ".corum-desktop", "shell.json");
/** 读壳层状态（文件缺失/损坏一律当空状态，不能因为一个开关位挡住启动）。 */
function readShellState() {
	try {
		if (!existsSync(SHELL_STATE_PATH)) return {};
		const parsed = JSON.parse(readFileSync(SHELL_STATE_PATH, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		return parsed;
	} catch {
		return {};
	}
}
/**
* 写壳层状态（合并写：调用方只给要改的字段）。
* @param patch - 要写入的字段。
* @returns 写入后的完整状态（写失败时返回合并结果本身，调用方语义不受影响）。
*/
function patchShellState(patch) {
	const next = {
		...readShellState(),
		...patch
	};
	try {
		mkdirSync(dirname(SHELL_STATE_PATH), { recursive: true });
		writeFileSync(SHELL_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	} catch (error) {
		process.stderr.write(`[corum-desktop] shell state write failed: ${String(error)}\n`);
	}
	return next;
}
//#endregion
//#region lib/types/electron/tray.js
/**
* macOS 菜单栏常驻托盘（tray / status item）。
*
* 用户定调（2026-09-10）：「托盘常驻要做」「被遮挡时**托盘提示消息数量**」
* 「先做 macOS，Linux/Windows 放 TODO 低优先级」。
*
* 常驻的**意义**（不是「多一个图标」这么简单）：主窗关闭不再退出应用 —— 后台的
* 会话轮次、子 Agent、编排批次继续跑，用户随时经菜单栏图标回到窗口。因此本模块
* 与主进程的关窗语义是一套东西（见 `main.ts` 的 `mainWindow.on('close')`）：
* 只有托盘真的建起来了（macOS），关窗才降级为隐藏；没有托盘就维持原语义
* （关窗即退出），避免用户关掉窗口后**再也找不回**应用。
*
* 未读数是菜单栏上的**文字标题**（`tray.setTitle`），不是图标角标：
*   ① macOS 的 status item 没有「徽标」这种原生概念，能表达数字的只有标题文字；
*   ② 标题数字与通知中心 bell 的数字**同源**（都是主窗 store 里 `!read` 的条数），
*      不允许两处各算一套；
*   ③ 有未读才写数字、清零后清空标题 —— 菜单栏空间紧张，常驻的「0」是噪音。
*
* 跨平台现状：本模块**只在 darwin 上建托盘**（其余平台返回 null）。
*   - Windows：需要 16x16 `.ico` + `app.setAppUserModelId`（任务栏/通知分组），
*     且 `click`/`double-click` 语义与 mac 不同（详见
*     `docs/ASSESSMENT-tray-floating-system-notification.md`）；
*   - Linux：GNOME 无原生托盘（需 AppIndicator 扩展 + libappindicator），部分
*     桌面环境下 `click` 事件根本不触发（只能靠菜单）。
*   两条都属「先不做，记 TODO」的低优先级项，故这里显式早返回而不是留半成品。
*
* @module corum-desktop/electron/tray
*/
/**
* 托盘图标的逻辑尺寸（pt）。
*
* macOS 菜单栏高度 22pt，图标惯例 18pt（与系统图标视觉重量相当）。@2x 表示用
* 36px 位图另附，避免 Retina 下拉丝（见 `trayImage`）。
*/
const ICON_PT = 18;
/**
* 构造托盘图标：**Template Image**（只取 alpha 通道）。
*
* 为什么必须走 template：品牌图标是「深色外框 + 浅色内部」的单色图形（同一份
* 位图里既有接近黑也有接近白的像素）。直接当彩色图标用会**必然在一侧失效**——
* 深色菜单栏下黑框看不见、浅色菜单栏下白内部看不见。template 让 macOS 只用
* alpha 当形状，浅色模式画黑、深色模式画白，两种模式都自动正确。
*
* @param assetsDir - shell 静态资源目录（内含 `icon.png`）。
* @returns 18pt 图标（含 @2x 表示）；资源缺失时返回空图标（托盘退化为「只有数字」）。
*/
function trayImage(assetsDir) {
	const source = nativeImage.createFromPath(join(assetsDir, "icon.png"));
	if (source.isEmpty()) return source;
	const image = source.resize({
		width: ICON_PT,
		height: ICON_PT,
		quality: "best"
	});
	image.addRepresentation({
		scaleFactor: 2,
		width: 36,
		height: 36,
		dataURL: source.resize({
			width: 36,
			height: 36,
			quality: "best"
		}).toDataURL()
	});
	image.setTemplateImage(true);
	return image;
}
/**
* 建 macOS 菜单栏托盘。
*
* 菜单保持**极简**（三条 + 一条状态行）：托盘是「回到应用」的入口，不是第二个
* 主界面 —— 塞满菜单项是常见反模式（用户记不住两套功能树，也压缩了菜单栏价值）。
* @param host - 窗口动作与资源目录。
* @returns 托盘句柄；非 macOS 或创建失败时返回 null（调用方据此保持「关窗即退出」）。
*/
function createCorumTray(host) {
	if (process.platform !== "darwin") return null;
	let count = {
		unread: 0,
		total: 0
	};
	let tray;
	try {
		tray = new Tray(trayImage(host.assetsDir));
	} catch (error) {
		process.stderr.write(`[corum-desktop] tray unavailable: ${String(error)}\n`);
		return null;
	}
	/** 重建菜单（未读数或勾选态变化后必须重建：状态行与「通知中心」后缀都在菜单里）。 */
	const rebuildMenu = () => {
		tray.setContextMenu(buildShellMenu(count, host));
	};
	/**
	* 把未读状态同步到三处可见面：标题数字 / tooltip / 菜单状态行。
	*
	* 标题只在有未读时写：`setTitle('')` 让图标独占空间，菜单栏不常驻一个「0」。
	* `fontType: 'monospacedDigit'` 让 9→10 位宽变化时标题不左右跳动。
	*/
	const apply = () => {
		tray.setTitle(count.unread > 0 ? countLabel(count.unread) : "", { fontType: "monospacedDigit" });
		tray.setToolTip(count.unread > 0 ? `矩道 Corum · ${count.unread} 条未读通知` : "矩道 Corum · 常驻运行中");
		rebuildMenu();
	};
	apply();
	if (process.env.CORUM_DEV_HMR !== void 0) {
		process.stderr.write(`[corum-shell] tray bounds: ${JSON.stringify(tray.getBounds())}\n`);
		setTimeout(() => {
			process.stderr.write(`[corum-shell] tray bounds (settled): ${JSON.stringify(tray.getBounds())}\n`);
		}, 2e3);
	}
	let destroyed = false;
	const destroy = () => {
		if (destroyed) return;
		destroyed = true;
		tray.destroy();
	};
	app.on("before-quit", destroy);
	return {
		setCount: (next) => {
			const unread = Number.isFinite(next.unread) ? Math.max(0, Math.floor(next.unread)) : 0;
			const total = Number.isFinite(next.total) ? Math.max(0, Math.floor(next.total)) : 0;
			if (unread === count.unread && total === count.total) return;
			count = {
				unread,
				total
			};
			if (process.env.CORUM_DEV_HMR !== void 0) process.stderr.write(`[corum-shell] tray count ← ${unread}/${total}\n`);
			apply();
		},
		refresh: rebuildMenu,
		destroy
	};
}
/**
* 取「常驻模式」一次性提示的展示资格。
*
* 为什么需要它：关窗从「退出应用」变成「收到菜单栏」是**改变用户既有预期**的行为，
* 静默改掉会让人以为应用没退出干净、或以为关不掉。系统通知在未签名态发不出去
* （见 `docs/ASSESSMENT-tray-floating-system-notification.md` §0.5），而此刻窗口
* 恰好是隐藏的、应用内 toast 也看不见 —— 所以提示的**时机**改在下次启动、窗口还
* 在的时候，经应用内通知中心给出，并只在第一次给。
* @param resident - 本次是否真的处于托盘常驻模式（没有托盘就不提示）。
* @returns `firstTime` 为 true 表示这次该提示（并已就地落盘，不会重复）。
*/
function takeTrayResidentHint(resident) {
	if (!resident) return {
		resident: false,
		firstTime: false
	};
	if (readShellState().trayResidentHintShown === true) return {
		resident: true,
		firstTime: false
	};
	patchShellState({ trayResidentHintShown: true });
	return {
		resident: true,
		firstTime: true
	};
}
//#endregion
//#region lib/types/electron/ipc.js
/**
* ipcMain registration for the desktop transport: relays the renderer's
* unary/stream requests to the host bridge child process and pushes its
* stream frames back to the renderer. Also owns the shell-level combo
* management IPC (list / launch).
*
* The bridge is resolved through a getter: switching combo spawns a NEW host
* bridge child, so the IPC handlers must always act on the current instance.
* @module corum-desktop/electron/ipc
*/
/**
* Register the transport IPC handlers. Run once after app ready; the bridge
* getter returns the CURRENT host child (a combo switch swaps the instance).
* @param getBridge - returns the live host bridge child handle.
* @param getWindow - returns the current main window (or null while closed).
* @param options - optional hooks: unary observation (smoke handshake), combo
* launch (main-process spawn orchestration), tray/dock accessors (menu-bar count +
* Dock badge).
*/
function registerIpc(getBridge, getWindow, options) {
	const sendToMain = (channel, payload) => {
		const win = getWindow();
		if (win === null || win.isDestroyed()) return;
		const wc = win.webContents;
		if (wc.isDestroyed() || wc.isCrashed()) return;
		try {
			wc.send(channel, payload);
		} catch {}
	};
	ipcMain.handle("corum:host-restart", async () => {
		await getBridge()?.restart();
		return { ok: true };
	});
	ipcMain.on("corum:notifications-count", (_event, payload) => {
		const count = {
			unread: typeof payload?.unread === "number" ? payload.unread : 0,
			total: typeof payload?.total === "number" ? payload.total : 0
		};
		options?.getTray?.()?.setCount(count);
		options?.getDock?.()?.setCount(count);
	});
	ipcMain.handle("corum:tray-hint", () => {
		return takeTrayResidentHint((options?.getTray?.() ?? null) !== null);
	});
	ipcMain.handle("corum:notify-native", async (_event, request) => {
		if (!Notification.isSupported()) return {
			ok: false,
			error: "notifications unsupported"
		};
		const notification = new Notification({
			title: request.title,
			...request.body === void 0 || request.body === "" ? {} : { body: request.body },
			silent: request.silent !== false
		});
		/**
		* ⚠️ macOS（Electron 42+）用 UNNotification API，**未签名应用的通知会静默失败**：
		* `isSupported()` 仍返回 true、`show()` 不抛错，只在 Notification 上 emit
		* `failed`（UNErrorDomain error 1 = UNErrorCodeNotificationsNotAllowed）。
		*
		* 开发态跑的是 `node_modules` 里那个 `adhoc, linker-signed` 的 Electron.app，
		* UNNotification **不接受** linker-signed 签名 → 通知不显示。
		* 于是这里必须订阅 `failed` 并把结果如实回传，否则调用方会以为发送成功
		* （实测踩到：`ok:true` 但屏幕上什么都没有）。
		* 要让开发态也能看到：给 Electron.app 做**真签名**（见 docs/ASSESSMENT-*.md）。
		*/
		const outcome = await new Promise((resolve) => {
			let settled = false;
			const settle = (result) => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			notification.on("show", () => {
				settle({ ok: true });
			});
			notification.on("failed", (_event, error) => {
				settle({
					ok: false,
					error: `notification failed: ${String(error)}`
				});
			});
			setTimeout(() => {
				settle({ ok: true });
			}, 1500);
			try {
				notification.show();
			} catch (error) {
				settle({
					ok: false,
					error: String(error)
				});
			}
		});
		notification.on("click", () => {
			const win = getWindow();
			if (win !== null && !win.isDestroyed()) {
				if (win.isMinimized()) win.restore();
				if (!win.isVisible()) win.show();
				win.focus();
				if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
				try {
					win.webContents.send("corum:native-notification-clicked", { notificationId: request.notificationId ?? null });
				} catch {}
			}
		});
		return outcome;
	});
	const floatingWindows = /* @__PURE__ */ new Map();
	const notifyFloating = (slotKey, detached) => {
		sendToMain("corum:floating-change", {
			slotKey,
			detached
		});
	};
	let inputHal = null;
	const getInputHal = () => {
		inputHal ??= createInputHal();
		return inputHal;
	};
	ipcMain.handle("corum:open-floating", async (_event, request) => {
		const key = request.slotKey;
		const existing = floatingWindows.get(key);
		if (existing !== void 0 && !existing.isDestroyed()) {
			existing.focus();
			return { ok: true };
		}
		const win = new BrowserWindow({
			width: 900,
			height: 700,
			title: `corum · ${key}`,
			...getPlatformModule().windowChromeOptions("floating"),
			webPreferences: {
				preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				spellcheck: false
			}
		});
		floatingWindows.set(key, win);
		win.on("closed", () => {
			floatingWindows.delete(key);
			notifyFloating(key, false);
		});
		let lastPush = 0;
		const clearPreview = () => sendToMain("corum:floating-drag", {
			slotKey: key,
			dragging: false
		});
		const centerInsideMain = () => {
			const main = getWindow();
			if (main === null || main.isDestroyed() || win.isDestroyed()) return null;
			const fb = win.getBounds();
			const mb = main.getBounds();
			const cx = fb.x + Math.floor(fb.width / 2);
			const cy = fb.y + Math.floor(fb.height / 2);
			return {
				cx,
				cy,
				mb,
				inside: cx >= mb.x && cx <= mb.x + mb.width && cy >= mb.y && cy <= mb.y + mb.height
			};
		};
		const hal = getInputHal();
		let poll = null;
		let wasDown = false;
		const stopPoll = () => {
			if (poll !== null) {
				clearInterval(poll);
				poll = null;
			}
		};
		const startPoll = () => {
			if (poll !== null) return;
			wasDown = hal.isPrimaryButtonDown() ?? false;
			poll = setInterval(() => {
				if (win.isDestroyed()) {
					stopPoll();
					return;
				}
				const down = hal.isPrimaryButtonDown();
				if (down === null) {
					stopPoll();
					return;
				}
				const released = wasDown && !down;
				wasDown = down;
				if (!released) return;
				stopPoll();
				const cur = centerInsideMain();
				clearPreview();
				if (cur !== null && cur.inside && !win.isDestroyed()) {
					notifyFloating(key, false);
					win.close();
				}
			}, 60);
		};
		win.on("move", () => {
			const r = centerInsideMain();
			if (r === null) return;
			if (r.inside) {
				startPoll();
				if (Date.now() - lastPush > 60) {
					lastPush = Date.now();
					sendToMain("corum:floating-drag", {
						slotKey: key,
						dragging: true,
						x: r.cx - r.mb.x,
						y: r.cy - r.mb.y
					});
				}
			} else {
				stopPoll();
				clearPreview();
			}
		});
		win.on("closed", () => {
			stopPoll();
			clearPreview();
		});
		const baseUrl = getBridge()?.readyPayload?.authenticatedUrl;
		if (baseUrl === void 0) {
			win.close();
			return {
				ok: false,
				error: "no host (combo not launched)"
			};
		}
		const floatingUrl = new URL(baseUrl);
		floatingUrl.searchParams.set("floating", key);
		floatingUrl.searchParams.delete("token");
		await win.loadURL(floatingUrl.toString());
		notifyFloating(key, true);
		return { ok: true };
	});
	/**
	* Close a detached floating window (the counterpart of `corum:open-floating`).
	*
	* 为什么必须有：桥里原先只有 open —— 窗口一旦打开，程序化路径**没有任何办法关掉它**
	* （2026-09-12 验证时实测：探测完浮窗只能请用户手动关）。关闭走
	* `win.close()` → 既有 `closed` 钩子照常 `floatingWindows.delete` + 通知主窗
	* 「detached → restored」（主窗据此把被折叠的列恢复回来），所以这里不重复做状态清理。
	*
	* `slotKey` 缺省 = 关掉**所有**浮窗（退出/重置场景）；指定则只关那一个。
	* @returns `closed` = 实际关掉的数量（0 = 本来就没开，调用方无需当错误处理）。
	*/
	ipcMain.handle("corum:close-floating", (_event, request) => {
		const key = request?.slotKey;
		const targets = key === void 0 ? [...floatingWindows.entries()] : [...floatingWindows.entries()].filter(([slotKey]) => slotKey === key);
		let closed = 0;
		for (const [, win] of targets) {
			if (win.isDestroyed()) continue;
			win.close();
			closed += 1;
		}
		return {
			ok: true,
			closed
		};
	});
	ipcMain.handle("corum:save-session-log", async (_event, request) => {
		const win = getWindow();
		const bridge = getBridge();
		if (win === null || win.isDestroyed()) return {
			path: null,
			error: "no window"
		};
		if (bridge === null) return {
			path: null,
			error: "no host bridge (combo not launched)"
		};
		const safe = request.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
		const picked = await dialog.showSaveDialog(win, {
			title: "保存会话日志",
			defaultPath: `dsh-session-${safe}.zip`,
			filters: [{
				name: "Session Log",
				extensions: ["zip"]
			}]
		});
		if (picked.canceled || picked.filePath === void 0) return { path: null };
		const result = await bridge.sessionExport(request.sessionId);
		if (!result.ok || result.zipBase64 === void 0) return {
			path: null,
			error: result.error ?? "export failed"
		};
		try {
			await writeFile(picked.filePath, Buffer.from(result.zipBase64, "base64"));
			return { path: picked.filePath };
		} catch (error) {
			return {
				path: null,
				error: String(error)
			};
		}
	});
	ipcMain.handle("corum:delete-session", async (_event, request) => {
		const win = getWindow();
		const bridge = getBridge();
		if (win === null || win.isDestroyed()) return {
			deleted: false,
			error: "no window"
		};
		if (bridge === null) return {
			deleted: false,
			error: "no host bridge (combo not launched)"
		};
		if ((await dialog.showMessageBox(win, {
			type: "warning",
			title: "删除会话",
			message: "确定删除该会话？此操作不可恢复。",
			detail: "会话日志文件将被从磁盘移除，且无法通过导入以外的任何方式找回。",
			buttons: ["取消", "删除"],
			defaultId: 0,
			cancelId: 0
		})).response !== 1) return {
			deleted: false,
			cancelled: true
		};
		const result = await bridge.sessionDelete(request.sessionId);
		if (!result.ok) return {
			deleted: false,
			error: result.error ?? "delete failed"
		};
		return {
			deleted: result.deleted ?? false,
			wasLive: result.wasLive ?? false
		};
	});
	ipcMain.handle("corum:import-session-log", async () => {
		const win = getWindow();
		const bridge = getBridge();
		if (win === null || win.isDestroyed()) return {
			imported: [],
			skipped: [],
			error: "no window"
		};
		if (bridge === null) return {
			imported: [],
			skipped: [],
			error: "no host bridge (combo not launched)"
		};
		const picked = await dialog.showOpenDialog(win, {
			title: "导入会话日志",
			defaultPath: app.getPath("downloads"),
			properties: ["openFile", "multiSelections"],
			filters: [{
				name: "Session Log",
				extensions: ["zip"]
			}]
		});
		if (picked.canceled || picked.filePaths.length === 0) return {
			imported: [],
			skipped: [],
			cancelled: true
		};
		const imported = [];
		const skipped = [];
		for (const filePath of picked.filePaths) try {
			const bytes = await readFile(filePath);
			const result = await bridge.sessionImport(bytes.toString("base64"));
			if (result.ok) {
				imported.push(...result.imported ?? []);
				skipped.push(...result.skipped ?? []);
			} else return {
				imported,
				skipped,
				error: `${basename(filePath)}: ${result.error ?? "import failed"}`
			};
		} catch (error) {
			return {
				imported,
				skipped,
				error: `${basename(filePath)}: ${String(error)}`
			};
		}
		return {
			imported,
			skipped
		};
	});
	ipcMain.handle("corum:pick-directory", async (_event, request) => {
		const win = getWindow();
		if (win === null || win.isDestroyed()) return {
			path: null,
			error: "no window"
		};
		const picked = await dialog.showOpenDialog(win, {
			title: request.title ?? "选择工作目录",
			...request.defaultPath !== void 0 && request.defaultPath !== "" ? { defaultPath: request.defaultPath } : {},
			properties: ["openDirectory"]
		});
		if (picked.canceled || picked.filePaths.length === 0) return {
			path: null,
			cancelled: true
		};
		return { path: picked.filePaths[0] };
	});
	const appVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")).version;
	ipcMain.handle("corum:app-version", () => appVersion);
	/**
	* dsh 基座版本（用户 2026-10-03 定调：**侧栏只显示应用版本号，基座号��进诊断信息**）。
	*
	* 从**实际安装**的官方锚点包读，不从任何手写常量或依赖声明区间读 —— 声明区间是
	* `^0.1.5-rc.3` 这种范围，写进界面会撒谎；而 `.pnpm` 里可能同时存在多个版本
	* （实测同时有 0.1.3-alpha.1 与 0.1.5-rc.3），只有**解析后的**那一份才是真话。
	* 取不到就返回 undefined，调用方在诊断串里省略这一段，不编造。
	*/
	const dshBaselineVersion = (() => {
		try {
			const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../node_modules/@deepseek-ai/dsh-base/package.json");
			return JSON.parse(readFileSync(pkgPath, "utf8")).version;
		} catch {
			return;
		}
	})();
	ipcMain.handle("corum:dsh-baseline-version", () => dshBaselineVersion);
	ipcMain.handle("corum:combos-list", () => loadAllCombos());
	ipcMain.handle("corum:combo-launch", async (_event, request) => {
		if (options?.launchCombo === void 0) return {
			ok: false,
			error: "combo launch not wired"
		};
		return options.launchCombo(request.id);
	});
	ipcMain.handle("corum:combo-touch", (_event, request) => {
		return {
			ok: touchCombo(request.id) !== null,
			combo: findCombo(request.id)
		};
	});
}
//#endregion
//#region lib/types/electron/dock.js
/**
* macOS Dock 侧的常驻能力（未读徽标 + 右键菜单 + 图标显隐 + 遮挡时轻提示）。
*
* 与 `tray.ts` 的分工：托盘是**菜单栏**的载体（用户被别的东西挡住时也能看见未读），
* Dock 是**下方 Dock 栏**的载体。两者的可见性/损毁完全独立 —— 用户可能把菜单栏塞满、
* 也可能开了「自动隐藏 Dock」，所以**两边都要有**入口与未读提示，且数字必须同源
* （都由主窗 renderer 推送，见 `shell-menu.ts` 的说明）。
*
* 四项能力：
*   ① **未读徽标**（`app.dock.setBadge`）：Dock 图标右上角的红气泡，与菜单栏标题共用
*      同一个 `countLabel()`（`99+` 封顶），清零写 `''`。
*      ⚠️ **官方文档明写**：*"You need to ensure that your application has the permission
*      to display notifications for this method to work."*
*      （<https://www.electronjs.org/docs/latest/api/dock#docksetbadgetext-macos>）
*      本仓当前是未签名开发态 → 通知授权拿不到 → **徽标静默不显示**（实测：设置 3 条
*      未读后 Dock 图标区域红色像素为 0，且无任何报错）。所以：
*        - 代码保留（签名 + 授权到位后自动生效，属「零改动启用」）；
*        - **Dock 侧的未读在未签名阶段由菜单状态行承载**（右键 Dock 图标即可看到
*          `3 条未读 · 共 7 条`），菜单栏数字仍是主载体。
*   ② **右键菜单**（`app.dock.setMenu`）：与菜单栏托盘**同一份模板**
*      （`buildShellMenu`），保持一致的功能树。
*   ③ **图标显隐**（`app.dock.hide()/show()`）：只留菜单栏的模式，状态落在
*      `~/.corum-desktop/shell.json` 的 `dockHidden`，启动时恢复。
*      ⚠️ 官方文档的**已知问题**：*"Calling `dock.hide()` within one second of a
*      previous call will have no effect."* —— 所以本模块把显隐变更**串行化 + 至少间隔
*      1.1s**（`MIN_DOCK_CHANGE_GAP_MS`），否则连续切换会静默失效。
*   ④ **遮挡时的轻提示**（`app.dock.bounce('informational')`）：新通知到达而主窗不在
*      眼前时让 Dock 图标跳一下（1 秒）。这是**未签名阶段唯一还能用的「喊人」手段**：
*      系统通知被签名卡住，Dock 弹跳不需要任何授权。
*      官方说明：*"This method can only be used while the app is not focused; when the
*      app is focused it will return -1."* —— 即「窗口在前面时不打扰」由系统保证，
*      正是我们要的语义；再加 15s 节流防连环跳。
*
* Dock 点击还原窗口不需要额外代码：`app.on('activate')` 已经处理（见 `main.ts`）。
*
* @module corum-desktop/electron/dock
*/
/**
* 两次 Dock 显隐变更之间的最小间隔（ms）。
*
* 1.1s 而非 1s：官方文档说「1 秒内重复调用无效」，卡在边界上仍可能被系统判定为
* 同一批变更，留 100ms 余量。
*/
const MIN_DOCK_CHANGE_GAP_MS = 1100;
/** Dock 弹跳的节流间隔（ms）：同一波通知只跳一次，避免连环跳变成骚扰。 */
const BOUNCE_THROTTLE_MS = 15e3;
/**
* 建 macOS Dock 侧的常驻能力。
* @param host - 菜单动作与「该不该喊人」判定。
* @returns Dock 句柄；非 macOS 或 Dock 不可用时返回 null。
*/
function createCorumDock(host) {
	if (process.platform !== "darwin") return null;
	const dock = app.dock;
	if (dock === void 0) return null;
	let count = {
		unread: 0,
		total: 0
	};
	let hidden = readShellState().dockHidden === true;
	/** 上次显隐变更的时间戳 + 待执行的延迟变更（官方「1 秒内重复调用无效」的绕行）。 */
	let lastVisibilityChangeAt = 0;
	let pendingVisibility = null;
	/** 上次弹跳时间（节流用）。 */
	let lastBounceAt = 0;
	/**
	* 应用 Dock 图标显隐（幂等 + 串行化 + 图标重放）。
	*
	* `dock.hide()` 会把应用切成 accessory（不再出现在 Dock 与 ⌘Tab 里）—— 这正是
	* 「只留菜单栏」想要的；恢复路径是菜单栏托盘的同一个勾选项（托盘在菜单栏上始终
	* 可见，所以不存在「关掉后找不回」的死角）。
	*/
	const applyVisibility = () => {
		const run = () => {
			try {
				if (dock.isVisible() === !hidden) return;
			} catch {}
			lastVisibilityChangeAt = Date.now();
			try {
				if (hidden) {
					dock.hide();
					host.reapplyDockIcon();
				} else {
					dock.show().then(() => {
						host.reapplyDockIcon();
					});
					host.reapplyDockIcon();
				}
			} catch (error) {
				process.stderr.write(`[corum-desktop] dock visibility change failed: ${String(error)}\n`);
			}
		};
		const waited = Date.now() - lastVisibilityChangeAt;
		if (waited < MIN_DOCK_CHANGE_GAP_MS) {
			if (pendingVisibility !== null) clearTimeout(pendingVisibility);
			pendingVisibility = setTimeout(() => {
				pendingVisibility = null;
				run();
			}, MIN_DOCK_CHANGE_GAP_MS - waited);
			return;
		}
		run();
	};
	const applyBadge = () => {
		try {
			dock.setBadge(count.unread > 0 ? countLabel(count.unread) : "");
		} catch (error) {
			process.stderr.write(`[corum-desktop] dock badge failed: ${String(error)}\n`);
		}
	};
	const menu = () => {
		try {
			dock.setMenu(buildShellMenu(count, host));
		} catch (error) {
			process.stderr.write(`[corum-desktop] dock menu failed: ${String(error)}\n`);
		}
	};
	/**
	* 遮挡时轻提示：让 Dock 图标跳一下（1 秒，informational）。
	*
	* 三道闸门（缺一不可，否则会变成骚扰）：① 主窗不在眼前（`host.shouldAttractAttention`）；
	* ② 15s 节流；③ 系统层面的「应用聚焦时返回 -1」——窗口在前台时苹果自己就不跳。
	*/
	const bounce = () => {
		if (!host.shouldAttractAttention()) return;
		if (Date.now() - lastBounceAt < BOUNCE_THROTTLE_MS) return;
		lastBounceAt = Date.now();
		try {
			const id = dock.bounce("informational");
			if (process.env.CORUM_DEV_HMR !== void 0) process.stderr.write(`[corum-shell] dock bounce id=${String(id)} (>=0 表示真的跳了)\n`);
		} catch (error) {
			process.stderr.write(`[corum-desktop] dock bounce failed: ${String(error)}\n`);
		}
	};
	applyVisibility();
	applyBadge();
	menu();
	if (process.env.CORUM_DEV_HMR !== void 0) process.stderr.write(`[corum-shell] dock: visible=${String(dock.isVisible())} hidden=${String(hidden)} badge="${dock.getBadge()}" (未签名/未授权时 macOS 不绘制徽标)\n`);
	return {
		setCount: (next) => {
			const unread = Number.isFinite(next.unread) ? Math.max(0, Math.floor(next.unread)) : 0;
			const total = Number.isFinite(next.total) ? Math.max(0, Math.floor(next.total)) : 0;
			if (unread === count.unread && total === count.total) return;
			const increased = unread > count.unread;
			count = {
				unread,
				total
			};
			applyBadge();
			menu();
			if (increased) bounce();
		},
		refresh: menu,
		isHidden: () => hidden,
		setHidden: (next) => {
			if (next === hidden) return;
			hidden = next;
			patchShellState({ dockHidden: next });
			applyVisibility();
			menu();
		},
		destroy: () => {
			if (pendingVisibility !== null) {
				clearTimeout(pendingVisibility);
				pendingVisibility = null;
			}
			try {
				dock.setBadge("");
			} catch {}
		}
	};
}
//#endregion
//#region lib/types/electron/bridge-client.js
/**
* Electron-main handle to the host bridge child process: spawns the bridge
* under SYSTEM Node and parses its newline-delimited JSON protocol.
*
* Transport stance (0.1.2): the renderer talks to the host's own webserver
* over loopback HTTP, so the bridge no longer relays unary/stream traffic.
* The child reports one `ready` payload carrying the authenticatedUrl the
* main `loadURL`s; the remaining stdio surface is the session-archive ops
* (flush/export/import/delete) the shell triggers.
* @module corum-desktop/electron/bridge-client
*/
/** Import payload ceiling: 96 MiB of base64 ≈ 64 MiB of raw ZIP. Larger imports are refused at the entry. */
const MAX_IMPORT_BASE64_LENGTH = 100663296;
/** Default session-op timeout (export/import/delete). */
const SESSION_OP_TIMEOUT_MS = 3e4;
/** Quit-flush timeout: shorter, so before-quit cannot hang the exit forever. */
const SESSION_FLUSH_TIMEOUT_MS = 1e4;
/**
* The Electron main's bridge to the host child process. On construction it
* spawns the child; `ready()` resolves once the child reports its
* authenticatedUrl.
*/
var HostBridgeClient = class {
	hostNode;
	bridgePath;
	injectedEnv;
	cwd;
	child;
	pendingSessionOp = /* @__PURE__ */ new Map();
	readyListeners = /* @__PURE__ */ new Set();
	readyState;
	readyResolve;
	readyPromise;
	constructor(hostNode, bridgePath, injectedEnv, cwd) {
		this.hostNode = hostNode;
		this.bridgePath = bridgePath;
		this.injectedEnv = injectedEnv;
		this.cwd = cwd;
		this.spawn();
	}
	/** Spawn (or respawn) the host child and wire its stdout protocol. */
	spawn() {
		this.readyPromise = new Promise((resolve) => {
			this.readyResolve = resolve;
		});
		this.child = spawn(this.hostNode, [this.bridgePath], {
			stdio: [
				"pipe",
				"pipe",
				"inherit"
			],
			env: this.injectedEnv ?? process.env,
			...this.cwd !== void 0 && this.cwd !== "" ? { cwd: this.cwd } : {}
		});
		this.child.on("error", (error) => {
			process.stderr.write(`corum-desktop host bridge spawn error: ${String(error)}\n`);
		});
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			this.onLine(line);
		});
	}
	/** Resolves with the authenticatedUrl once the child reports ready. */
	ready() {
		return this.readyPromise;
	}
	/** The ready payload (undefined before the child reports). */
	get readyPayload() {
		return this.readyState;
	}
	/**
	* Hot-restart the host child: kill the current process and respawn it in
	* place. The Electron window and the renderer page stay up — only the host
	* process (and its in-memory session loop) cycles; the renderer's own
	* connection loop reconnects to the new webserver. Session state persists
	* under CORUM_HOME.
	* @returns the new generation's ready payload (a fresh authenticatedUrl).
	*/
	async restart() {
		this.child.kill();
		this.readyState = void 0;
		this.failAllPending("host restarted");
		this.spawn();
		return this.readyPromise;
	}
	/** Flush every live session's buffered log to durable storage (quit hook). */
	sessionFlush() {
		return this.sessionOp({ type: "session-flush" }, SESSION_FLUSH_TIMEOUT_MS);
	}
	/** Export one session's log ZIP (returned base64). */
	sessionExport(sessionId) {
		return this.sessionOp({
			type: "session-export",
			sessionId
		});
	}
	/** Import one exported log ZIP (base64). */
	sessionImport(zipBase64) {
		if (zipBase64.length > MAX_IMPORT_BASE64_LENGTH) return Promise.resolve({
			ok: false,
			error: "import payload too large"
		});
		return this.sessionOp({
			type: "session-import",
			zipBase64
		});
	}
	/** Physically delete one session (refused by the host while it is running). */
	sessionDelete(sessionId) {
		return this.sessionOp({
			type: "session-delete",
			sessionId
		});
	}
	/** Shared session-op dispatch (timeout-guarded). */
	sessionOp(request, timeoutMs = SESSION_OP_TIMEOUT_MS) {
		if (typeof request.type !== "string") return Promise.resolve({
			ok: false,
			error: "bad session op request"
		});
		const id = crypto.randomUUID();
		const result = new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (!this.pendingSessionOp.delete(id)) return;
				resolve({
					ok: false,
					error: "session op timed out"
				});
			}, timeoutMs);
			this.pendingSessionOp.set(id, (opResult) => {
				clearTimeout(timer);
				resolve(opResult);
			});
		});
		this.child.stdin.write(`${JSON.stringify({
			...request,
			id
		})}\n`);
		return result;
	}
	/** Fail every pending session op (restart / child death): no reply will ever arrive. */
	failAllPending(error) {
		for (const pending of this.pendingSessionOp.values()) pending({
			ok: false,
			error
		});
		this.pendingSessionOp.clear();
	}
	/** Subscribe to ready (initial spawn + every restart); returns the unsubscriber. */
	onReady(listener) {
		this.readyListeners.add(listener);
		return () => {
			this.readyListeners.delete(listener);
		};
	}
	/** Stop the child. */
	dispose() {
		this.failAllPending("host disposed");
		this.child.kill();
	}
	onLine(line) {
		if (line.trim() === "") return;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (message.type === "ready") {
			this.readyState = message;
			this.readyResolve?.(message);
			for (const listener of [...this.readyListeners]) listener(message);
		} else if (message.type === "session-op-result") {
			const pending = this.pendingSessionOp.get(message.id);
			if (pending === void 0) return;
			this.pendingSessionOp.delete(message.id);
			const { type: _type, id: _id, ...result } = message;
			pending(result);
		} else if (message.type === "error") process.stderr.write(`corum-desktop host bridge error: ${message.message}\n`);
	}
};
fileURLToPath(new URL("../bridge.js", import.meta.url));
//#endregion
//#region lib/types/electron/credentials-key.js
/**
* corum-desktop Electron main：API Key 主密钥管理（safeStorage 封装）。
*
* 安全模型（TODO「API Key 本地加密存储」落地）：
*
* - **主密钥**：32 字节随机值，首次启动生成，永久保存在
*   `$CORUM_HOME/.master-key`——保存形态是 `safeStorage.encryptString` 的
*   密文（macOS Keychain / Windows DPAPI 系统级加密），**明文主密钥从不
*   落盘**。
* - **分发**：主密钥只在 spawn host 子进程时经环境变量
*   `CORUM_CREDENTIALS_MASTER_KEY`（base64）注入；host 侧
*   `@corum/corum-credentials-local` 用它对凭证值做 AES-256-GCM 加密落盘。
*   与 dsh 的 inherited-environment 语义同构：进入进程环境的值即「该次
*   启动的显式意图」。
* - **可用性**：`safeStorage.isEncryptionAvailable()` 为 false（无桌面密钥环
*   的 headless Linux 等）时不生成密钥文件、不注入 env——host 侧加密层
*   随之进入「拒绝写密文」降级（明文存量仍可读），绝不把主密钥明文落盘。
*
* 本模块只在 Electron main 进程可用（safeStorage 在 renderer/host 不存在）。
* @module corum-desktop/electron/credentials-key
*/
/** 注入 host 子进程的主密钥环境变量名（与 corum-credentials-local 的 MASTER_KEY_ENV 一致）。 */
const MASTER_KEY_ENV = "CORUM_CREDENTIALS_MASTER_KEY";
/** 封装态主密钥文件名（$CORUM_HOME 下；safeStorage 密文，非明文）。 */
const MASTER_KEY_FILENAME = ".master-key";
/** 主密钥字节数（AES-256）。 */
const KEY_BYTES = 32;
/**
* 解析 CORUM_HOME（与 host 侧 resolveDesktopHome 同规则：显式 CORUM_HOME 优先，
* 否则 ~/.corum；不触发 legacy 迁移——main 进程不写 home，只读/建密钥文件）。
* @returns CORUM_HOME 绝对路径。
*/
function corumHome() {
	const configured = process.env.CORUM_HOME;
	if (configured !== void 0 && configured.trim() !== "") return configured;
	return join(os.homedir(), ".corum");
}
/**
* 读取或生成主密钥（base64），供注入 host 子进程。
*
* - 已存在 `$CORUM_HOME/.master-key`：`safeStorage.decryptString` 解出明文返回。
* - 不存在：生成 32 字节随机主密钥，`safeStorage.encryptString` 封装后落盘
*   （0600），返回明文。
* - safeStorage 不可用或封装文件损坏：返回 `undefined`（host 侧加密层降级，
*   见模块头）。损坏文件不覆盖——可能是钥匙串暂时不可用，保留现场。
*
* 每次 spawn host 都调用（进程内不缓存），safeStorage 加解密是一次系统调用，
* 成本可忽略。
*
* @returns base64 编码的 32 字节主密钥；不可用返回 `undefined`。
*/
function resolveMasterKeyB64() {
	if (!safeStorage.isEncryptionAvailable()) {
		process.stderr.write("[corum-desktop] safeStorage unavailable: credentials encryption disabled for this launch\n");
		return;
	}
	const file = join(corumHome(), MASTER_KEY_FILENAME);
	if (existsSync(file)) try {
		const stored = readFileSync(file, "utf8");
		const plaintext = safeStorage.decryptString(Buffer.from(stored, "base64"));
		if (Buffer.from(plaintext, "base64").length !== KEY_BYTES) {
			process.stderr.write(`[corum-desktop] ${file}: unexpected master key length; leaving the file untouched\n`);
			return;
		}
		return plaintext;
	} catch (error) {
		process.stderr.write(`[corum-desktop] ${file}: decrypt failed (${String(error)}); leaving the file untouched\n`);
		return;
	}
	const plaintext = randomBytes(KEY_BYTES).toString("base64");
	try {
		mkdirSync(corumHome(), {
			recursive: true,
			mode: 448
		});
		writeFileSync(file, safeStorage.encryptString(plaintext).toString("base64"), { mode: 384 });
		chmodSync(file, 384);
	} catch (error) {
		process.stderr.write(`[corum-desktop] ${file}: persist failed (${String(error)}); credentials encryption disabled\n`);
		return;
	}
	process.stderr.write(`[corum-desktop] generated a safeStorage-wrapped master key at ${file}\n`);
	return plaintext;
}
//#endregion
//#region lib/types/electron/main.js
/**
* corum-desktop Electron main entry: the shell (combo manager).
*
* 纯壳不携带 DSH_HOME 和 dsh 内容（cli.ts 已净化环境）：启动后先显示壳自
* 带的 combo 管理页（corumapp://combo/index.html），用户选择 combo 后，壳
* 按该 combo 注入环境变量 / 工作目录 / 覆盖规则（CORUM_COMBO_PLUGINS /
* CORUM_COMBO_PATCHES），spawn 一个独立的 dsh host 子进程（SYSTEM Node，
* lib/bridge.js），再把窗口切到 dsh client 页面（?combo=<id>）。切换 combo
* = 换 host 进程。
*
* `--smoke` 跳过 combo 页：以无 combo 的 web profile 启动 host，等待渲染端
* 连接握手（api-gateway 的 generation source 发出 `$events/result` unary 或
* 打开 `$events` 流）后退出 0。
* `--combo=<id>` 跳过 combo 页直接进入指定 combo（开发快捷方式）。
* @module corum-desktop/electron/main
*/
/**
* Whether this launch runs from a packaged bundle: the bundled host runtime
* lives at `Resources/host` only in a packaged app (extraResource). More
* reliable than `app.isPackaged`, which reports false when the binary is run
* directly (`.app/Contents/MacOS/<name>`).
*/
function isPackaged() {
	return existsSync(join(process.resourcesPath, "host", "lib", "bridge.js"));
}
function bakedTargetPlatform() {
	return "darwin";
}
/**
* 跨平台一致性断言（用户 2026-10-07 拍板：**默认开启 + 硬失败**）：
* 打包态启动早期校验「烘入的目标平台 === 实际运行平台」，不一致 ⇒ 大声报错
* 并拒绝启动（列出两者，指出这是错平台的产物）。
*
* ⚠️ 覆盖范围有限（别夸大）：它只抓「bake 值 ↔ 产物目标」错配（人为写错
* flag）；**抓不到产物内部混装**（Electron 是 Linux 而 build/node 是 Mach-O）
* ——后者由冲烟 `scripts/corum-smoke.mjs` 的 checkNodeRuntimePlatform() 抓。
* 两道守卫缺一不可（方案 §2.2 表）。
*
* 放行口 `CORUM_PLATFORM_ASSERT=off` 仅供交叉构建/仿真，使用时打印显著警告。
* 打包态未烘入常量（= 打包链漏了 define 注入）同样拒绝启动（fail-loud）。
*/
function assertRuntimePlatform() {
	const baked = bakedTargetPlatform();
	if (process.env.CORUM_PLATFORM_ASSERT === "off") {
		if (baked !== void 0 && baked !== process.platform) process.stderr.write(`[corum-desktop] ⚠️ CORUM_PLATFORM_ASSERT=off：跨平台一致性断言已放行，产物目标 "${baked}" ≠ 实际运行平台 "${process.platform}"（仅限交叉构建/仿真）\n`);
		return;
	}
	if (!isPackaged()) return;
	if (baked === void 0) {
		process.stderr.write("[corum-desktop] FATAL: 打包产物缺少烘入的目标平台常量 __CORUM_TARGET_PLATFORM__（打包链的 tsdown define 未生效）。请重跑四步打包链（build → pack:host → pack:node → pack:app）。\n");
		app.exit(1);
		return;
	}
	if (baked !== process.platform) {
		process.stderr.write(`[corum-desktop] FATAL: 这是为 "${baked}" 打的产物，却在 "${process.platform}" 上运行（错平台的产物）。请下载/构建 ${process.platform} 版本。\n`);
		app.exit(1);
	}
}
/**
* The Node binary that runs the host child. Packaged: the bundled official
* Node staged by `fetch-node.mjs` under `Resources/node`; dev: the CLI
* launcher's process.execPath.
*
* **The layout differs per platform** (2026-10-08): the POSIX archives
* (`node-v…-{darwin,linux}-….tar.gz`) put the binary at `bin/node`, but the
* Windows archive (`node-v…-win-x64.zip`) extracts a **root-level `node.exe`**
* — there is no `bin/` directory. Hardcoding `bin/node` (as this did) yields a
* nonexistent path on Windows, so `spawn` fails and the host never boots.
*/
function hostNode() {
	if (isPackaged()) {
		if (process.platform === "win32") return join(process.resourcesPath, "node", "node.exe");
		return join(process.resourcesPath, "node", "bin", "node");
	}
	return process.env.CORUM_HOST_NODE ?? "node";
}
/** Absolute path of the host bridge entry (packaged: inside Resources/host). */
function bridgePath() {
	if (isPackaged()) return join(process.resourcesPath, "host", "lib", "bridge.js");
	return join(dirname(fileURLToPath(import.meta.url)), "bridge.js");
}
/** Absolute directory of the bundled Monaco language workers. */
function monacoWorkersPath() {
	if (isPackaged()) return join(process.resourcesPath, "host", "lib", "workers");
	return join(dirname(fileURLToPath(import.meta.url)), "workers");
}
/** Absolute directory of the shell-owned static images (brand logo / ambient). */
function shellAssetsPath() {
	if (isPackaged()) return join(process.resourcesPath, "assets");
	return join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
}
/** Whether this launch is the keyless smoke check. */
const SMOKE = process.argv.includes("--smoke");
/** `--combo=<id>` 的值（如有）。兼容 `--combo=coding` 与 `--combo coding` 两种写法。 */
function comboArg() {
	for (const arg of process.argv) if (arg.startsWith("--combo=")) {
		const value = arg.slice(8);
		return value === "" ? null : value;
	}
	const idx = process.argv.indexOf("--combo");
	const value = idx >= 0 ? process.argv[idx + 1] : void 0;
	return value !== void 0 && value !== "" ? value : null;
}
/**
* 本次启动要进入的 combo。
*
* corum 已收敛为**单一编程 Agent 应用**（`BUILTIN_COMBOS` 只剩 `coding` 一个），
* 「选工作流」这一步因此变成**只有一个选项的额外点击**——用户 2026-10-07 明确要求
* 直接进主界面。故规则改为：
*   · `--combo=<id>` 显式指定 ⇒ 进它（缺省即开发/自动化快捷方式）；
*   · 否则若**只存在一个 combo** ⇒ 直接进它（当前即 IDE）；
*   · 否则（0 个或多个，例如用户自建了额外 combo）⇒ 停在壳的启动器页由用户选。
* 保留了启动器页与 `combo` 切换链路，多 combo 场景不受影响。
*/
function initialComboId() {
	const explicit = comboArg();
	if (explicit !== null) return explicit;
	const all = loadAllCombos();
	return all.length === 1 ? all[0].id : null;
}
const INITIAL_COMBO_ID = initialComboId();
/**
* Dev mode (HMR enabled): forward the renderer console to stderr so hot-swap
* logs (`corum-desktop-hmr: hot-swapped ...`) and renderer errors stay visible in
* the terminal that launched the shell. The smoke check always forwards.
*/
const DEV = process.env.CORUM_DEV_HMR !== void 0 && process.env.CORUM_DEV_HMR !== "";
let mainWindow = null;
let quitting = false;
/** macOS 菜单栏托盘（常驻入口）；非 macOS 或创建失败时为 null。 */
let tray = null;
/** macOS Dock 侧常驻能力（未读徽标 / 右键菜单 / 图标显隐）；同上。 */
let dock = null;
/** 当前 host bridge（combo 切换时整体替换）。 */
let bridge = null;
function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 1219,
		minHeight: 427,
		title: app.getLocale().startsWith("zh") ? "矩道" : "Corum",
		show: !SMOKE,
		...getPlatformModule().windowChromeOptions("main"),
		webPreferences: {
			preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: false
		}
	});
	if (DEV) {
		const [mw, mh] = mainWindow.getMinimumSize();
		console.log(`[corum-shell] window min size effective: ${mw}x${mh}`);
	}
	/**
	* 关窗语义（2026-09-10 用户定调「托盘常驻要做」）。
	*
	* 有托盘时：点红点 / ⌘W **不再退出**，而是把窗口藏起来 —— 后台的会话轮次、
	* 子 Agent、编排批次继续跑，用户经菜单栏图标随时回来（这正是「常驻」的意义；
	* 否则托盘图标会随关窗一起消失，等于没有）。
	*
	* 真正的退出只有两条路：托盘菜单「退出 矩道 Corum」与 ⌘Q —— 二者都走
	* `app.quit()`，`before-quit` 会把 `quitting` 置位并先 flush 会话日志。
	* 所以这里必须检查 `quitting`，否则退出流程会被自己的 preventDefault 卡住。
	*
	* 没有托盘（非 macOS / 托盘创建失败）时保持原语义（关窗即退出）：宁可少一个
	* 功能，也不能让用户关掉窗口后再也找不回应用。
	*/
	mainWindow.on("close", (event) => {
		if (DEV) process.stderr.write(`[corum-shell] main window close requested (tray=${tray === null ? "null" : "ready"}, quitting=${String(quitting)})\n`);
		if (quitting || tray === null) return;
		event.preventDefault();
		process.stderr.write("[corum-shell] close intercepted → hide (tray resident)\n");
		mainWindow?.hide();
	});
	mainWindow.on("closed", () => {
		if (DEV) process.stderr.write("[corum-shell] main window closed → app.quit()\n");
		mainWindow = null;
		app.quit();
	});
	if (SMOKE || DEV) {
		mainWindow.webContents.on("console-message", (details, ...rest) => {
			const message = typeof details === "object" && details !== null ? details.message ?? rest[1] : details;
			const level = typeof details === "object" && details !== null ? details.level ?? rest[0] : rest[0];
			process.stderr.write(`[renderer:${String(level)}] ${String(message)}\n`);
		});
		mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
			process.stderr.write(`[smoke] renderer failed to load: ${code} ${description}\n`);
			app.exit(1);
		});
	}
}
/**
* 把应用图标设到 Dock（dev 态默认是 electron.icns；打包态由 electron-builder 的
* `mac.icon` 写进 Info.plist）。
*
* **幂等，且必须在每次 Dock 显隐变更后重放**：`dock.hide()/show()` 会切换激活策略，
* Dock 会重新取图标，自定义图标随之丢失（回退成 bundle 图标 = dev 态的 Electron 默认
* 图标）。这类「设置过又被系统重置」的状态必须有一个可重放的入口，否则就是
* 「用户看到图标莫名其妙变回默认」这类只有肉眼能发现的 bug。
*/
function applyDockIcon() {
	if (process.platform !== "darwin") return;
	const icon = nativeImage.createFromPath(join(dirname(fileURLToPath(import.meta.url)), "../assets/icon.png"));
	if (icon.isEmpty()) {
		process.stderr.write("[corum-desktop] dock icon asset missing (assets/icon.png)\n");
		return;
	}
	app.dock?.setIcon(icon);
}
/**
* 显示并聚焦主窗口（托盘菜单「显示主窗口」与 macOS dock 点击共用一条路径）。
*
* 隐藏（`hide()`）与最小化（`minimize()`）都算「不在眼前」，必须都处理：
* 只 show 不 restore 会让窗口以图标形态停在 Dock 里，看起来像没反应。
*/
function showMainWindow() {
	if (DEV) process.stderr.write("[corum-shell] show main window\n");
	if (mainWindow === null || mainWindow.isDestroyed()) return;
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}
/** 显示主窗口并让渲染层展开通知中心（托盘菜单第二项）。 */
function openNotificationCenter() {
	showMainWindow();
	const contents = mainWindow?.webContents;
	if (contents === void 0 || contents.isDestroyed()) return;
	try {
		contents.send("corum:open-notification-center");
	} catch {}
}
/**
* 按 combo 构造 host 子进程的环境：纯壳环境（cli.ts 已净化，不含 DSH_HOME
* 等 dsh 内容）+ combo 声明的环境变量 + 插件集 / 覆盖规则的注入。
* @param combo - null 表示无 combo（smoke）：不注入任何 dsh 派生参数。
*/
function buildHostEnv(combo) {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== void 0) env[key] = value;
	const masterKey = resolveMasterKeyB64();
	if (masterKey !== void 0) env[MASTER_KEY_ENV] = masterKey;
	env.CORUM_PARENT_PID = String(process.pid);
	const baked = bakedTargetPlatform();
	if (baked !== void 0) env.CORUM_TARGET_PLATFORM = baked;
	if (combo === null) return env;
	for (const [key, value] of Object.entries(sanitizeComboEnv(combo.env))) env[key] = value;
	if (combo.plugins.length > 0) env.CORUM_COMBO_PLUGINS = combo.plugins.join(",");
	if (combo.patches.length > 0) env.CORUM_COMBO_PATCHES = combo.patches.join(",");
	return env;
}
/**
* 按 combo（或 null）spawn host 子进程。替换旧实例（combo 切换 = 换进程）；
* 热重启（同实例 restart）只换 ready 负载。dsh 页面走官方 webserver，协议集
* 无需随 host 更新。
* @returns 新 host 的 ready 负载（authenticatedUrl）。
*/
async function spawnHost(combo) {
	if (bridge !== null) bridge.dispose();
	const next = new HostBridgeClient(hostNode(), bridgePath(), buildHostEnv(combo), combo?.cwd);
	bridge = next;
	const ready = await next.ready();
	next.onReady((nextReady) => {
		if (nextReady === ready) return;
		process.stderr.write("[corum-desktop] host child restarted\n");
	});
	return ready;
}
/** 壳层 combo 启动：按 combo 注入并 spawn host，成功后窗口切到官方 dsh web 页。 */
async function launchCombo(id) {
	const combo = findCombo(id);
	if (combo === null) return {
		ok: false,
		error: `unknown combo: ${id}`
	};
	touchCombo(id);
	try {
		const ready = await spawnHost(combo);
		process.stderr.write(`[corum-desktop] combo "${combo.id}" host ready (${ready.authenticatedUrl})\n`);
		const win = mainWindow;
		if (win === null || win.isDestroyed()) return {
			ok: false,
			error: "no window"
		};
		await win.loadURL(ready.authenticatedUrl);
		return { ok: true };
	} catch (error) {
		process.stderr.write(`[corum-desktop] combo "${combo.id}" launch failed: ${String(error)}\n`);
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
async function main() {
	/**
	* 统一应用身份 —— **必须在任何 safeStorage 调用之前**（2026-09-26 修）。
	*
	* 为什么必需：macOS 上 `safeStorage` 用**应用名**选 Keychain 条目
	* （`<app.getName()> Safe Storage`）。dev 态直接跑 Electron 二进制时身份是
	* `Electron`，而打包态是 `corum-desktop`（= package.json 的 name）——两者是
	* **两个不同的 Keychain 条目**，于是同一个 home 里的 `$CORUM_HOME/.master-key`
	* 谁建的、另一方就解不开：
	*
	*   `credentials-local(encrypted): a stored credential is encrypted but the
	*    master key is unavailable`  ⇒ **整棵插件树加载失败，应用起不来**。
	*
	* 实测（4 组对照，2026-09-26）：不 setName 时 dev 解不开打包态建的密钥；
	* `app.setName('corum-desktop')` 后两边互通。故显式固定这一个名字，使
	* dev / 打包态 / 各调试端口实例**共用同一 Keychain 条目**。
	*
	* 注意：名字来源于 package.json 的 `name`（`corum-desktop`），而 showName 用的
	* `productName`（`Corum`）只影响 Dock/菜单显示 —— 改名会**换 Keychain 条目**，
	* 使既有 `.master-key` 解不开，因此这里的字面量必须与 package.json 的 `name` 保持一致。
	*/
	app.setName("corum-desktop");
	const userDataDir = process.env.CORUM_USER_DATA_DIR ?? join(os.tmpdir(), `corum-desktop-ud-${process.env.CORUM_DESKTOP_MODE ?? "minimal"}-${process.env.CORUM_DEBUG_PORT ?? "noport"}`);
	app.setPath("userData", userDataDir);
	/**
	* 单实例锁（2026-09-10 加，随托盘常驻一起来的必需项）。
	*
	* 为什么在托盘这一轮必须加：托盘图标是**每个进程一个 status item**，而「开机自启 +
	* 手动再点一次」是极容易发生的事 —— 两个进程就是菜单栏上两个一模一样的图标，
	* 用户点哪个都只说对一半（各自有自己的未读数与窗口）。锁在 `userData` 上（见上
	* 一段：按 mode + 调试端口隔离），所以不同 combo / 不同调试端口的实例仍可并存，
	* 只有「同一个实例再启动一次」会被合并到已有实例。
	*
	* 第二个实例不自己建窗口/托盘，而是把已有实例的主窗口请到前台后退出 —— 这也正好
	* 是用户点 Dock 图标或再次双击应用时的预期行为。
	*/
	assertRuntimePlatform();
	if (!app.requestSingleInstanceLock()) {
		process.stderr.write("[corum-desktop] another instance already owns the lock; handing over and exiting\n");
		app.quit();
		return;
	}
	app.on("second-instance", () => {
		showMainWindow();
	});
	const noSandboxEnv = process.env.CORUM_NO_SANDBOX;
	if (noSandboxEnv !== void 0 && noSandboxEnv !== "" ? noSandboxEnv !== "0" && noSandboxEnv.toLowerCase() !== "false" : !isPackaged()) app.commandLine.appendSwitch("no-sandbox");
	{
		const store = getPlatformModule().passwordStore();
		if (store !== "") app.commandLine.appendSwitch("password-store", store);
	}
	const disableGpuEnv = process.env.CORUM_DISABLE_GPU;
	if (disableGpuEnv !== void 0 && disableGpuEnv !== "" && disableGpuEnv !== "0" && disableGpuEnv.toLowerCase() !== "false") app.commandLine.appendSwitch("disable-gpu");
	const debugPort = process.env.CORUM_DEBUG_PORT;
	if (debugPort !== void 0 && debugPort !== "") {
		app.commandLine.appendSwitch("remote-debugging-port", debugPort);
		app.commandLine.appendSwitch("remote-allow-origins", "*");
		app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
	}
	registerSchemes();
	await app.whenReady();
	try {
		const ses = session.defaultSession;
		if (ses !== null && ses !== void 0) {
			const stale = (await ses.cookies.get({})).filter((c) => c.name.startsWith("dsh-auth-") && (c.domain === "127.0.0.1" || c.domain === "localhost" || c.domain === ".127.0.0.1" || c.domain === ".localhost"));
			for (const c of stale) {
				const scheme = c.secure ? "https" : "http";
				const domain = (c.domain ?? "").replace(/^\./, "");
				await ses.cookies.remove(`${scheme}://${domain}`, c.name);
			}
			if (stale.length > 0) process.stderr.write(`[corum-desktop] purged ${stale.length} stale dsh-auth-* cookie(s)\n`);
		}
	} catch (error) {
		process.stderr.write(`[corum-desktop] dsh-auth cookie purge failed: ${String(error)}\n`);
	}
	applyDockIcon();
	registerProtocols(monacoWorkersPath(), shellAssetsPath());
	registerIpc(() => bridge, () => mainWindow, {
		launchCombo,
		getTray: () => tray,
		getDock: () => dock
	});
	createWindow();
	if (!SMOKE) {
		const menuHost = {
			showMainWindow,
			openNotificationCenter,
			quit: () => {
				app.quit();
			},
			isDockHidden: () => dock?.isHidden() ?? false,
			setDockHidden: (hidden) => {
				dock?.setHidden(hidden);
				tray?.refresh();
				dock?.refresh();
			}
		};
		const caps = getPlatformModule().capabilities;
		if (caps.dock) dock = createCorumDock({
			...menuHost,
			reapplyDockIcon: applyDockIcon,
			shouldAttractAttention: () => {
				const win = mainWindow;
				if (win === null || win.isDestroyed()) return true;
				return !win.isVisible() || win.isMinimized() || !win.isFocused();
			}
		});
		if (caps.tray) tray = createCorumTray({
			...menuHost,
			assetsDir: shellAssetsPath()
		});
		process.stderr.write(`[corum-desktop] tray: ${tray === null ? "unavailable (non-darwin or failed)" : "ready"}\n`);
		process.stderr.write(`[corum-desktop] dock: ${dock === null ? "unavailable (non-darwin or failed)" : "ready"}\n`);
	}
	process.stderr.write("[corum-desktop] window created (combo launcher)\n");
	if (SMOKE) {
		const ready = await spawnHost(null);
		process.stderr.write(`[corum-desktop smoke] authenticatedUrl: ${ready.authenticatedUrl}\n`);
		if (await (async () => {
			for (let attempt = 0; attempt < 10; attempt++) {
				try {
					const response = await fetch(ready.authenticatedUrl, {
						redirect: "manual",
						signal: AbortSignal.timeout(5e3)
					});
					process.stderr.write(`[corum-desktop smoke] attempt ${attempt}: HTTP ${response.status}\n`);
					if (response.status === 303) return true;
					if (response.status === 401) return false;
				} catch (error) {
					process.stderr.write(`[corum-desktop smoke] attempt ${attempt}: ${String(error)}\n`);
				}
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			return false;
		})()) {
			process.stdout.write("corum-desktop smoke: host child + webserver + authenticatedUrl OK\n");
			app.quit();
		} else {
			process.stderr.write("corum-desktop smoke failed: webserver unreachable at reported authenticatedUrl\n");
			app.exit(1);
		}
	} else if (INITIAL_COMBO_ID !== null) {
		const combo = findCombo(INITIAL_COMBO_ID);
		if (combo === null) {
			process.stderr.write(`[corum-desktop] unknown combo: ${INITIAL_COMBO_ID}; falling back to the launcher\n`);
			await mainWindow?.loadURL("corumapp://combo/index.html");
		} else await launchCombo(combo.id);
	} else await mainWindow?.loadURL("corumapp://combo/index.html");
}
app.on("activate", (_event, hasVisibleWindows) => {
	if (DEV) process.stderr.write(`[corum-shell] activate (hasVisibleWindows=${String(hasVisibleWindows)})\n`);
	if (mainWindow === null || mainWindow.isDestroyed()) return;
	showMainWindow();
});
app.on("window-all-closed", () => {
	if (DEV) process.stderr.write("[corum-shell] window-all-closed → app.quit()\n");
	app.quit();
});
app.on("before-quit", (event) => {
	if (quitting) return;
	event.preventDefault();
	quitting = true;
	(async () => {
		try {
			if (bridge !== null) {
				const result = await bridge.sessionFlush();
				process.stderr.write(`[corum-desktop] quit flush: ${result.ok ? `${result.flushed ?? 0} session(s) flushed` : `failed: ${result.error ?? "?"}`}\n`);
			}
		} catch (error) {
			process.stderr.write(`[corum-desktop] quit flush error: ${String(error)}\n`);
		} finally {
			bridge?.dispose();
			app.exit(0);
		}
	})();
});
main().catch((error) => {
	console.error("corum-desktop fatal:", error instanceof Error ? error.stack ?? error.message : String(error));
	app.exit(1);
});
//#endregion
export {};
