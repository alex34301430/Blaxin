use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

struct ServerState {
    child: Mutex<Option<Child>>,
}

fn find_node_binary() -> String {
    // Try common paths
    let paths = [
        "/usr/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        // Snap-installed Node
        "/snap/bin/node",
    ];
    
    for path in &paths {
        if std::path::Path::new(path).exists() {
            return path.to_string();
        }
    }
    
    // Fall back to PATH lookup
    "node".to_string()
}

fn find_project_root() -> std::path::PathBuf {
    // The binary is in src-tauri/target/release/blaxin
    // The project root is 3 levels up
    let exe_path = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let exe_dir = exe_path.parent().unwrap_or(std::path::Path::new("."));
    
    // In development: src-tauri/target/debug/blaxin -> go up 4 levels
    // In production (bundled): the resources are alongside
    let mut candidate = exe_dir.to_path_buf();
    
    // Walk up to find the project root (look for server/package.json)
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
    
    // Fallback: assume we're in the blaxin directory
    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
}

fn start_server(project_root: &std::path::Path) -> Result<Child, String> {
    let server_dir = project_root.join("server");
    
    if !server_dir.exists() {
        return Err(format!("Server directory not found at {:?}", server_dir));
    }
    
    // Check if node_modules exists, if not, we need to install
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
    
    let node_bin = find_node_binary();
    eprintln!("[BLAXIN] Starting server with node at: {}", node_bin);
    eprintln!("[BLAXIN] Server dir: {:?}", server_dir);
    
    let child = Command::new(&node_bin)
        .args(["--import", "tsx", "src/index.ts"])
        .current_dir(&server_dir)
        .env("PORT", "3001")
        .env("NODE_ENV", "production")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start server: {}. Is Node.js installed?", e))?;
    
    Ok(child)
}

fn wait_for_server(timeout: Duration) -> bool {
    let start = Instant::now();
    let url = "http://localhost:3001/api/health";
    
    eprintln!("[BLAXIN] Waiting for server to be ready...");
    
    loop {
        if start.elapsed() > timeout {
            eprintln!("[BLAXIN] Server startup timed out after {:?}", timeout);
            return false;
        }
        
        // Try to connect to the health endpoint
        match std::net::TcpStream::connect("127.0.0.1:3001") {
            Ok(_) => {
                // Port is open, server is likely ready
                eprintln!("[BLAXIN] Server is ready!");
                return true;
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
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
            let project_root = find_project_root();
            eprintln!("[BLAXIN] Project root: {:?}", project_root);
            
            // Start the Node.js server
            match start_server(&project_root) {
                Ok(child) => {
                    let state = app.state::<ServerState>();
                    *state.child.lock().unwrap() = Some(child);
                    
                    // Wait for the server to be ready
                    if wait_for_server(Duration::from_secs(15)) {
                        // Show the window
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    } else {
                        eprintln!("[BLAXIN] Server failed to start within timeout");
                        // Show window anyway with error
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[BLAXIN] Failed to start server: {}", e);
                    // Show window anyway
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                    }
                }
            }
            
            Ok(())
        })
        .on_event(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill the server process
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
