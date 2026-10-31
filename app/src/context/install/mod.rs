//! What the context engine needs that's too big for the installer, got the first time it's
//! needed: its PostgreSQL (postgres.rs), downloaded once and run while C-Bot runs, and the
//! sentence model that search by meaning runs (model.rs) with what runs it (ONNX Runtime,
//! runtime.rs). The store on the database is set up once for every robot: whoever needs it
//! first sets it up while the others wait for that, and a failure is tried again on the next
//! need.

mod model;
mod postgres;
mod runtime;

pub(in crate::context) use model::*;
pub(in crate::context) use postgres::*;
pub(in crate::context) use runtime::*;

use std::io::Write;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

use postgresql_embedded::{PostgreSQL, Settings, Status, VersionReq};

use super::block;
use super::store::Store;
use crate::runtime::{Error, Locked};

/// The database, up.
pub(in crate::context) struct Database {
    pub cluster: Cluster,
    pub store: Store,
}

/// The database, once it's up; or setting up.
#[derive(Default)]
pub(in crate::context) struct Setup {
    state: Mutex<SetupState>,
    turn: Condvar,
}

#[derive(Default)]
struct SetupState {
    busy: bool,
    up: Option<Arc<Database>>,
}

impl Setup {
    /// The database under `dir`, set up if need be (`say` hears how that's going).
    pub(in crate::context) fn database(
        &self,
        dir: &Path,
        say: &dyn Fn(&str),
    ) -> Result<Arc<Database>, Error> {
        {
            let mut s = self.state.locked();
            while s.busy {
                s = self.turn.wait(s).unwrap_or_else(PoisonError::into_inner);
            }
            if let Some(db) = &s.up {
                return Ok(db.clone());
            }
            s.busy = true;
        }
        let made = set_up(dir, say);
        {
            let mut s = self.state.locked();
            s.busy = false;
            if let Ok(db) = &made {
                s.up = Some(db.clone());
            }
        }
        self.turn.notify_all();
        made
    }

    /// The database if it's up (asking starts nothing).
    pub(in crate::context) fn running(&self) -> Option<Arc<Database>> {
        self.state.locked().up.clone()
    }

    /// C-Bot is going: the database stops, if C-Bot started it.
    pub(in crate::context) fn stop(&self) {
        if let Some(db) = self.state.locked().up.take() {
            db.cluster.stop();
        }
    }

    /// The database under `dir` stopped, whoever started it, and let go (its data is about to
    /// go: wipe.rs). A setup under way is waited for first.
    pub(in crate::context) fn shut(&self, dir: &Path) -> Result<(), Error> {
        let up = {
            let mut s = self.state.locked();
            while s.busy {
                s = self.turn.wait(s).unwrap_or_else(PoisonError::into_inner);
            }
            s.up.take()
        };
        match up {
            Some(db) => db.cluster.halt(),
            None => postgres::halt_any(dir),
        }
    }
}

fn set_up(dir: &Path, say: &dyn Fn(&str)) -> Result<Arc<Database>, Error> {
    let cluster = postgres::start(dir, say)?;
    say("Opening the index…");
    match Store::open(&cluster.url) {
        Ok(store) => Ok(Arc::new(Database { cluster, store })),
        Err(e) => {
            cluster.stop();
            Err(e)
        }
    }
}
