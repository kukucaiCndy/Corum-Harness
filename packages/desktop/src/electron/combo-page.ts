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
const LUCIDE_FALLBACK: Record<string, string> = {
  'code-2': '💻',
  'palette': '🎨',
  'bug': '🐛',
  'message-circle': '💬',
  'monitor-smartphone': '📱',
}

/**
 * 生成 combo 管理页 HTML。每次请求时构建（页面无状态，纯静态）。
 */
export function renderComboPageHtml(): string {
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
  </script>
</body>
</html>
`
}
