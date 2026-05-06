// PolyAI 前端 —— 多平台 AI WebView + 统一输入栏
const { invoke } = window.__TAURI__?.core ?? {};

// ─── 平台配置 ────────────────────────

interface Platform {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  icon: string;
}

// 硬编码平台列表（首次加载，后续可通过 Tauri 命令获取）
const PLATFORMS: Platform[] = [
  { id: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com/", enabled: true, icon: "🧠" },
  { id: "yuanbao",  name: "元宝",     url: "https://yuanbao.tencent.com/",  enabled: true, icon: "💰" },
  { id: "kimi",     name: "Kimi",     url: "https://kimi.moonshot.cn/",     enabled: true, icon: "🚀" },
  { id: "tongyi",   name: "通义千问", url: "https://tongyi.aliyun.com/",    enabled: false, icon: "☁️" },
];

// ─── 全局状态 ────────────────────────

let deepThink = false;

// ─── 初始化 ──────────────────────────

function init() {
  renderGrid();
  bindEvents();
  checkApiHealth();
}

function renderGrid() {
  const grid = document.getElementById("grid")!;
  grid.innerHTML = PLATFORMS.map((p, i) => `
    <div class="panel ${p.enabled ? '' : 'disabled'}" id="panel-${p.id}">
      <div class="panel-header">
        <span class="icon">${p.icon}</span>
        <span>${p.name}</span>
        ${!p.enabled ? '<span style="color:#666;font-size:10px">(未启用)</span>' : ''}
        <span style="flex:1"></span>
        <span style="font-size:10px;color:#555">标签 ${i + 1}</span>
      </div>
      ${p.enabled
        ? `<webview src="${p.url}" id="wv-${p.id}" allowpopups></webview>`
        : `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#444;">暂未启用</div>`
      }
    </div>
  `).join("");

  // 注入反爬脚本到每个 webview
  PLATFORMS.filter(p => p.enabled).forEach(p => {
    const wv = document.getElementById(`wv-${p.id}`) as any;
    if (!wv) return;
    wv.addEventListener("dom-ready", () => {
      injectAntiDetection(wv, p.id);
    });
  });
}

// ─── 反爬注入 ────────────────────────

function injectAntiDetection(wv: any, platformId: string) {
  const scripts = [
    // 1. 隐藏 webdriver 标记
    `Object.defineProperty(navigator, 'webdriver', { get: () => false });`,
    // 2. 补全 chrome 对象
    `window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };`,
    // 3. 伪装 plugins 数量
    `Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });`,
    // 4. 伪装 languages
    `Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en'] });`,
    // 5. 移除 CDP 检测
    `Object.defineProperty(navigator, 'permissions', { value: { query: async () => ({ state: 'prompt' }) } });`,
  ];

  scripts.forEach(js => {
    try { wv.executeJavaScript(js); } catch (e) {}
  });

  console.log(`🛡️ 反爬已注入 → ${platformId}`);
}

// ─── 发送逻辑 ────────────────────────

function bindEvents() {
  const input = document.getElementById("question") as HTMLInputElement;
  const btnSend = document.getElementById("btn-send")!;
  const btnDeep = document.getElementById("btn-deep")!;

  // 回车发送
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendAll();
  });

  // 点击发送
  btnSend.addEventListener("click", sendAll);

  // 深度思考切换
  btnDeep.addEventListener("click", () => {
    deepThink = !deepThink;
    btnDeep.classList.toggle("active", deepThink);
  });
}

async function sendAll() {
  const input = document.getElementById("question") as HTMLInputElement;
  const question = input.value.trim();
  if (!question) return;

  input.value = "";
  updateStatus(`发送中: "${question.slice(0, 30)}..."`);

  for (const p of PLATFORMS.filter(p => p.enabled)) {
    await sendToPlatform(p, question);
  }

  updateStatus("已投递到所有平台，等待回复...");
}

async function sendToPlatform(platform: Platform, question: string) {
  const wv = document.getElementById(`wv-${platform.id}`) as any;
  if (!wv) return;

  const fullText = deepThink ? `[深度思考模式] ${question}` : question;

  // 注入发送脚本
  const script = `
    (function() {
      // 通用策略：找输入框 → 填文字 → 找发送按钮 → 点
      const inputs = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
      const visibleInputs = Array.from(inputs).filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      if (visibleInputs.length === 0) return 'no_input';

      const input = visibleInputs[visibleInputs.length - 1]; // 通常最后一个输入框
      input.focus();

      // 填文字（兼容 contenteditable）
      if (input.contentEditable === 'true') {
        input.textContent = ${JSON.stringify(fullText)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        input.value = ${JSON.stringify(fullText)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // 找发送按钮
      setTimeout(() => {
        const btns = document.querySelectorAll('button, [role="button"], div[class*="send"], svg[class*="send"]');
        for (const btn of btns) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.right > window.innerWidth * 0.5) {
            btn.click();
            return 'sent';
          }
        }
        // 备选：按 Enter 发送
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }, 300);

      return 'filled';
    })();
  `;

  try {
    const result = await wv.executeJavaScript(script);
    console.log(`📤 ${platform.name}: ${result}`);
  } catch (e) {
    console.warn(`⚠️ ${platform.name} 发送失败:`, e);
  }
}

// ─── API 健康检查 ────────────────────

async function checkApiHealth() {
  try {
    const r = await fetch("http://127.0.0.1:9876/health");
    if (r.ok) {
      document.getElementById("api-status")!.textContent = "API 在线";
    }
  } catch {
    document.getElementById("api-status")!.textContent = "API 未启动";
  }
  setTimeout(checkApiHealth, 30000); // 每 30s 重试
}

// ─── 状态更新 ────────────────────────

function updateStatus(msg: string) {
  document.getElementById("api-status")!.textContent = msg;
}

// ─── 启动 ────────────────────────────

document.addEventListener("DOMContentLoaded", init);
