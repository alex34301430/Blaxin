use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Manager,
    tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent},
};
use tauri_plugin_updater::UpdaterExt;

struct ServerState {
    child: Mutex<Option<Child>>,
}

struct AppState {
    server_state: ServerState,
}

/// Find the bundled Node.js binary from Tauri resources.
/// In production, this is at <resource_dir>/node/bin/node.
/// In dev mode, fall back to system node.
fn find_bundled_node(resource_dir: &Path) -> Option<String> {
    // Try bundled node first (production build)
    let bundled = resource_dir.join("node").join("bin").join("node");
    if bundled.exists() {
        eprintln!("[BLAXIN] Using bundled node: {:?}", bundled);
        return Some(bundled.to_string_lossy().to_string());
    }
    None
}

fn find_system_node() -> Option<String> {
    let paths = [
        "/usr/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/snap/bin/node",
    ];

    for path in &paths {
        if Path::new(path).exists() {
            return Some(path.to_string());
        }
    }

    Command::new("which")
        .arg("node")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()
        .and_then(|child| {
            child.wait_with_output().ok().and_then(|output| {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() && Path::new(&path).exists() {
                    Some(path)
                } else {
                    None
                }
            })
        })
}

fn find_node_binary(resource_dir: &Path) -> Option<String> {
    // In production: use bundled node. In dev: use system node.
    find_bundled_node(resource_dir).or_else(find_system_node)
}

/// Find the server directory - either bundled resource or development source
fn find_server_dir(resource_dir: &Path) -> Option<PathBuf> {
    // Production: bundled server in resources
    let bundled_server = resource_dir.join("blaxin-server");
    if bundled_server.join("dist").join("index.js").exists() {
        eprintln!("[BLAXIN] Using bundled server at {:?}", bundled_server);
        return Some(bundled_server);
    }

    // Development: server in project tree
    let exe_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = exe_path.parent().unwrap_or(Path::new("."));

    let mut candidate = exe_dir.to_path_buf();
    for _ in 0..8 {
        if candidate.join("server").join("dist").join("index.js").exists() {
            return Some(candidate.join("server"));
        }
        if candidate.join("server").join("package.json").exists() {
            return Some(candidate.join("server"));
        }
        if !candidate.pop() {
            break;
        }
    }

    // Last resort: current directory
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let server = cwd.join("server");
    if server.exists() {
        return Some(server);
    }

    None
}

fn start_server(resource_dir: &Path) -> Result<Child, String> {
    let node_bin = find_node_binary(resource_dir).ok_or_else(|| {
        "Node.js runtime not found. The application may be misconfigured.".to_string()
    })?;

    let server_dir = find_server_dir(resource_dir).ok_or_else(|| {
        "Server directory not found. The application may be misconfigured.".to_string()
    })?;

    // Determine entry point: compiled dist/index.js or TypeScript src/index.ts
    let (entry_args, entry_dir): (Vec<String>, PathBuf) = if server_dir.join("dist").join("index.js").exists() {
        eprintln!("[BLAXIN] Starting compiled server from dist/index.js");
        (vec![
            server_dir.join("dist").join("index.js").to_string_lossy().to_string(),
        ], server_dir.clone())
    } else if server_dir.join("src").join("index.ts").exists() {
        eprintln!("[BLAXIN] Starting TypeScript server with tsx");
        (vec![
            "--import".to_string(),
            "tsx".to_string(),
            server_dir.join("src").join("index.ts").to_string_lossy().to_string(),
        ], server_dir.clone())
    } else {
        return Err(format!(
            "No server entry point found in {:?}", server_dir
        ));
    };

    eprintln!("[BLAXIN] Node binary: {}", node_bin);
    eprintln!("[BLAXIN] Server dir: {:?}", entry_dir);
    eprintln!("[BLAXIN] Entry args: {:?}", entry_args);

    let child = Command::new(&node_bin)
        .args(&entry_args)
        .current_dir(&entry_dir)
        .env("PORT", "3001")
        .env("NODE_ENV", "production")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!("Failed to start server: {}", e)
        })?;

    Ok(child)
}

fn wait_for_server(timeout: Duration) -> bool {
    let start = Instant::now();
    eprintln!("[BLAXIN] Waiting for server to be ready...");

    loop {
        if start.elapsed() > timeout {
            eprintln!(
                "[BLAXIN] Server startup timed out after {:?}",
                timeout
            );
            return false;
        }

        match std::net::TcpStream::connect("127.0.0.1:3001") {
            Ok(_) => {
                eprintln!("[BLAXIN] Server is ready!");
                return true;
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

fn setup_tray(app: &AppHandle) {
    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("BLAXIN — AI Desktop Agent")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)
        .expect("Failed to create tray icon");
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<serde_json::Value, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    match update {
        Some(update) => Ok(serde_json::json!({
            "updateAvailable": true,
            "currentVersion": update.current_version,
            "latestVersion": update.version,
            "downloadUrl": update.download_url,
            "releaseNotes": update.body.unwrap_or_default(),
        })),
        None => Ok(serde_json::json!({
            "updateAvailable": false,
        })),
    }
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<serde_json::Value, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    match update {
        Some(update) => {
            update
                .download_and_install(
                    |_chunk_length, _total_content_length| {
                        // Progress callback - could emit events to frontend
                    },
                    || {
                        eprintln!("[BLAXIN] Download complete, installing update...");
                    },
                )
                .await
                .map_err(|e| format!("Update installation failed: {}", e))?;

            Ok(serde_json::json!({
                "success": true,
                "message": "Update installed. BLAXIN will restart.",
            }))
        }
        None => Ok(serde_json::json!({
            "success": false,
            "message": "No update available",
        })),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server_state = ServerState {
        child: Mutex::new(None),
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState { server_state })
        .invoke_handler(tauri::generate_handler![
            check_for_updates,
            install_update,
        ])
        .setup(|app| {
            // Set up system tray
            setup_tray(app.handle());

            // Resolve resource directory for bundled node + server
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
            eprintln!("[BLAXIN] Resource dir: {:?}", resource_dir);

            // Start the Node.js server
            match start_server(&resource_dir) {
                Ok(child) => {
                    let state = app.state::<AppState>();
                    *state.server_state.child.lock().unwrap() = Some(child);

                    // Wait for the server to be ready in a background thread
                    let app_handle = app.handle().clone();
                    std::thread::spawn(move || {
                        if wait_for_server(Duration::from_secs(30)) {
                            if let Some(window) =
                                app_handle.get_webview_window("main")
                            {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        } else {
                            eprintln!(
                                "[BLAXIN] Server failed to start within timeout"
                            );
                            // Show the window anyway so user can see diagnostics
                            if let Some(window) =
                                app_handle.get_webview_window("main")
                            {
                                let _ = window.show();
                            }
                        }
                    });
                }
                Err(e) => {
                    eprintln!("[BLAXIN] Failed to start server: {}", e);
                    // Show the window anyway so user can see diagnostics
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|_window, _event| {
            // Minimize to tray instead of closing
            #[cfg(not(debug_assertions))]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                api.prevent_close();
                if let Some(w) = _window.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running BLAXIN");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                if let Some(mut child) =
                    state.server_state.child.lock().unwrap().take()
                {
                    eprintln!("[BLAXIN] Shutting down server...");
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
