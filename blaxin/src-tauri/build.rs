fn main() {
    tauri_build::build();

    // Embed the Tauri updater public key (from tauri.conf.json) into the
    // binary so the .deb self-updater can verify release signatures without
    // shipping the key twice. The key is the base64 of a minisign public key.
    //
    // Build-time override (testing): set BLAXIN_UPDATE_PUBKEY_OVERRIDE to a
    // base64 minisign public key. Also honored at runtime via the
    // BLAXIN_UPDATE_PUBKEY environment variable (see src/update.rs).
    if let Ok(key) = std::env::var("BLAXIN_UPDATE_PUBKEY_OVERRIDE") {
        if !key.trim().is_empty() {
            println!("cargo:rustc-env=BLAXIN_UPDATE_PUBKEY={}", key.trim());
            return;
        }
    }

    let conf = std::fs::read_to_string("tauri.conf.json").unwrap_or_default();
    for line in conf.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("\"pubkey\":") {
            let v = rest
                .trim()
                .trim_start_matches(':')
                .trim()
                .trim_matches('"')
                .trim();
            if v.len() >= 50 {
                println!("cargo:rustc-env=BLAXIN_UPDATE_PUBKEY={}", v);
                return;
            }
        }
    }
    // No key found — fall back to an empty marker so the app still builds.
    println!("cargo:rustc-env=BLAXIN_UPDATE_PUBKEY=");
}