//! The context engine's store, in its PostgreSQL (install/): the one source of truth. For each
//! folder (a scope) it keeps the files as last read (size, time, content hash), their chunks
//! (what search finds) and their code facts (what they define and the names they use), and a
//! generation that every commit moves on by one. The keyword index and the code in memory are
//! derived from it: each knows the generation it reflects and catches up by replaying what was
//! written after it. A commit names the generation it was planned on and is refused when
//! another got in first (the fence), so a late writer can never land stale work.
//!   schema.rs   the tables, made or brought up to date when the store opens
//!   commit.rs   one change, all or nothing
//!   reads.rs    what the engine reads back
//!   vectors.rs  the chunks' vectors, a cache shared by every folder

mod commit;
mod reads;
mod schema;
mod vectors;

pub(in crate::context) use commit::*;
pub(in crate::context) use reads::*;

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::{Postgres, Transaction};

use super::ingest::{Chunk, Stamp, Stored};
use super::{block, embed};
use crate::runtime::Error;

/// A folder's id in the store: 16 bytes of BLAKE3 over its path as the engine names it.
pub(in crate::context) type ScopeId = [u8; 16];

pub(in crate::context) fn scope_id(key: &str) -> ScopeId {
    let mut id = [0; 16];
    id.copy_from_slice(&blake3::hash(key.as_bytes()).as_bytes()[..16]);
    id
}

/// The id as letters, for folder names (no path ever appears in one).
pub(in crate::context) fn hex(id: &ScopeId) -> String {
    id.iter().map(|b| format!("{b:02x}")).collect()
}

pub(in crate::context) struct Store {
    pool: PgPool,
}

impl Store {
    /// The store at `url`, its tables made or brought up to date.
    pub(in crate::context) fn open(url: &str) -> Result<Store, Error> {
        let pool = block(
            PgPoolOptions::new()
                .max_connections(8)
                .acquire_timeout(Duration::from_secs(30))
                .connect(url),
        )?;
        block(schema::migrate(&pool))?;
        Ok(Store { pool })
    }

    async fn begin(&self) -> Result<Transaction<'static, Postgres>, sqlx::Error> {
        self.pool.begin().await
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::context::ingest::Chunk;
    use crate::context::install;

    fn chunk(from: u32, text: &str) -> Chunk {
        Chunk {
            from,
            to: from + 1,
            symbol: "s".into(),
            text: text.into(),
            code: true,
        }
    }

    fn stamp(size: i64) -> Stamp {
        Stamp { size, mtime: 7 }
    }

    /// The store on a real PostgreSQL (downloaded once into %TEMP%\cbot-context-live).
    #[test]
    #[ignore]
    fn the_store_keeps_and_replays_what_it_is_given() {
        let dir = std::env::temp_dir().join("cbot-context-live");
        let cluster = install::start(&dir, &|note| log::info!("{note}")).unwrap();
        let store = Store::open(&cluster.url).unwrap();
        let id = scope_id(&format!("test-{}", uuid::Uuid::new_v4()));
        assert_eq!(store.open_scope(&id, "C:\\t").unwrap().generation, 0);
        let a_chunks = [chunk(1, "fn a() {}"), chunk(3, "fn b() {}")];
        let b_chunks = [chunk(1, "# Notes")];
        let row = |path, chunks, ty| FileRow {
            path,
            stamp: stamp(1),
            hash: b"h",
            ty,
            chunks,
            facts: "{}".into(),
        };
        let first = Commit {
            written: vec![
                row("a.rs", &a_chunks[..], "rust"),
                row("b.md", &b_chunks[..], "markdown"),
            ],
            ..Commit::default()
        };
        assert_eq!(store.commit(&id, 0, &first).unwrap(), 1);
        assert!(store.commit(&id, 0, &first).is_err()); // (planned on 0: another got in first)

        let stored = store.stored(&id).unwrap();
        assert_eq!(
            stored["a.rs"],
            Stored {
                stamp: stamp(1),
                hash: b"h".to_vec()
            }
        );
        let (s, facts) = store.facts_since(&id, 0).unwrap();
        assert!(s.full && s.generation == 1 && facts.len() == 2);
        let (s, chunks) = store.chunks_since(&id, 0).unwrap();
        assert_eq!(
            chunks
                .iter()
                .map(|c| (c.path.as_str(), c.idx))
                .collect::<Vec<_>>(),
            [("a.rs", 0), ("a.rs", 1), ("b.md", 0)]
        );
        assert_eq!(s.gone, ["a.rs", "b.md"]); // (what's written replaces what was there)

        let second = Commit {
            gone: vec!["a.rs".into()],
            touched: vec![("b.md".into(), stamp(9))],
            ..Commit::default()
        };
        assert_eq!(store.commit(&id, 1, &second).unwrap(), 2);
        let (s, facts) = store.facts_since(&id, 1).unwrap();
        assert!(!s.full && facts.is_empty() && s.gone == ["a.rs"]);
        assert_eq!(store.stored(&id).unwrap()["b.md"].stamp, stamp(9));
        assert_eq!(store.counts(&id).unwrap(), (1, 1));
        let got = store
            .chunks(&id, &[("b.md".into(), 0), ("a.rs".into(), 0)])
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "# Notes");

        let clear = Commit {
            clear: true,
            ..Commit::default()
        };
        assert_eq!(store.commit(&id, 2, &clear).unwrap(), 3);
        let (s, facts) = store.facts_since(&id, 2).unwrap();
        assert!(s.full && facts.is_empty()); // (cleared after 2: start over)
        cluster.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_has_one_id_and_it_names_no_path() {
        let a = scope_id("c:\\work\\shop");
        assert_eq!(a, scope_id("c:\\work\\shop"));
        assert_ne!(a, scope_id("c:\\work\\shop2"));
        assert_eq!(hex(&a).len(), 32);
        assert!(hex(&a).chars().all(|c| c.is_ascii_hexdigit()));
    }
}
