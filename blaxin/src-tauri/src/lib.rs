use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent}};

struct ServerState {
    child: Mutex<Option<Child>>,
}

fn find_node_binary() -> String {
    let paths = [
        "/usr/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/snap/bin/node",
    ];

    for path in &paths {
        if std::path::Path::new(path).exists() {
            return path.to_string();
        }
    }

    "node".to_string()
}

fn find_project_root() -> std::path::PathBuf {
    let exe_path = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let exe_dir = exe_path.parent().unwrap_or(std::path::Path::new("."));

    let mut candidate = exe_dir.to_path_buf();

    for _ in 0..6 {
        if candidate.join("server").join("package.json").exists() {
            return candidate;
        }
        if candidate.join("package.json").exists() && candidate.join("server").exists() {
            return candidate;
        }
        if !candidate.pop() {
            break;
        }
    }

    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
}

fn start_server(project_root: &std::path::Path) -> Result<Child, String> {
    let server_dir = project_root.join("server");

    if !server_dir.exists() {
        return Err(format!("Server directory not found at {:?}", server_dir));
    }

    // Check if node_modules exists, if not, install dependencies
    let node_modules = server_dir.join("node_modules");
    if !node_modules.exists() {
        eprintln!("[BLAXIN] Installing server dependencies...");
        let npm_install = Command::new("npm")
            .arg("install")
            .current_dir(&server_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run npm install: {}", e))?;

        let _ = npm_install.wait_with_output();
    }

    // Check if TypeScript is compiled, if not build it
    let dist_dir = server_dir.join("dist");
    let src_index = server_dir.join("src").join("index.ts");
    if !dist_dir.exists() && src_index.exists() {
        eprintln!("[BLAXIN] Building server TypeScript...");
        let tsc = Command::new("npx")
            .args(["tsc"])
            .current_dir(&server_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to build TypeScript: {}", e))?;
        let _ = tsc.wait_with_output();
    }

    let node_bin = find_node_binary();
    eprintln!("[BLAXIN] Starting server with node at: {}", node_bin);
    eprintln!("[BLAXIN] Server dir: {:?}", server_dir);

    // Use tsx to run TypeScript directly (avoids need to pre-compile)
    let child = Command::new(&node_bin)
        .args(["--import", "tsx", "src/index.ts"])
        .current_dir(&server_dir)
        .env("PORT", "3001")
        .env("NODE_ENV", "production")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start server: {}. Is Node.js installed? ({})", e, node_bin))?;

    Ok(child)
}

fn wait_for_server(timeout: Duration) -> bool {
    let start = Instant::now();
    eprintln!("[BLAXIN] Waiting for server to be ready...");

    loop {
        if start.elapsed() > timeout {
            eprintln!("[BLAXIN] Server startup timed out after {:?}", timeout);
            return false;
        }

        match std::net::TcpStream::connect("127.0.0.1:3001") {
            Ok(_) => {
                eprintln!("[BLAXIN] Server is ready!");
                return true;
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(200));
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server_state = ServerState {
        child: Mutex::new(None),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(server_state)
        .setup(|app| {
            // Set up system tray
            setup_tray(app.handle());

            let project_root = find_project_root();
            eprintln!("[BLAXIN] Project root: {:?}", project_root);

            // Start the Node.js server
            match start_server(&project_root) {
                Ok(child) => {
                    let state = app.state::<ServerState>();
                    *state.child.lock().unwrap() = Some(child);

                    // Wait for the server to be ready
                    if wait_for_server(Duration::from_secs(20)) {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    } else {
                        eprintln!("[BLAXIN] Server failed to start within timeout");
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[BLAXIN] Failed to start server: {}", e);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray instead of closing
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(not(debug_assertions))]
                {
                    api.prevent_close();
                    if let Some(w) = window.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }
        })
        .on_event(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<ServerState>();
                if let Some(mut child) = state.child.lock().unwrap().take() {
                    eprintln!("[BLAXIN] Shutting down server...");
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running BLAXIN");
}
