//! The engine's own PostgreSQL. It's downloaded once into <dir>/pg/install (an exact version,
//! so an installed one is found without asking the internet), keeps its data in <dir>/pg/data,
//! and listens on 127.0.0.1 on a port and with a password chosen once. C-Bot starts it when a
//! robot first needs it, joins it when it's already running (left by a C-Bot that didn't get to
//! stop it), and stops it on its way out if it started it.

use super::*;

/// The PostgreSQL release, pinned exactly (a range asks GitHub which is newest on every start).
const VERSION: &str = "=18.6.1";
/// The engine's database in the cluster.
const DATABASE: &str = "cbot_context";
/// How long the database may take to come up or answer.
const TIMEOUT: Duration = Duration::from_secs(60);

/// A running cluster, and whether this C-Bot started it (and so stops it).
pub(in crate::context) struct Cluster {
    pg: PostgreSQL,
    started: bool,
    pub url: String,
}

impl Cluster {
    /// Its version, port and data folder, and whether this C-Bot started it.
    pub(in crate::context) fn about(&self) -> (String, u16, PathBuf, bool) {
        let s = self.pg.settings();
        let version = VERSION.trim_start_matches('=').to_string();
        (version, s.port, s.data_dir.clone(), self.started)
    }

    pub(in crate::context) fn stop(&self) {
        if self.started
            && let Err(e) = self.halt()
        {
            log::warn!("{e}");
        }
    }

    /// Stopped, whoever started it (its data is about to go).
    pub(in crate::context) fn halt(&self) -> Result<(), Error> {
        block(self.pg.stop()).map_err(|e| failed("stop", &e))
    }
}

/// The cluster under `dir`, installed and started if need be; `say` hears what's going on.
pub(in crate::context) fn start(dir: &Path, say: &dyn Fn(&str)) -> Result<Cluster, Error> {
    let dir = dir.join("pg");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    let mut pg = PostgreSQL::new(settings(&dir)?);
    let url = pg.settings().url(DATABASE);
    let data = pg.settings().data_dir.clone();
    if listening(&data) {
        log::info!("joining the code index's database, already running");
        return ready(pg, false, url);
    }
    forget_stale_pid(&data);
    if matches!(pg.status(), Status::NotInstalled) {
        say("Downloading PostgreSQL (once)…");
    } else {
        say("Starting the database…");
    }
    block(pg.setup()).map_err(|e| failed("set up", &e))?;
    block(pg.start()).map_err(|e| failed("start", &e))?;
    ready(pg, true, url)
}

/// The database made, once the server is up.
fn ready(pg: PostgreSQL, started: bool, url: String) -> Result<Cluster, Error> {
    let exists = block(pg.database_exists(DATABASE)).map_err(|e| failed("reach", &e))?;
    if !exists {
        block(pg.create_database(DATABASE)).map_err(|e| failed("set up", &e))?;
    }
    Ok(Cluster { pg, started, url })
}

/// A server running on the data under `dir` that this C-Bot didn't start or join (left by one
/// that didn't get to stop it, or another C-Bot's), stopped: its data is about to go.
pub(in crate::context) fn halt_any(dir: &Path) -> Result<(), Error> {
    let dir = dir.join("pg");
    if !listening(&dir.join("data")) {
        return Ok(());
    }
    block(PostgreSQL::new(settings(&dir)?).stop()).map_err(|e| failed("stop", &e))
}

/// The cluster's settings under `dir` (its port and password chosen the first time).
fn settings(dir: &Path) -> Result<Settings, Error> {
    let port = remembered(&dir.join("port"), || free_port().map(|p| p.to_string()))?
        .parse::<u16>()
        .map_err(|_| format!("{} holds no port number.", dir.join("port").display()))?;
    let password = remembered(&dir.join("password"), || {
        Ok(uuid::Uuid::new_v4().simple().to_string())
    })?;
    Ok(Settings {
        version: VersionReq::parse(VERSION).map_err(|e| format!("Bad PostgreSQL version: {e}"))?,
        installation_dir: dir.join("install"),
        data_dir: dir.join("data"),
        password_file: dir.join("pwfile"),
        host: "127.0.0.1".into(),
        port,
        password,
        temporary: false,
        timeout: Some(TIMEOUT),
        ..Settings::default()
    })
}

fn failed(doing: &str, e: &postgresql_embedded::Error) -> Error {
    format!("Couldn't {doing} the code index's database (PostgreSQL): {e}").into()
}

/// A value kept in a file: read back, or made and written the first time.
fn remembered(file: &Path, make: impl FnOnce() -> Result<String, Error>) -> Result<String, Error> {
    if let Ok(v) = std::fs::read_to_string(file)
        && !v.trim().is_empty()
    {
        return Ok(v.trim().to_string());
    }
    let v = make()?;
    std::fs::write(file, &v).map_err(|e| format!("Couldn't write {}: {e}", file.display()))?;
    Ok(v)
}

fn free_port() -> Result<u16, Error> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// The port a server wrote in its postmaster.pid (its fourth line), if there's one.
fn pid_port(data: &Path) -> Option<u16> {
    let pid = std::fs::read_to_string(data.join("postmaster.pid")).ok()?;
    port_of(&pid)
}

fn port_of(pid_file: &str) -> Option<u16> {
    pid_file.lines().nth(3)?.trim().parse().ok()
}

/// A server is running on this data: its postmaster.pid names a port that answers.
fn listening(data: &Path) -> bool {
    pid_port(data).is_some_and(|port| {
        let at = SocketAddr::from(([127, 0, 0, 1], port));
        TcpStream::connect_timeout(&at, Duration::from_millis(500)).is_ok()
    })
}

/// A postmaster.pid left by a server that's gone (Windows ended it, the PC went off): both
/// pg_ctl and postgresql_embedded would take the server for running and wait on it forever.
fn forget_stale_pid(data: &Path) {
    let pid = data.join("postmaster.pid");
    if pid.exists() {
        log::warn!("the code index's database left a postmaster.pid behind; setting it aside");
        let _ = std::fs::rename(&pid, data.join("postmaster.pid.stale"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_is_the_fourth_line_of_postmaster_pid() {
        let pid = "31684\nC:/x/pg/data\n1793257682\n60798\n\nlocalhost\n  1  2\nready\n";
        assert_eq!(port_of(pid), Some(60798));
        assert_eq!(port_of("31684\n"), None);
        assert_eq!(port_of("1\n2\n3\nnot a port\n"), None);
    }

    #[test]
    fn a_remembered_value_is_made_once() {
        let dir = std::env::temp_dir().join(format!("cbot-pg-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("port");
        assert_eq!(remembered(&file, || Ok("5000".into())).unwrap(), "5000");
        assert_eq!(remembered(&file, || Ok("6000".into())).unwrap(), "5000");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_data_folder_with_no_server_is_not_listening() {
        let dir = std::env::temp_dir().join(format!("cbot-pg-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!listening(&dir));
        let free = free_port().unwrap();
        std::fs::write(dir.join("postmaster.pid"), format!("1\nx\n2\n{free}\n")).unwrap();
        assert!(!listening(&dir));
        forget_stale_pid(&dir);
        assert!(!dir.join("postmaster.pid").exists() && dir.join("postmaster.pid.stale").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
