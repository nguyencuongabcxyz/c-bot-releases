//! Signing in to Claude Code again once its sign-in has run out: `claude auth login` opens the
//! browser, and is done when you've signed in there.

use super::*;

use std::path::Path;

/// How long it waits for you in the browser.
const LOGIN_WAIT: Duration = Duration::from_secs(10 * 60);

/// The sign-in under way. A new one replaces it (its browser tab may have been closed).
static SIGNING_IN: LazyLock<Mutex<Option<Killer>>> = LazyLock::new(Mutex::default);

/// Sign in (the browser opens). Ok once you have.
pub fn login(claude: &Path) -> Result<(), Error> {
    let mut child = Command::new(claude)
        .args(["auth", "login"])
        .env_clear()
        .envs(clean_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .spawn()
        .map_err(|e| Error::from(format!("Couldn't start Claude Code: {e}")))?;
    let (out, err) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let killer = Killer::new(child.id());
    if let Some(old) = SIGNING_IN.locked().replace(killer.clone()) {
        old.kill();
    }
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < LOGIN_WAIT => thread::sleep(Duration::from_millis(200)),
            _ => {
                killer.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    killer.gone();
    let (out, err) = (
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default(),
    );
    match status {
        Some(s) if s.success() => Ok(()),
        Some(_) => Err(why(&out, &err).into()),
        None => Err("Signing in took too long. Try again.".into()),
    }
}

/// Everything a pipe says, read on a thread of its own (so a full pipe can't hold it up).
fn drain(pipe: Option<impl Read + Send + 'static>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    })
}

/// Why it didn't sign in: its last word on stderr, else on stdout (past the prompt to paste a code).
fn why(out: &str, err: &str) -> String {
    let last = |text: &str| {
        text.lines()
            .map(|l| {
                l.trim()
                    .trim_start_matches("Paste code here if prompted >")
                    .trim()
            })
            .rfind(|l| !l.is_empty())
            .map(str::to_string)
    };
    last(err)
        .or_else(|| last(out).filter(|l| !l.starts_with("If the browser didn't open")))
        .unwrap_or_else(|| "Signing in didn't finish.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn why_says_claudes_last_error() {
        assert_eq!(
            why(
                "Opening browser…
",
                "OAuth error: denied

"
            ),
            "OAuth error: denied"
        );
    }

    #[test]
    fn why_reads_past_the_paste_prompt() {
        assert_eq!(
            why(
                "Opening browser…
Paste code here if prompted > Login failed
",
                ""
            ),
            "Login failed"
        );
    }

    #[test]
    fn why_has_its_own_words_when_claude_had_none() {
        let out = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/x\nPaste code here if prompted > ";
        assert_eq!(why(out, ""), "Signing in didn't finish.");
    }
}
