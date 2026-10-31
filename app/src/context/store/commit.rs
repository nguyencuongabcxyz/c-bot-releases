//! One change to a folder in the store, all or nothing: everything cleared first (reading a
//! folder afresh), files gone (each leaves a tombstone, for the derived indexes to hear of),
//! files only restamped, and files written again (their chunks and facts replaced). It's
//! planned on a generation and refused if the folder has moved on since. Each table is written
//! with one statement over arrays, never row by row. Or a folder forgotten altogether (wipe.rs).

use sqlx::PgConnection;

use super::*;

/// Refused: another commit got in first.
pub(in crate::context) const CONFLICT: &str =
    "The folder's index changed while this was being written; it'll be read again.";

/// A file written again, as the store keeps it.
pub(in crate::context) struct FileRow<'a> {
    pub path: &'a str,
    pub stamp: Stamp,
    pub hash: &'a [u8],
    pub ty: &'static str,
    pub chunks: &'a [Chunk],
    pub facts: String, // (its code facts, as JSON)
}

#[derive(Default)]
pub(in crate::context) struct Commit<'a> {
    pub clear: bool,
    pub gone: Vec<String>,
    pub touched: Vec<(String, Stamp)>,
    pub written: Vec<FileRow<'a>>,
}

impl Store {
    /// Apply it on top of generation `on`: the generation it makes, or why it couldn't.
    pub(in crate::context) fn commit(
        &self,
        scope: &ScopeId,
        on: i64,
        c: &Commit,
    ) -> Result<i64, Error> {
        block(self.commit_async(scope, on, c))
    }

    async fn commit_async(&self, scope: &ScopeId, on: i64, c: &Commit<'_>) -> Result<i64, Error> {
        let mut tx = self.begin().await?;
        let generation: Option<i64> = sqlx::query_scalar(
            "UPDATE scopes SET generation = generation + 1 WHERE id = $1 AND generation = $2 RETURNING generation",
        )
        .bind(&scope[..])
        .bind(on)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(generation) = generation else {
            return Err(CONFLICT.into());
        };
        if c.clear {
            clear(&mut tx, scope, generation).await?;
        }
        gone(&mut tx, scope, generation, &c.gone).await?;
        touched(&mut tx, scope, &c.touched).await?;
        written(&mut tx, scope, generation, &c.written).await?;
        tx.commit().await?;
        Ok(generation)
    }

    /// The folder forgotten altogether (its files, their chunks and facts go with it), and the
    /// vectors no folder's chunks have any more. A reading still under way is fenced off: its
    /// commit finds no generation to move on.
    pub(in crate::context) fn forget(&self, scope: &ScopeId) -> Result<(), Error> {
        Ok(block(self.forget_async(scope))?)
    }

    async fn forget_async(&self, scope: &ScopeId) -> Result<(), sqlx::Error> {
        let mut tx = self.begin().await?;
        sqlx::query("DELETE FROM scopes WHERE id = $1")
            .bind(&scope[..])
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "DELETE FROM embeddings e WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.hash = e.hash)",
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }
}

/// (PostgreSQL text can't hold a NUL.)
fn clean(text: &str) -> String {
    text.replace('\0', " ")
}

/// The hash of what a chunk's vector is made of (embed::input_of, its file's first chunk
/// `first` included: a file's opening comment changed, all its chunks are embedded again).
fn hash_of(path: &str, idx: i32, first: &str, c: &Chunk) -> Vec<u8> {
    let input = embed::input_of(path, idx, &clean(first), &clean(&c.symbol), &clean(&c.text));
    blake3::hash(input.as_bytes()).as_bytes().to_vec()
}

async fn clear(db: &mut PgConnection, scope: &ScopeId, generation: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM files WHERE scope_id = $1")
        .bind(&scope[..])
        .execute(&mut *db)
        .await?;
    sqlx::query("DELETE FROM tombstones WHERE scope_id = $1")
        .bind(&scope[..])
        .execute(&mut *db)
        .await?;
    sqlx::query("UPDATE scopes SET purged = $2 WHERE id = $1")
        .bind(&scope[..])
        .bind(generation)
        .execute(&mut *db)
        .await?;
    Ok(())
}

async fn gone(
    db: &mut PgConnection,
    scope: &ScopeId,
    generation: i64,
    paths: &[String],
) -> Result<(), sqlx::Error> {
    if paths.is_empty() {
        return Ok(());
    }
    sqlx::query("DELETE FROM files WHERE scope_id = $1 AND path = ANY($2)")
        .bind(&scope[..])
        .bind(paths)
        .execute(&mut *db)
        .await?;
    sqlx::query(
        "INSERT INTO tombstones (scope_id, path, generation) SELECT $1, p, $3 FROM UNNEST($2::text[]) AS p \
         ON CONFLICT (scope_id, path) DO UPDATE SET generation = EXCLUDED.generation",
    )
    .bind(&scope[..])
    .bind(paths)
    .bind(generation)
    .execute(&mut *db)
    .await?;
    Ok(())
}

async fn touched(
    db: &mut PgConnection,
    scope: &ScopeId,
    files: &[(String, Stamp)],
) -> Result<(), sqlx::Error> {
    if files.is_empty() {
        return Ok(());
    }
    let paths: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
    let sizes: Vec<i64> = files.iter().map(|(_, s)| s.size).collect();
    let times: Vec<i64> = files.iter().map(|(_, s)| s.mtime).collect();
    sqlx::query(
        "UPDATE files AS f SET size = t.size, mtime = t.mtime \
         FROM UNNEST($2::text[], $3::int8[], $4::int8[]) AS t (path, size, mtime) \
         WHERE f.scope_id = $1 AND f.path = t.path",
    )
    .bind(&scope[..])
    .bind(paths)
    .bind(sizes)
    .bind(times)
    .execute(&mut *db)
    .await?;
    Ok(())
}

async fn written(
    db: &mut PgConnection,
    scope: &ScopeId,
    generation: i64,
    files: &[FileRow<'_>],
) -> Result<(), sqlx::Error> {
    if files.is_empty() {
        return Ok(());
    }
    let paths: Vec<&str> = files.iter().map(|f| f.path).collect();
    sqlx::query(
        "INSERT INTO files (scope_id, path, size, mtime, hash, type, generation) \
         SELECT $1, t.path, t.size, t.mtime, t.hash, t.type, $7 \
         FROM UNNEST($2::text[], $3::int8[], $4::int8[], $5::bytea[], $6::text[]) AS t (path, size, mtime, hash, type) \
         ON CONFLICT (scope_id, path) DO UPDATE SET size = EXCLUDED.size, mtime = EXCLUDED.mtime, \
         hash = EXCLUDED.hash, type = EXCLUDED.type, generation = EXCLUDED.generation",
    )
    .bind(&scope[..])
    .bind(&paths)
    .bind(files.iter().map(|f| f.stamp.size).collect::<Vec<_>>())
    .bind(files.iter().map(|f| f.stamp.mtime).collect::<Vec<_>>())
    .bind(files.iter().map(|f| f.hash.to_vec()).collect::<Vec<_>>())
    .bind(files.iter().map(|f| f.ty).collect::<Vec<_>>())
    .bind(generation)
    .execute(&mut *db)
    .await?;
    for table in [
        "DELETE FROM chunks WHERE scope_id = $1 AND path = ANY($2)",
        "DELETE FROM tombstones WHERE scope_id = $1 AND path = ANY($2)",
    ] {
        sqlx::query(table)
            .bind(&scope[..])
            .bind(&paths)
            .execute(&mut *db)
            .await?;
    }
    chunks(db, scope, files).await?;
    sqlx::query(
        "INSERT INTO code_facts (scope_id, path, facts) SELECT $1, t.path, t.facts \
         FROM UNNEST($2::text[], $3::text[]) AS t (path, facts) \
         ON CONFLICT (scope_id, path) DO UPDATE SET facts = EXCLUDED.facts",
    )
    .bind(&scope[..])
    .bind(&paths)
    .bind(files.iter().map(|f| clean(&f.facts)).collect::<Vec<_>>())
    .execute(&mut *db)
    .await?;
    Ok(())
}

async fn chunks(
    db: &mut PgConnection,
    scope: &ScopeId,
    files: &[FileRow<'_>],
) -> Result<(), sqlx::Error> {
    let openings: Vec<String> = files
        .iter()
        .map(|f| {
            let texts: Vec<&str> = f.chunks.iter().take(3).map(|c| c.text.as_str()).collect();
            embed::opening(f.path, &texts)
        })
        .collect();
    let all: Vec<(&str, i32, &Chunk, &str)> = files
        .iter()
        .zip(&openings)
        .flat_map(|(f, first)| {
            let first = first.as_str();
            f.chunks
                .iter()
                .enumerate()
                .map(move |(i, c)| (f.path, i32::try_from(i).unwrap_or(i32::MAX), c, first))
        })
        .collect();
    if all.is_empty() {
        return Ok(());
    }
    let line = |n: u32| i32::try_from(n).unwrap_or(i32::MAX);
    sqlx::query(
        "INSERT INTO chunks (scope_id, path, idx, code, line_from, line_to, symbol, text, hash) \
         SELECT $1, t.* FROM UNNEST($2::text[], $3::int4[], $4::bool[], $5::int4[], $6::int4[], $7::text[], $8::text[], $9::bytea[]) \
         AS t (path, idx, code, line_from, line_to, symbol, text, hash)",
    )
    .bind(&scope[..])
    .bind(all.iter().map(|(p, _, _, _)| *p).collect::<Vec<_>>())
    .bind(all.iter().map(|(_, i, _, _)| *i).collect::<Vec<_>>())
    .bind(all.iter().map(|(_, _, c, _)| c.code).collect::<Vec<_>>())
    .bind(all.iter().map(|(_, _, c, _)| line(c.from)).collect::<Vec<_>>())
    .bind(all.iter().map(|(_, _, c, _)| line(c.to)).collect::<Vec<_>>())
    .bind(all.iter().map(|(_, _, c, _)| clean(&c.symbol)).collect::<Vec<_>>())
    .bind(all.iter().map(|(_, _, c, _)| clean(&c.text)).collect::<Vec<_>>())
    // (a chunk's hash is of what its vector is made of: the cache key of its embedding)
    .bind(all.iter().map(|(p, i, c, first)| hash_of(p, *i, first, c)).collect::<Vec<_>>())
    .execute(&mut *db)
    .await?;
    Ok(())
}
