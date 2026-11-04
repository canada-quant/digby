//! The stdio loop: one request line in → one response line out, forever.
//!
//! The agent (windows-agent/src/rust-helper.ts) spawns this binary and keeps
//! it alive for the agent's lifetime; requests are strictly sequential (the
//! client serializes), so a plain blocking read loop is the whole story.
//! stderr is the helper's own log channel (never protocol) — the agent
//! forwards it to its console for diagnostics.

use digby_win_helper::{handle_line, protocol};

fn main() {
    let stdin = std::io::stdin();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.read_line(&mut line) {
            Ok(0) => {
                // EOF — the agent went away. Exit cleanly (no hang, no
                // non-zero status: a supervisor restart loop on agent exit
                // is the AGENT's decision, not the helper's).
                eprintln!("[helper] stdin closed — exiting");
                return;
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("[helper] stdin read error: {e} — exiting");
                std::process::exit(1);
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue; // ignore blank keepalive lines
        }
        let response = handle_line(trimmed);
        let out = protocol::encode_line(&response);
        use std::io::Write;
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        if let Err(e) = lock.write_all(out.as_bytes()).and_then(|_| lock.flush()) {
            eprintln!("[helper] stdout write error: {e} — exiting");
            std::process::exit(1);
        }
    }
}
