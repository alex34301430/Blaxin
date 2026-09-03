// ═══════════════════════════════════════════════════════════════════════
// BLAXIN — Secure self-update for .deb installs
//
// Tauri's built-in updater (tauri-plugin-updater) only auto-updates the
// AppImage on Linux. BLAXIN installed from the .deb package (the
// recommended path on Debian/Ubuntu/Kali) therefore gets its own update
// pipeline here:
//
//   1. fetch the signed manifest (latest.json) over HTTPS
//   2. require the version to be strictly newer (semver)
//   3. download the .deb to a temp file
//   4. verify the minisign signature against the embedded public key
//   5. verify the SHA-256 checksum
//   6. install with `pkexec dpkg -i` (one OS auth prompt — the safe
//      boundary for a system-level change)
//   7. relaunch the app
//
// Security rules: anything failing verification aborts BEFORE the package
// is ever installed; the running installation is never modified until a
// fully verified package is ready. A corrupt/tampered/signature-failed
// artifact is deleted and the current version keeps running.
// ═══════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Default signed update manifest (same endpoint the Tauri updater uses).
pub const DEFAULT_UPDATE_ENDPOINT: &str =
    "https://raw.githubusercontent.com/alex34301430/Blaxin/main/blaxin/update/latest.json";

/// Release asset prefix on GitHub (deterministic naming from release.yml).
const RELEASE_BASE: &str = "https://github.com/alex34301430/Blaxin/releases/download";

/// The only GitHub repository BLAXIN accepts releases from.
const EXPECTED_REPO: &str = "alex34301430/Blaxin";

const DOWNLOAD_TIMEOUT_SECS: u64 = 300;
const CONNECT_TIMEOUT_SECS: u64 = 15;

// ── Manifest (latest.json v2) ──────────────────────────────────────────

#[derive(Deserialize, Debug)]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    #[serde(default)]
    platforms: Option<ManifestPlatforms>,
    #[serde(default)]
    deb: Option<ManifestDeb>,
}

#[derive(Deserialize, Debug, Default)]
struct ManifestPlatforms {
    #[serde(rename = "linux-x86_64", default)]
    linux_x86_64: Option<ManifestArtifact>,
}

#[derive(Deserialize, Debug, Default)]
struct ManifestArtifact {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Deserialize, Debug)]
struct ManifestDeb {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
}

// ── Public shapes (returned to the UI) ─────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct ArtifactInfo {
    pub url: String,
    pub has_signature: bool,
    pub sha256: Option<String>,
    /// The minisign signature (base64 of the signature text). Not sent to
    /// the UI — used by the verifier only.
    #[serde(skip)]
    pub signature: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_notes: String,
    pub pub_date: String,
    pub is_deb_install: bool,
    pub deb: Option<ArtifactInfo>,
    pub appimage: Option<ArtifactInfo>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub stage: String, // checking | downloading | verifying | installing | restarting | error
    pub percent: u64,
    pub message: String,
}

impl UpdateInfo {
    pub fn not_available(current: String) -> Self {
        Self {
            update_available: false,
            current_version: current.clone(),
            latest_version: current,
            release_notes: String::new(),
            pub_date: String::new(),
            is_deb_install: is_deb_install(),
            deb: None,
            appimage: None,
            error: None,
        }
    }
}

// ── Update journal (rollback safety net) ───────────────────────────────
// Before installing, BLAXIN records the version it is replacing in a
// small journal file. The freshly installed version confirms a successful
// startup (backend health) and clears the marker. If startup never
// succeeds, the journal still points at the previous release and the UI
// can offer "Restore previous version", which reinstalls the previous
// signed .deb through the exact same verified pipeline.

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateJournal {
    /// Version whose install is pending verification (None once verified).
    pub pending_version: Option<String>,
    /// The release BLAXIN was on before this update.
    pub previous_version: Option<String>,
    pub timestamp: Option<u64>,
}

fn journal_path() -> std::path::PathBuf {
    let base = if let Ok(dir) = std::env::var("BLAXIN_DATA_DIR") {
        if !dir.trim().is_empty() {
            std::path::PathBuf::from(dir.trim())
        } else {
            default_data_dir()
        }
    } else {
        default_data_dir()
    };
    base.join("update-journal.json")
}

fn default_data_dir() -> std::path::PathBuf {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.trim().is_empty() {
            return std::path::PathBuf::from(xdg.trim()).join("blaxin");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return std::path::PathBuf::from(home.trim())
                .join(".local")
                .join("share")
                .join("blaxin");
        }
    }
    std::env::temp_dir().join("blaxin")
}

pub fn read_journal() -> UpdateJournal {
    let path = journal_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return UpdateJournal::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_journal(journal: &UpdateJournal) {
    if let Some(dir) = journal_path().parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(raw) = serde_json::to_string_pretty(journal) {
        let _ = fs::write(journal_path(), raw);
    }
}

/// Record that an install of `new_version` is about to happen, replacing
/// `previous_version`, so a broken new version can be rolled back.
pub fn mark_pending_install(new_version: &str, previous_version: &str) {
    let mut journal = read_journal();
    journal.pending_version = Some(new_version.to_string());
    journal.previous_version = Some(previous_version.to_string());
    journal.timestamp = Some(chrono_now());
    write_journal(&journal);
    eprintln!(
        "[BLAXIN-UPD] update journal: pending={:?} previous={:?}",
        journal.pending_version, journal.previous_version
    );
}

/// Called after the freshly installed version starts successfully
/// (backend health OK). Clears the pending marker — but only when the
/// journal names THIS binary's version, so a healthy install is never
/// mistaken for the pending one and vice versa.
pub fn confirm_successful_startup() {
    let mut journal = read_journal();
    let Some(pending) = journal.pending_version.as_deref() else {
        return;
    };
    if pending.trim_start_matches('v') != current_version().trim_start_matches('v') {
        eprintln!(
            "[BLAXIN-UPD] journal pending={pending} != current={} — not clearing",
            current_version()
        );
        return;
    }
    eprintln!(
        "[BLAXIN-UPD] startup verified for {pending} — update marked successful"
    );
    journal.pending_version = None;
    write_journal(&journal);
}

/// True when the last update never confirmed a successful startup, so the
/// UI should offer restoring the previous version.
pub fn is_rollback_available() -> bool {
    let journal = read_journal();
    journal.pending_version.is_some() && journal.previous_version.is_some()
}

/// The previous release BLAXIN can roll back to, if any.
pub fn rollback_target() -> Option<String> {
    let journal = read_journal();
    if journal.pending_version.is_some() {
        journal.previous_version
    } else {
        None
    }
}

/// Timestamp helper (seconds since epoch) without pulling in a time crate.
fn chrono_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── Version helpers ────────────────────────────────────────────────────

pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let mut it = v.split('.');
    let major = it.next()?.trim().parse::<u64>().ok()?;
    let minor = it.next().unwrap_or("0").trim().parse::<u64>().ok()?;
    let patch = it.next().unwrap_or("0").trim().parse::<u64>().ok()?;
    Some((major, minor, patch))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

// ── Install-mode detection ─────────────────────────────────────────────

/// True when BLAXIN was installed from the .deb package (system install),
/// as opposed to a portable AppImage or dev build.
pub fn is_deb_install() -> bool {
    if let Ok(mode) = std::env::var("BLAXIN_INSTALL_MODE") {
        if mode.eq_ignore_ascii_case("deb") {
            return true;
        }
        if mode.eq_ignore_ascii_case("appimage") {
            return false;
        }
    }
    // A .deb install places the binary in /usr/bin and the bundled
    // resources under /usr/lib/BLAXIN.
    let exe_ok = std::env::current_exe()
        .map(|p| p.starts_with("/usr/bin/"))
        .unwrap_or(false);
    let res_ok = Path::new("/usr/lib/BLAXIN/node/bin/node").exists();
    exe_ok || res_ok
}

// ── Config (endpoint + public key + install command) ───────────────────

pub fn endpoint() -> String {
    std::env::var("BLAXIN_UPDATE_URL").unwrap_or_else(|_| DEFAULT_UPDATE_ENDPOINT.to_string())
}

pub fn public_key_b64() -> String {
    std::env::var("BLAXIN_UPDATE_PUBKEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
        .unwrap_or_else(|| env!("BLAXIN_UPDATE_PUBKEY").to_string())
}

/// Endpoint is trusted when it is the project's own HTTPS raw URL.
fn endpoint_is_trusted(endpoint: &str) -> bool {
    endpoint.starts_with("https://raw.githubusercontent.com/alex34301430/Blaxin/")
}

/// Artifact URLs are only accepted from the project's own GitHub releases
/// (or from an operator-overridden endpoint).
fn artifact_url_is_trusted(url: &str, endpoint_trusted: bool) -> bool {
    if url.starts_with(&format!(
        "https://github.com/{}/releases/download/",
        EXPECTED_REPO
    )) {
        return true;
    }
    !endpoint_trusted
}

/// Only allow plain-HTTP endpoints when explicitly opted in (local testing).
fn endpoint_allows_http(endpoint: &str) -> bool {
    if endpoint.starts_with("https://") {
        return true;
    }
    if endpoint.starts_with("http://") {
        return std::env::var("BLAXIN_UPDATE_INSECURE_HTTP").is_ok();
    }
    false
}

// ── Signature + checksum verification ──────────────────────────────────

fn parse_signature(value: &str) -> Result<minisign_verify::Signature, String> {
    use base64::Engine as _;
    let text = if value.contains("untrusted comment") {
        value.to_string()
    } else {
        // Single-line base64 of the minisign signature text (Tauri style).
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(value.trim())
            .map_err(|e| format!("signature is not valid base64: {e}"))?;
        String::from_utf8(decoded).map_err(|e| format!("signature base64 is not text: {e}"))?
    };
    minisign_verify::Signature::decode(&text).map_err(|e| format!("invalid signature: {e}"))
}

/// Verify a file's minisign signature against the public key.
/// Returns Ok(()) only for a cryptographically valid signature.
pub fn verify_signature(
    file_path: &Path,
    signature_b64: &str,
    pubkey_b64: &str,
) -> Result<(), String> {
    let pk = minisign_verify::PublicKey::from_base64(pubkey_b64.trim())
        .map_err(|e| format!("invalid public key: {e}"))?;
    let sig = parse_signature(signature_b64)?;
    let data = fs::read(file_path).map_err(|e| format!("cannot read artifact: {e}"))?;
    // allow_legacy=true accepts both legacy and prehashed minisign
    // signatures (Tauri's signing tooling produces prehashed ones).
    pk.verify(&data, &sig, true)
        .map_err(|e| format!("signature verification FAILED: {e}"))
}

/// Hex SHA-256 of a file (lowercase).
pub fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path).map_err(|e| format!("cannot open artifact: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("cannot read artifact: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_matches(actual: &str, expected: &str) -> bool {
    actual.eq_ignore_ascii_case(expected.trim())
}

// ── Download ───────────────────────────────────────────────────────────

fn client() -> Result<reqwest::blocking::Client, String> {
    // rustls needs a process-level crypto provider for reqwest's
    // rustls-no-provider build; the updater plugin installs one at its
    // first check, but we make sure it exists here too so the deb
    // updater works even if the plugin path never ran.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .user_agent(format!("BLAXIN/{}", current_version()))
        .build()
        .map_err(|e| format!("failed to create HTTP client: {e}"))
}

/// Download `url` into `dest`, invoking `on_progress(percent)` as bytes
/// arrive. Fails if the server does not respond with 200.
pub fn download(
    url: &str,
    dest: &Path,
    on_progress: &mut dyn FnMut(u64),
) -> Result<(), String> {
    let resp = client()?
        .get(url)
        .send()
        .map_err(|e| format!("download failed ({url}): {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("download failed: HTTP {status} for {url}"));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = fs::File::create(dest).map_err(|e| format!("cannot create temp file: {e}"))?;
    let mut stream = resp;
    let mut buf = [0u8; 65536];
    let mut written: u64 = 0;
    loop {
        let n = stream
            .read(&mut buf)
            .map_err(|e| format!("download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("cannot write temp file: {e}"))?;
        written += n as u64;
        if total > 0 {
            on_progress(((written as f64 / total as f64) * 100.0) as u64);
        }
    }
    let _ = file.flush();
    Ok(())
}

// ── Check ──────────────────────────────────────────────────────────────

pub fn check(
    endpoint: &str,
    pubkey: &str,
    current: &str,
) -> Result<UpdateInfo, String> {
    let allow_http = endpoint_allows_http(endpoint);
    check_impl(endpoint, pubkey, current, allow_http)
}

fn check_impl(
    endpoint: &str,
    pubkey: &str,
    current: &str,
    allow_http: bool,
) -> Result<UpdateInfo, String> {
    let _ = pubkey; // used at install time; presence checked there
    if !endpoint.starts_with("https://") && !allow_http {
        return Err("update endpoint must be HTTPS (set BLAXIN_UPDATE_INSECURE_HTTP to allow plain HTTP for testing)".into());
    }
    let endpoint_trusted = endpoint_is_trusted(endpoint);

    let resp = client()?
        .get(endpoint)
        .send()
        .map_err(|e| format!("update check failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("update check failed: HTTP {status}"));
    }
    let text = resp.text().map_err(|e| format!("update manifest unreadable: {e}"))?;
    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|e| format!("update manifest invalid: {e}"))?;

    let latest = manifest.version.trim().trim_start_matches('v').to_string();
    if !is_newer(&latest, current) {
        return Ok(UpdateInfo::not_available(current.to_string()));
    }

    let platform = manifest
        .platforms
        .and_then(|p| p.linux_x86_64)
        .unwrap_or_default();
    let appimage = platform
        .url
        .filter(|u| !u.is_empty() && artifact_url_is_trusted(u, endpoint_trusted))
        .map(|url| ArtifactInfo {
            has_signature: platform.signature.as_deref().unwrap_or("").len() >= 40,
            url,
            sha256: platform.sha256,
            signature: platform.signature.clone(),
        });

    let deb = manifest.deb.and_then(|d| {
        let url = d.url?;
        if url.is_empty() || !artifact_url_is_trusted(&url, endpoint_trusted) {
            return None;
        }
        Some(ArtifactInfo {
            has_signature: d.signature.as_deref().unwrap_or("").len() >= 40,
            url,
            sha256: d.sha256,
            signature: d.signature,
        })
    });

    if appimage.is_none() && deb.is_none() {
        return Err("update manifest contains no usable Linux artifacts".into());
    }

    Ok(UpdateInfo {
        update_available: true,
        current_version: current.to_string(),
        latest_version: latest,
        release_notes: manifest.notes.unwrap_or_default(),
        pub_date: manifest.pub_date.unwrap_or_default(),
        is_deb_install: is_deb_install(),
        deb,
        appimage,
        error: None,
    })
}

// ── Download + verify + install ────────────────────────────────────────

/// A unique destination for one verified download: the artifact's own
/// filename (kept so `dpkg -i` still sees a `.deb`), prefixed with the
/// PID and a per-process sequence number. Two downloads of artifacts that
/// share a filename — e.g. parallel tests, or a retried install while a
/// previous attempt's temp file lingers — can never write over each
/// other's half-downloaded package mid-verification.
fn unique_download_path(dir: &Path, artifact: &ArtifactInfo) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = artifact
        .url
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("blaxin.deb");
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    dir.join(format!("{}-{seq}-{name}", std::process::id()))
}

/// Download and fully verify a .deb artifact. Returns the path to the
/// verified package in the temp dir.
pub fn download_and_verify_deb(
    artifact: &ArtifactInfo,
    pubkey: &str,
    on_progress: &mut dyn FnMut(u64),
) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("blaxin-update");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create temp dir: {e}"))?;
    let dest = unique_download_path(&dir, artifact);

    on_progress(0);
    download(&artifact.url, &dest, on_progress).map_err(|e| {
        let _ = fs::remove_file(&dest);
        e
    })?;
    on_progress(100);

    // Signature first, checksum second — both must pass.
    if let Some(sig) = &artifact.signature {
        verify_signature(&dest, sig, pubkey).map_err(|e| {
            let _ = fs::remove_file(&dest);
            format!("{e} — update aborted, nothing was installed")
        })?;
    } else {
        let _ = fs::remove_file(&dest);
        return Err(
            "release is not signed — refusing to install an unsigned update".into(),
        );
    }
    if let Some(expected) = &artifact.sha256 {
        let actual = sha256_file(&dest)?;
        if !sha256_matches(&actual, expected) {
            let _ = fs::remove_file(&dest);
            return Err(format!(
                "SHA-256 mismatch (got {actual}, expected {expected}) — update aborted, nothing was installed"
            ));
        }
    }
    Ok(dest)
}

/// Deterministic GitHub release asset URL for the given version (the
/// artifact naming follows release.yml).
fn release_asset_url(version: &str, name: &str) -> String {
    format!("{RELEASE_BASE}/v{version}/{name}")
}

/// Reinstall the previously running release (rollback safety net).
///
/// Downloads the previous version's .deb, signature and checksum from the
/// project's GitHub releases, verifies them with the SAME embedded public
/// key, installs via `pkexec dpkg -i`, and relaunches. This is the escape
/// hatch when a freshly installed update never starts successfully: the
/// user is returned to the last known-good release without losing data
/// (config/credentials/session live in the data dir, untouched by dpkg).
pub fn perform_rollback(on_progress: &mut dyn FnMut(&str, u64, String)) -> Result<(), String> {
    let previous = rollback_target()
        .ok_or_else(|| "no previous version recorded — nothing to restore".to_string())?;
    let pubkey = public_key_b64();
    if pubkey.trim().is_empty() {
        return Err(
            "BLAXIN is not configured with an update public key — refusing to install".to_string(),
        );
    }

    let deb_url = release_asset_url(&previous, &format!("blaxin_{previous}_amd64.deb"));
    let sig_url = release_asset_url(&previous, &format!("blaxin_{previous}_amd64.deb.sig"));
    let sha_url = release_asset_url(&previous, &format!("blaxin_{previous}_amd64.deb.sha256"));

    on_progress(
        "downloading",
        0,
        format!("Downloading BLAXIN v{previous} (rollback)…"),
    );

    let dir = std::env::temp_dir().join("blaxin-update");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create temp dir: {e}"))?;
    let sig_path = dir.join(format!("blaxin_{previous}_amd64.deb.sig"));
    let sha_path = dir.join(format!("blaxin_{previous}_amd64.deb.sha256"));

    // Signature is mandatory; the checksum is best-effort (very old
    // releases may predate the .sha256 assets).
    let signature = download(&sig_url, &sig_path, &mut |_| {})
        .and_then(|_| fs::read_to_string(&sig_path).map_err(|e| format!("cannot read signature: {e}")))?;
    let _ = fs::remove_file(&sig_path);

    let mut sha256 = None;
    if download(&sha_url, &sha_path, &mut |_| {}).is_ok() {
        if let Ok(raw) = fs::read_to_string(&sha_path) {
            let hash = raw.split_whitespace().next().unwrap_or("").to_string();
            if hash.len() == 64 {
                sha256 = Some(hash);
            }
        }
    }
    let _ = fs::remove_file(&sha_path);

    let artifact = ArtifactInfo {
        url: deb_url,
        has_signature: true,
        sha256,
        signature: Some(signature),
    };

    let path = download_and_verify_deb(&artifact, &pubkey, &mut |p| {
        on_progress(
            "downloading",
            p,
            format!("Downloading BLAXIN v{previous}… {p}%"),
        );
    })?;

    on_progress(
        "verifying",
        100,
        "Signature and checksum verified ✓".to_string(),
    );
    on_progress(
        "installing",
        100,
        "Installing previous version (system authentication may be required)…".to_string(),
    );
    install_deb(&path)?;
    let _ = fs::remove_file(&path);

    on_progress(
        "restarting",
        100,
        "Restarting BLAXIN with the previous version…".to_string(),
    );
    relaunch()?;
    Ok(())
}

/// Install a verified .deb with the OS privilege boundary (`pkexec dpkg -i`).
/// The command can be overridden with BLAXIN_UPDATE_INSTALL_CMD (testing /
/// enterprise). The running installation is never touched by this step
/// until dpkg has replaced the package.
pub fn install_deb(deb_path: &Path) -> Result<(), String> {
    let cmd = std::env::var("BLAXIN_UPDATE_INSTALL_CMD");
    let status = match cmd {
        Ok(override_cmd) if !override_cmd.trim().is_empty() => Command::new("sh")
            .arg("-c")
            .arg(&override_cmd)
            .arg("blaxin-update")
            .arg(deb_path)
            .status()
            .map_err(|e| format!("update install command failed to start: {e}"))?,
        _ => Command::new("pkexec")
            .args(["dpkg", "-i"])
            .arg(deb_path)
            .status()
            .map_err(|e| format!("pkexec could not be started: {e}"))?,
    };
    if !status.success() {
        return Err(format!(
            "package install failed (exit {:?}) — the previous version is still installed",
            status.code()
        ));
    }
    Ok(())
}

/// The executable the updater must launch after installing a new version.
///
/// For AppImages, `current_exe()` points into the (old) squashfs mount,
/// not at the .AppImage file — relaunching it would start the PREVIOUS
/// version, which would detect the update again, install it again, and
/// loop forever. The APPIMAGE env var holds the real .AppImage path, so
/// it wins when present. For .deb installs the binary at current_exe is
/// already the freshly installed one.
pub fn resolve_relaunch_exe() -> Option<std::path::PathBuf> {
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        let path = appimage.trim();
        if !path.is_empty() {
            let p = std::path::PathBuf::from(path);
            if p.exists() {
                return Some(p);
            }
        }
    }
    std::env::current_exe().ok()
}

/// Relaunch the app detached (used right after a successful update).
/// The spawned process gets BLAXIN_RELAUNCHED=1 so its single-instance
/// guard knows this is an update handover and waits for this (old)
/// instance to exit before starting — no port race, no blank window,
/// exactly one restart.
pub fn relaunch() -> Result<(), String> {
    let exe = resolve_relaunch_exe()
        .ok_or_else(|| "cannot find own binary for relaunch".to_string())?;
    let mut cmd = Command::new(&exe);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env("BLAXIN_RELAUNCHED", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    cmd.spawn()
        .map_err(|e| format!("failed to relaunch BLAXIN: {e}"))?;
    Ok(())
}

pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ── Tauri command helpers ──────────────────────────────────────────────

/// Full update check used by the UI (deb-aware).
pub fn full_check() -> UpdateInfo {
    let current = current_version();
    let endpoint = endpoint();
    let pubkey = public_key_b64();
    match check(&endpoint, &pubkey, &current) {
        Ok(info) => info,
        Err(e) => UpdateInfo {
            update_available: false,
            current_version: current.clone(),
            latest_version: current,
            release_notes: String::new(),
            pub_date: String::new(),
            is_deb_install: is_deb_install(),
            deb: None,
            appimage: None,
            error: Some(e),
        },
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    /// Tiny single-threaded HTTP server used to simulate the update
    /// manifest + artifact endpoints (no external deps). Routes can be
    /// registered after the server starts (the port is only known then).
    struct TestServer {
        port: u16,
        routes: Arc<Mutex<HashMap<String, Vec<u8>>>>,
        handle: thread::JoinHandle<()>,
    }

    impl TestServer {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            let port = listener.local_addr().unwrap().port();
            let routes = Arc::new(Mutex::new(HashMap::new()));
            let routes_clone = routes.clone();
            let handle = thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { break };
                    let mut buf = [0u8; 4096];
                    let Ok(n) = stream.read(&mut buf) else { continue };
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    let body = routes_clone
                        .lock()
                        .unwrap()
                        .get(&path)
                        .cloned()
                        .unwrap_or_else(|| b"404 not found".to_vec());
                    let status = if body == b"404 not found" { "404 Not Found" } else { "200 OK" };
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(&body);
                }
            });
            Self { port, routes, handle }
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}/{}", self.port, path)
        }

        fn route(&self, path: &str, body: Vec<u8>) {
            self.routes.lock().unwrap().insert(path.to_string(), body);
        }
    }

    /// Sign `data` with a fresh keypair; returns (pubkey_b64, sig_b64).
    fn sign_bytes(data: &[u8]) -> (String, String) {
        use minisign::KeyPair;
        let kp = KeyPair::generate_unencrypted_keypair().expect("keypair");
        let pk = kp.pk.clone();
        let sig = minisign::sign(
            Some(&pk),
            &kp.sk,
            data,
            Some("timestamp:1788427490"),
            None,
        )
        .expect("sign");
        (pk.to_base64(), sig.to_string())
    }

    #[test]
    fn update_journal_rollback_lifecycle() {
        let tmp = std::env::temp_dir().join(format!("blaxin-journal-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("BLAXIN_DATA_DIR", &tmp);

        // Fresh start: nothing to roll back.
        assert!(!is_rollback_available());
        assert_eq!(rollback_target(), None);

        // Installing current over 1.1.0 records a rollback target.
        mark_pending_install(&current_version(), "1.1.0");
        assert!(is_rollback_available());
        assert_eq!(rollback_target(), Some("1.1.0".to_string()));

        // A successful startup of the matching version clears the marker.
        confirm_successful_startup();
        assert!(!is_rollback_available());
        assert_eq!(rollback_target(), None);

        // A pending marker for a DIFFERENT version is not cleared by this
        // binary's startup (protects against cross-version confusion).
        mark_pending_install("9.9.9", "1.1.0");
        assert!(is_rollback_available());
        confirm_successful_startup();
        assert!(is_rollback_available(), "mismatched version must not clear the journal");
        assert_eq!(rollback_target(), Some("1.1.0".to_string()));

        std::env::remove_var("BLAXIN_DATA_DIR");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn relaunch_resolution_prefers_appimage() {
        // No APPIMAGE set → falls back to current_exe (the real binary).
        std::env::remove_var("APPIMAGE");
        let exe = resolve_relaunch_exe().expect("current_exe fallback");
        assert!(exe.exists());

        // APPIMAGE set to a non-existent path → falls back to current_exe.
        std::env::set_var("APPIMAGE", "/nonexistent/BLAXIN.AppImage");
        let exe2 = resolve_relaunch_exe().expect("fallback when APPIMAGE missing");
        assert_eq!(exe, exe2);

        // APPIMAGE set to a real file → that file wins (prevents the
        // stale-mount relaunch loop on AppImage installs).
        let tmp = std::env::temp_dir().join("blaxin-relaunch-test.AppImage");
        fs::write(&tmp, b"fake appimage").unwrap();
        std::env::set_var("APPIMAGE", &tmp);
        let exe3 = resolve_relaunch_exe().expect("APPIMAGE wins");
        assert_eq!(exe3, tmp);
        let _ = fs::remove_file(&tmp);
        std::env::remove_var("APPIMAGE");
    }

    #[test]
    fn semver_helpers() {
        assert!(is_newer("1.1.1", "1.1.0"));
        assert!(is_newer("1.2.0", "1.1.9"));
        assert!(is_newer("2.0.0", "1.9.9"));
        assert!(!is_newer("1.1.0", "1.1.0"));
        assert!(!is_newer("1.1.0", "1.1.1"));
        assert!(!is_newer("garbage", "1.1.1"));
        assert!(!is_newer("1.1.1", "garbage"));
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
    }

    #[test]
    fn signature_roundtrip_and_tamper_detection() {
        let data = b"BLAXIN fake deb content for signature test";
        let (pk_b64, sig_b64) = sign_bytes(data);

        let tmp = std::env::temp_dir().join("blaxin-sig-test.deb");
        fs::write(&tmp, data).unwrap();

        // Valid signature passes.
        verify_signature(&tmp, &sig_b64, &pk_b64).expect("valid sig must verify");

        // Wrong public key fails.
        let (other_pk, _) = sign_bytes(data);
        assert!(verify_signature(&tmp, &sig_b64, &other_pk).is_err());

        // Tampered file fails.
        fs::write(&tmp, b"BLAXIN fake deb content FOR TAMPERING").unwrap();
        assert!(verify_signature(&tmp, &sig_b64, &pk_b64).is_err());

        // Corrupt signature string fails.
        assert!(verify_signature(&tmp, "not-base64!!", &pk_b64).is_err());

        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn sha256_checksum_roundtrip() {
        let tmp = std::env::temp_dir().join("blaxin-sha-test.bin");
        fs::write(&tmp, b"hello blaxin sha256").unwrap();
        let h = sha256_file(&tmp).unwrap();
        assert_eq!(h.len(), 64);
        assert!(sha256_matches(&h, &h.to_uppercase()));
        assert!(!sha256_matches(&h, &format!("{}0", &h[..63])));
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn full_update_flow_over_http() {
        // Build a fake but cryptographically valid release: v9.9.9 deb.
        let deb_bytes = b"PK\x03\x04 fake blaxin 9.9.9 deb package bytes".to_vec();
        let (pk_b64, sig_b64) = sign_bytes(&deb_bytes);
        let sha = sha256_bytes(&deb_bytes);

        let server = TestServer::start();
        let deb_url = server.url("blaxin_9.9.9_amd64.deb");
        server.route("/blaxin_9.9.9_amd64.deb", deb_bytes.clone());
        server.route(
            "/latest.json",
            serde_json::json!({
                "version": "9.9.9",
                "notes": "test release",
                "pub_date": "2026-09-03T00:00:00Z",
                "deb": { "url": deb_url, "signature": sig_b64, "sha256": sha },
            })
            .to_string()
            .into_bytes(),
        );
        let endpoint = server.url("latest.json");

        // 1) Update is detected from v1.1.0.
        let info = check_impl(&endpoint, &pk_b64, "1.1.0", true).expect("check");
        assert!(info.update_available);
        assert_eq!(info.latest_version, "9.9.9");
        let deb = info.deb.expect("deb artifact");
        assert!(deb.has_signature);

        // 2) Download + signature + checksum all pass.
        let path = download_and_verify_deb(&deb, &pk_b64, &mut |_| {}).expect("download+verify");
        assert_eq!(fs::read(&path).unwrap(), deb_bytes);

        // 3) Same version installed → no update offered.
        let info = check_impl(&endpoint, &pk_b64, "9.9.9", true).expect("check");
        assert!(!info.update_available);

        // 4) Newer installed version → no update offered.
        let info = check_impl(&endpoint, &pk_b64, "10.0.0", true).expect("check");
        assert!(!info.update_available);

        // 5) Wrong public key → download+verify refuses.
        let (other_pk, _) = sign_bytes(&deb_bytes);
        assert!(download_and_verify_deb(&deb, &other_pk, &mut |_| {}).is_err());

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn tampered_artifact_is_rejected() {
        let deb_bytes = b"PK\x03\x04 good bytes".to_vec();
        let (pk_b64, sig_b64) = sign_bytes(&deb_bytes);
        let sha = sha256_bytes(&deb_bytes);

        // Serve a DIFFERENT file than the one that was signed/checksummed.
        let tampered = b"PK\x03\x04 EVIL TAMPERED BYTES".to_vec();
        let server = TestServer::start();
        server.route("/blaxin_9.9.9_amd64.deb", tampered.clone());
        let deb_url = server.url("blaxin_9.9.9_amd64.deb");
        server.route(
            "/latest.json",
            serde_json::json!({
                "version": "9.9.9",
                "deb": { "url": deb_url, "signature": sig_b64, "sha256": sha },
            })
            .to_string()
            .into_bytes(),
        );
        let endpoint = server.url("latest.json");

        let info = check_impl(&endpoint, &pk_b64, "1.1.0", true).expect("check");
        let deb = info.deb.unwrap();
        // Signature check runs first and must abort.
        let err = download_and_verify_deb(&deb, &pk_b64, &mut |_| {}).unwrap_err();
        assert!(err.contains("aborted"), "expected abort: {err}");
    }

    #[test]
    fn concurrent_same_name_downloads_do_not_collide() {
        // Regression test: two downloads of DIFFERENT payloads served
        // under the SAME artifact filename used to share one temp
        // destination (`blaxin-update/<artifact-name>.deb`), so parallel
        // runs overwrote each other mid-verification (signature from one
        // payload, bytes from the other → SHA-256 mismatch). Each
        // download must verify and return exactly the bytes it fetched.
        let payload_a = b"PK\x03\x04 payload A for concurrent download".to_vec();
        let payload_b = b"PK\x03\x04 payload B for concurrent download".to_vec();
        let (pk_a, sig_a) = sign_bytes(&payload_a);
        let (pk_b, sig_b) = sign_bytes(&payload_b);

        let server_a = TestServer::start();
        let server_b = TestServer::start();
        let name = "blaxin_9.9.9_amd64.deb";
        server_a.route(&format!("/{name}"), payload_a.clone());
        server_b.route(&format!("/{name}"), payload_b.clone());

        let artifact_a = ArtifactInfo {
            url: server_a.url(name),
            has_signature: true,
            sha256: Some(sha256_bytes(&payload_a)),
            signature: Some(sig_a),
        };
        let artifact_b = ArtifactInfo {
            url: server_b.url(name),
            has_signature: true,
            sha256: Some(sha256_bytes(&payload_b)),
            signature: Some(sig_b),
        };

        let handle_a = std::thread::spawn(move || {
            download_and_verify_deb(&artifact_a, &pk_a, &mut |_| {})
        });
        let handle_b = std::thread::spawn(move || {
            download_and_verify_deb(&artifact_b, &pk_b, &mut |_| {})
        });

        let path_a = handle_a.join().expect("thread a").expect("download a");
        let path_b = handle_b.join().expect("thread b").expect("download b");

        assert_eq!(fs::read(&path_a).unwrap(), payload_a, "download A must verify its own bytes");
        assert_eq!(fs::read(&path_b).unwrap(), payload_b, "download B must verify its own bytes");

        let _ = fs::remove_file(&path_a);
        let _ = fs::remove_file(&path_b);
    }

    #[test]
    fn http_endpoint_requires_opt_in() {
        let server = TestServer::start();
        let endpoint = server.url("latest.json");
        let _old = std::env::var("BLAXIN_UPDATE_INSECURE_HTTP");
        std::env::remove_var("BLAXIN_UPDATE_INSECURE_HTTP");
        let err = check(&endpoint, "pk", "1.1.0").unwrap_err();
        assert!(err.contains("HTTPS"));
        std::env::set_var("BLAXIN_UPDATE_INSECURE_HTTP", "1");
        // Now allowed (will fail later at the manifest/artifact stage, but
        // not at the transport policy stage).
        let _ = check(&endpoint, "pk", "1.1.0");
        let _ = std::env::remove_var("BLAXIN_UPDATE_INSECURE_HTTP");
    }

    fn sha256_bytes(data: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(data);
        hex(&hasher.finalize())
    }
}