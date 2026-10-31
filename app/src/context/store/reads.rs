//! What the engine reads back from the store: a folder's generation, what it had of each file
//! (to tell what changed), and, for a derived index that reflects an older generation, what
//! was written or deleted after it, read in one snapshot so the generation it reports covers
//! exactly the rows it returns. A replay is full when the index is new, older than the folder's
//! last clearing, or ahead of the store (the store was reset).

use super::*;

/// A folder as the store knows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::context) struct Scope {
    pub generation: i64,
}

/// What changed after a generation.
#[derive(Debug, Default)]
pub(in crate::context) struct Since {
    pub generation: i64, // (what the replay brings the index up to)
    pub full: bool,      // (start over: everything there is comes in `written`)
    pub gone: Vec<String>,
}

/// A file's code facts as stored (JSON), with its type.
pub(in crate::context) struct StoredFacts {
    pub path: String,
    pub ty: String,
    pub facts: String,
}

/// A chunk as stored.
#[derive(Clone, Debug)]
pub(in crate::context) struct StoredChunk {
    pub path: String,
    pub idx: i32,
    pub code: bool,
    pub line_from: i32,
    pub line_to: i32,
    pub symbol: String,
    pub text: String,
}

/// A chunk's row, as read.
type ChunkRow = (String, i32, bool, i32, i32, String, String);
/// …and whether it has its vector.
type EmbeddedChunkRow = (String, i32, bool, i32, i32, String, String, bool);

impl From<ChunkRow> for StoredChunk {
    fn from((path, idx, code, line_from, line_to, symbol, text): ChunkRow) -> Self {
        StoredChunk {
            path,
            idx,
            code,
            line_from,
            line_to,
            symbol,
            text,
        }
    }
}

impl Store {
    /// The folder's scope, made the first time.
    pub(in crate::context) fn open_scope(&self, id: &ScopeId, root: &str) -> Result<Scope, Error> {
        let generation: i64 = block(
            sqlx::query_scalar(
                "INSERT INTO scopes (id, root) VALUES ($1, $2) \
                 ON CONFLICT (id) DO UPDATE SET root = EXCLUDED.root RETURNING generation",
            )
            .bind(&id[..])
            .bind(root)
            .fetch_one(&self.pool),
        )?;
        Ok(Scope { generation })
    }

    /// What it had of each file.
    pub(in crate::context) fn stored(
        &self,
        id: &ScopeId,
    ) -> Result<HashMap<String, Stored>, Error> {
        self.stored_of(id, None)
    }

    /// What the store has of these files (those it has).
    pub(in crate::context) fn stored_these(
        &self,
        id: &ScopeId,
        paths: &[String],
    ) -> Result<HashMap<String, Stored>, Error> {
        self.stored_of(id, Some(paths))
    }

    fn stored_of(
        &self,
        id: &ScopeId,
        paths: Option<&[String]>,
    ) -> Result<HashMap<String, Stored>, Error> {
        let rows: Vec<(String, i64, i64, Vec<u8>)> = block(
            sqlx::query_as(
                "SELECT path, size, mtime, hash FROM files \
                 WHERE scope_id = $1 AND ($2::text[] IS NULL OR path = ANY($2))",
            )
            .bind(&id[..])
            .bind(paths)
            .fetch_all(&self.pool),
        )?;
        Ok(rows
            .into_iter()
            .map(|(path, size, mtime, hash)| {
                (
                    path,
                    Stored {
                        stamp: Stamp { size, mtime },
                        hash,
                    },
                )
            })
            .collect())
    }

    /// The code facts written after generation `since` (all of them in a full replay). Every
    /// file written has its row (a document's facts are empty), so it replaces the one before.
    pub(in crate::context) fn facts_since(
        &self,
        id: &ScopeId,
        since: i64,
    ) -> Result<(Since, Vec<StoredFacts>), Error> {
        block(async {
            let mut tx = self.begin().await?;
            let s = snapshot(&mut tx, id, since).await?;
            let rows: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT f.path, f.type, c.facts FROM files f JOIN code_facts c USING (scope_id, path) \
                 WHERE f.scope_id = $1 AND ($2 OR f.generation > $3)",
            )
            .bind(&id[..])
            .bind(s.full)
            .bind(since)
            .fetch_all(&mut *tx)
            .await?;
            tx.commit().await?;
            let facts = rows
                .into_iter()
                .map(|(path, ty, facts)| StoredFacts { path, ty, facts })
                .collect();
            Ok((s, facts))
        })
    }

    /// The chunks written after generation `since` (all of them in a full replay); the paths
    /// written are in `Since::gone` too, so whatever they had before goes first.
    pub(in crate::context) fn chunks_since(
        &self,
        id: &ScopeId,
        since: i64,
    ) -> Result<(Since, Vec<StoredChunk>), Error> {
        block(async {
            let mut tx = self.begin().await?;
            let mut s = snapshot(&mut tx, id, since).await?;
            let written: Vec<String> = sqlx::query_scalar(
                "SELECT path FROM files WHERE scope_id = $1 AND ($2 OR generation > $3)",
            )
            .bind(&id[..])
            .bind(s.full)
            .bind(since)
            .fetch_all(&mut *tx)
            .await?;
            let chunks: Vec<ChunkRow> = sqlx::query_as(
                "SELECT c.path, c.idx, c.code, c.line_from, c.line_to, c.symbol, c.text \
                 FROM chunks c JOIN files f USING (scope_id, path) \
                 WHERE c.scope_id = $1 AND ($2 OR f.generation > $3) ORDER BY c.path, c.idx",
            )
            .bind(&id[..])
            .bind(s.full)
            .bind(since)
            .fetch_all(&mut *tx)
            .await?;
            tx.commit().await?;
            s.gone.extend(written);
            Ok((s, chunks.into_iter().map(StoredChunk::from).collect()))
        })
    }

    /// These chunks, by (path, index).
    pub(in crate::context) fn chunks(
        &self,
        id: &ScopeId,
        keys: &[(String, i32)],
    ) -> Result<Vec<StoredChunk>, Error> {
        if keys.is_empty() {
            return Ok(vec![]);
        }
        let rows: Vec<ChunkRow> = block(
            sqlx::query_as(
                "SELECT c.path, c.idx, c.code, c.line_from, c.line_to, c.symbol, c.text \
                 FROM chunks c JOIN UNNEST($2::text[], $3::int4[]) AS k (path, idx) ON c.path = k.path AND c.idx = k.idx \
                 WHERE c.scope_id = $1",
            )
            .bind(&id[..])
            .bind(keys.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>())
            .bind(keys.iter().map(|(_, i)| *i).collect::<Vec<_>>())
            .fetch_all(&self.pool),
        )?;
        Ok(rows.into_iter().map(StoredChunk::from).collect())
    }

    /// The chunk holding each of these lines (path, line), in the order asked, once each.
    pub(in crate::context) fn chunks_at(
        &self,
        id: &ScopeId,
        at: &[(String, u32)],
    ) -> Result<Vec<(String, i32)>, Error> {
        if at.is_empty() {
            return Ok(vec![]);
        }
        let rows: Vec<(i32, String, i32)> = block(
            sqlx::query_as(
                "SELECT a.n::int4, c.path, c.idx FROM chunks c \
                 JOIN UNNEST($2::text[], $3::int4[]) WITH ORDINALITY AS a (path, line, n) \
                 ON c.path = a.path AND c.line_from <= a.line AND c.line_to >= a.line \
                 WHERE c.scope_id = $1 ORDER BY a.n, c.idx",
            )
            .bind(&id[..])
            .bind(at.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>())
            .bind(
                at.iter()
                    .map(|(_, l)| i32::try_from(*l).unwrap_or(i32::MAX))
                    .collect::<Vec<_>>(),
            )
            .fetch_all(&self.pool),
        )?;
        let mut seen = HashSet::new();
        Ok(rows
            .into_iter()
            .map(|(_, path, idx)| (path, idx))
            .filter(|k| seen.insert(k.clone()))
            .collect())
    }

    /// How many files and chunks the folder has.
    pub(in crate::context) fn counts(&self, id: &ScopeId) -> Result<(i64, i64), Error> {
        Ok(block(
            sqlx::query_as(
                "SELECT (SELECT count(*) FROM files WHERE scope_id = $1), (SELECT count(*) FROM chunks WHERE scope_id = $1)",
            )
            .bind(&id[..])
            .fetch_one(&self.pool),
        )?)
    }

    /// The folder's files, by path: each one's type and size as last read, its chunks, how many
    /// of them have their vector from `model`, and its definitions (from its code facts).
    pub(in crate::context) fn files(
        &self,
        id: &ScopeId,
        model: &str,
    ) -> Result<Vec<StoredFile>, Error> {
        let rows: Vec<(String, String, i64, i64, i64, i64)> = block(
            sqlx::query_as(
                "SELECT f.path, f.type, greatest(f.size, 0), \
                 (SELECT count(*) FROM chunks c WHERE c.scope_id = f.scope_id AND c.path = f.path), \
                 (SELECT count(*) FROM chunks c JOIN embeddings e ON e.model = $2 AND e.hash = c.hash \
                  WHERE c.scope_id = f.scope_id AND c.path = f.path), \
                 coalesce((SELECT json_array_length(cf.facts::json -> 'defs') FROM code_facts cf \
                  WHERE cf.scope_id = f.scope_id AND cf.path = f.path), 0)::bigint \
                 FROM files f WHERE f.scope_id = $1 ORDER BY f.path",
            )
            .bind(&id[..])
            .bind(model)
            .fetch_all(&self.pool),
        )?;
        Ok(rows
            .into_iter()
            .map(|(path, ty, bytes, chunks, embedded, defs)| StoredFile {
                path,
                ty,
                bytes,
                chunks,
                embedded,
                defs,
            })
            .collect())
    }

    /// A file's code facts as stored (JSON), if the store has the file.
    pub(in crate::context) fn facts_of(
        &self,
        id: &ScopeId,
        path: &str,
    ) -> Result<Option<String>, Error> {
        Ok(block(
            sqlx::query_scalar(
                "SELECT coalesce(cf.facts, '{}') FROM files f LEFT JOIN code_facts cf USING (scope_id, path) \
                 WHERE f.scope_id = $1 AND f.path = $2",
            )
            .bind(&id[..])
            .bind(path)
            .fetch_optional(&self.pool),
        )?)
    }

    /// How many definitions the folder's code has (from its code facts).
    pub(in crate::context) fn defs_count(&self, id: &ScopeId) -> Result<i64, Error> {
        Ok(block(
            sqlx::query_scalar(
                "SELECT coalesce(sum(json_array_length(facts::json -> 'defs')), 0)::bigint \
                 FROM code_facts WHERE scope_id = $1",
            )
            .bind(&id[..])
            .fetch_one(&self.pool),
        )?)
    }

    /// A file's chunks, in order, each with whether it has its vector from `model`.
    pub(in crate::context) fn chunks_of(
        &self,
        id: &ScopeId,
        path: &str,
        model: &str,
    ) -> Result<Vec<(StoredChunk, bool)>, Error> {
        let rows: Vec<EmbeddedChunkRow> = block(
            sqlx::query_as(
                "SELECT c.path, c.idx, c.code, c.line_from, c.line_to, c.symbol, c.text, \
                 EXISTS (SELECT 1 FROM embeddings e WHERE e.model = $3 AND e.hash = c.hash) \
                 FROM chunks c WHERE c.scope_id = $1 AND c.path = $2 ORDER BY c.idx",
            )
            .bind(&id[..])
            .bind(path)
            .bind(model)
            .fetch_all(&self.pool),
        )?;
        Ok(rows
            .into_iter()
            .map(|(path, idx, code, from, to, symbol, text, embedded)| {
                let chunk = StoredChunk::from((path, idx, code, from, to, symbol, text));
                (chunk, embedded)
            })
            .collect())
    }

    /// Everything the store holds, in a few numbers: each folder (its files by type, with their
    /// bytes, and its vectors from `model`), the database's size and the vectors kept by model.
    pub(in crate::context) fn overview(&self, model: &str) -> Result<Overview, Error> {
        block(async {
            let types: Vec<(String, String, i64, i64)> = sqlx::query_as(
                "SELECT s.root, f.type, count(*), coalesce(sum(greatest(f.size, 0)), 0)::bigint \
                 FROM files f JOIN scopes s ON s.id = f.scope_id GROUP BY s.root, f.type",
            )
            .fetch_all(&self.pool)
            .await?;
            let mut by_root: HashMap<String, Vec<(String, i64, i64)>> = HashMap::new();
            for (root, ty, files, bytes) in types {
                by_root.entry(root).or_default().push((ty, files, bytes));
            }
            let folders: Vec<(String, i64, i64, i64, i64)> = sqlx::query_as(
                "SELECT s.root, s.generation, \
                 (SELECT count(*) FROM files f WHERE f.scope_id = s.id), \
                 (SELECT count(*) FROM chunks c WHERE c.scope_id = s.id), \
                 (SELECT count(*) FROM chunks c WHERE c.scope_id = s.id AND EXISTS \
                  (SELECT 1 FROM embeddings e WHERE e.model = $1 AND e.hash = c.hash)) \
                 FROM scopes s ORDER BY s.root",
            )
            .bind(model)
            .fetch_all(&self.pool)
            .await?;
            let bytes: i64 = sqlx::query_scalar("SELECT pg_database_size(current_database())")
                .fetch_one(&self.pool)
                .await?;
            let vectors: Vec<(String, i64)> = sqlx::query_as(
                "SELECT model, count(*) FROM embeddings GROUP BY model ORDER BY model",
            )
            .fetch_all(&self.pool)
            .await?;
            Ok(Overview {
                folders: folders
                    .into_iter()
                    .map(|(root, generation, files, chunks, embedded)| StoredFolder {
                        types: by_root.remove(&root).unwrap_or_default(),
                        root,
                        generation,
                        files,
                        chunks,
                        embedded,
                    })
                    .collect(),
                bytes,
                vectors,
            })
        })
    }
}

/// A file of a folder, as the store keeps it (files).
pub(in crate::context) struct StoredFile {
    pub path: String,
    pub ty: String,
    pub bytes: i64,
    pub chunks: i64,
    pub embedded: i64, // (its chunks with their vector)
    pub defs: i64,
}

/// What the store holds (overview).
pub(in crate::context) struct Overview {
    pub folders: Vec<StoredFolder>,
    pub bytes: i64,                  // (the database, on disk)
    pub vectors: Vec<(String, i64)>, // (model -> how many)
}

/// A folder in the store.
pub(in crate::context) struct StoredFolder {
    pub root: String,
    pub generation: i64,
    pub files: i64,
    pub chunks: i64,
    pub embedded: i64,
    pub types: Vec<(String, i64, i64)>, // (a file type, as the store keeps it -> its files, bytes)
}

/// The folder's generation and the paths deleted after `since`, in a snapshot that the rest
/// of the transaction reads too.
async fn snapshot(
    tx: &mut Transaction<'static, Postgres>,
    id: &ScopeId,
    since: i64,
) -> Result<Since, sqlx::Error> {
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut **tx)
        .await?;
    let (generation, purged): (i64, i64) =
        sqlx::query_as("SELECT generation, purged FROM scopes WHERE id = $1")
            .bind(&id[..])
            .fetch_optional(&mut **tx)
            .await?
            .unwrap_or((0, 0));
    let full = replay_all(since, generation, purged);
    let gone = if full {
        vec![]
    } else {
        sqlx::query_scalar("SELECT path FROM tombstones WHERE scope_id = $1 AND generation > $2")
            .bind(&id[..])
            .bind(since)
            .fetch_all(&mut **tx)
            .await?
    };
    Ok(Since {
        generation,
        full,
        gone,
    })
}

/// An index at generation `since` starts over: it's new, older than the folder's last
/// clearing, or ahead of the store.
fn replay_all(since: i64, generation: i64, purged: i64) -> bool {
    since == 0 || since < purged || since > generation
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_index_starts_over_when_new_cleared_since_or_ahead() {
        assert!(replay_all(0, 5, 0));
        assert!(replay_all(3, 5, 4)); // (cleared at 4)
        assert!(replay_all(9, 5, 0)); // (the store was reset)
        assert!(!replay_all(3, 5, 2));
        assert!(!replay_all(5, 5, 0));
    }
}
