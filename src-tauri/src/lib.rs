use axum::{Json, Router, routing::post, extract::State, response::IntoResponse, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

// ─── 数据结构 ────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskRequest {
    pub platform: String,    // "deepseek" | "yuanbao" | "kimi" | "tongyi" | "all"
    pub question: String,
    #[serde(default)]
    pub deep_think: bool,    // 是否启用深度思考
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskResponse {
    pub platform: String,
    pub answer: String,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiAskResponse {
    pub results: Vec<AskResponse>,
    pub total_duration_ms: u64,
}

// ─── 共享状态 ────────────────────────

pub struct AppState {
    /// 待发送队列：前端推入 → Rust 注入 WebView
    pending_asks: Arc<Mutex<Vec<AskRequest>>>,
}

// ─── Tauri 命令 ──────────────────────

/// 前端调用：统一输入栏发送消息
#[tauri::command]
async fn send_to_platform(
    state: tauri::State<'_, AppState>,
    platform: String,
    question: String,
    deep_think: bool,
) -> Result<String, String> {
    let req = AskRequest { platform: platform.clone(), question, deep_think };
    let mut pending = state.pending_asks.lock().await;
    pending.push(req);
    Ok(format!("已投递到 {}（等待回复...）", platform))
}

/// 前端调用：获取所有平台列表
#[tauri::command]
fn get_platforms() -> Vec<PlatformInfo> {
    vec![
        PlatformInfo {
            id: "deepseek".into(),
            name: "DeepSeek".into(),
            url: "https://chat.deepseek.com/".into(),
            enabled: true,
            icon: "🧠".into(),
        },
        PlatformInfo {
            id: "yuanbao".into(),
            name: "元宝".into(),
            url: "https://yuanbao.tencent.com/".into(),
            enabled: true,
            icon: "💰".into(),
        },
        PlatformInfo {
            id: "kimi".into(),
            name: "Kimi".into(),
            url: "https://kimi.moonshot.cn/".into(),
            enabled: true,
            icon: "🚀".into(),
        },
        PlatformInfo {
            id: "tongyi".into(),
            name: "通义千问".into(),
            url: "https://tongyi.aliyun.com/".into(),
            enabled: false,
            icon: "☁️".into(),
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformInfo {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    pub icon: String,
}

// ─── HTTP API 服务器（供外部 Agent 调用）───

async fn http_ask(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AskRequest>,
) -> impl IntoResponse {
    let platform = req.platform.clone();
    let mut pending = state.pending_asks.lock().await;
    pending.push(req);
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "status": "queued",
            "platform": platform,
            "message": "问题已投递，等待平台回复"
        })),
    )
}

async fn http_health() -> impl IntoResponse {
    Json(serde_json::json!({"status": "ok", "service": "polyai-http-api"}))
}

// ─── 启动 ────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState {
        pending_asks: Arc::new(Mutex::new(Vec::new())),
    });

    // 在后台线程启动 HTTP API 服务
    let http_state = app_state.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let app = Router::new()
                .route("/health", axum::routing::get(http_health))
                .route("/ask", post(http_ask))
                .with_state(http_state);

            let listener = tokio::net::TcpListener::bind("127.0.0.1:9876")
                .await
                .expect("HTTP API 启动失败");
            println!("⚡ PolyAI HTTP API → http://127.0.0.1:9876");
            axum::serve(listener, app).await.unwrap();
        });
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            send_to_platform,
            get_platforms,
        ])
        .setup(|app| {
            println!("🚀 PolyAI 启动成功");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("PolyAI 启动失败");
}
