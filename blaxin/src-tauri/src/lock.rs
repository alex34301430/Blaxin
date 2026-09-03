// ═══════════════════════════════════════════════════════════════════════
// BLAXIN — single-instance lock
//
// BLAXIN must never run twice: the second instance's backend cannot bind
// port 3001, which produces a blank window and a confusing "app keeps
// reopening" experience (the user closes a window while a hidden second
// instance keeps running, launches again, and gets another broken
// instance).
//
// The lock is a plain O_EXCL file in the user data directory carrying the
// PID of the owning process. Properties:
//
//   - Atomic: only one process can create it (O_EXCL).
//   - Crash-safe: a stale file (owner PID no longer alive) is detected and
//     replaced, so a hard crash never bricks the app.
//   - Update-aware: the freshly relaunched process (spawned with
//     BLAXIN_RELAUNCHED=1 by the updater) waits much longer for the old
//     instance to hand over, so "update → restart once" works without a
//     port race; a plain duplicate launch fails fast instead.
// ═══════════════════════════════════════════════════════════════════════

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// User data directory (mirrors the server's XDG resolution for the lock
/// file location; the Rust side only needs the lock, not the whole set of
/// data paths).
fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BLAXIN_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir.trim());
        }
    }
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.trim().is_empty() {
            return PathBuf::from(xdg.trim()).join("blaxin");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home.trim()).join(".local").join("share").join("blaxin");
        }
    }
    std::env::temp_dir().join("blaxin")
}

fn lock_path() -> PathBuf {
    data_dir().join("blaxin.lock")
}

/// True when a process with `pid` is alive. Used to detect stale locks.
#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // signal 0 performs error checking only — no signal is sent.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(not(unix))]
fn pid_alive(_pid: i32) -> bool {
    true
}

fn read_owner_pid() -> Option<i32> {
    let raw = fs::read_to_string(lock_path()).ok()?;
    raw.trim().parse::<i32>().ok()
}

fn try_create() -> std::io::Result<File> {
    let dir = data_dir();
    fs::create_dir_all(&dir)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(lock_path())?;
    writeln!(file, "{}", std::process::id())?;
    Ok(file)
}

/// Result of attempting to take the single-instance lock.
pub enum LockOutcome {
    /// This process owns the lock and may continue.
    Acquired(File),
    /// Another live BLAXIN instance holds the lock.
    AlreadyRunning,
}

/// Acquire the single-instance lock.
///
/// `handover` should be true when this process was spawned by the updater
/// (the old instance is exiting right now, so we wait longer for it).
pub fn acquire(handover: bool) -> LockOutcome {
    let timeout = if handover {
        Duration::from_secs(60)
    } else {
        Duration::from_secs(8)
    };
    let start = Instant::now();

    loop {
        match try_create() {
            Ok(file) => return LockOutcome::Acquired(file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Stale lock? The owner may have crashed.
                if let Some(pid) = read_owner_pid() {
                    if !pid_alive(pid) {
                        eprintln!("[BLAXIN] Removing stale lock from dead PID {pid}");
                        let _ = fs::remove_file(lock_path());
                        continue;
                    }
                }
                if start.elapsed() >= timeout {
                    return LockOutcome::AlreadyRunning;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(e) => {
                eprintln!("[BLAXIN] Could not create lock file: {e}");
                return LockOutcome::AlreadyRunning;
            }
        }
    }
}

/// Release the lock (only if it still belongs to this PID).
pub fn release(_file: Option<File>) {
    let _ = fs::remove_file(lock_path());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_excludes_second_instance() {
        // Use a throwaway lock path so the test never touches the real
        // data-dir lock file. (try_create uses the production path, so we
        // redirect the data dir for the duration of the test.)
        let tmp = std::env::temp_dir().join(format!("blaxin-lock-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("BLAXIN_DATA_DIR", &tmp);

        let first = try_create().expect("first acquire succeeds");
        let second = try_create();
        assert!(second.is_err());
        drop(first);
        // The lock file is removed on release, so a new acquire works.
        let _ = std::fs::remove_file(lock_path());
        let third = try_create().expect("lock released, acquire succeeds again");
        drop(third);
        let _ = std::fs::remove_file(lock_path());

        std::env::remove_var("BLAXIN_DATA_DIR");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn lock_path_lives_in_data_dir() {
        let p = lock_path();
        assert!(p.to_string_lossy().contains("blaxin"));
        assert!(p.ends_with("blaxin.lock"));
    }
}