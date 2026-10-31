//! The chunks' vectors the store keeps, by (model, chunk hash): shared by every folder (a chunk
//! embedded once never is again) and outside the generations (a vector is a cache of what a
//! chunk says, not something a reading writes): the chunks still to embed, the vectors made for
//! them, and a folder's vectors for its index in memory (vectors.rs).

use super::*;

/// A chunk with no vector yet, and what its vector is made of (embed::input_of).
pub(in crate::context) struct Pending {
    pub hash: Vec<u8>,
    pub path: String,
    pub idx: i32,
    pub first: String, // (its file's opening: embed::opening)
    pub symbol: String,
    pub text: String,
}

/// A pending chunk as the query gives it: hash, path, index, its file's first texts, symbol, text.
type PendingRow = (Vec<u8>, String, i32, Vec<String>, String, String);

impl Store {
    /// At most `n` of the folder's chunks with no vector from `model` yet, by hash, after the
    /// hash `after` (empty: from the first), so a pass over them goes through the folder once
    /// rather than from its start each batch.
    pub(in crate::context) fn unembedded(
        &self,
        id: &ScopeId,
        model: &str,
        n: i64,
        after: &[u8],
    ) -> Result<Vec<Pending>, Error> {
        let rows: Vec<PendingRow> = block(
            sqlx::query_as(
                "SELECT DISTINCT ON (c.hash) c.hash, c.path, c.idx, \
                 ARRAY(SELECT f.text FROM chunks f WHERE f.scope_id = c.scope_id AND f.path = c.path AND f.idx < 3 ORDER BY f.idx), \
                 c.symbol, c.text FROM chunks c \
                 WHERE c.scope_id = $1 AND c.hash > $4 AND NOT EXISTS \
                 (SELECT 1 FROM embeddings e WHERE e.model = $2 AND e.hash = c.hash) \
                 ORDER BY c.hash LIMIT $3",
            )
            .bind(&id[..])
            .bind(model)
            .bind(n)
            .bind(after)
            .fetch_all(&self.pool),
        )?;
        Ok(rows
            .into_iter()
            .map(|(hash, path, idx, first, symbol, text)| {
                let first: Vec<&str> = first.iter().map(String::as_str).collect();
                Pending {
                    first: embed::opening(&path, &first),
                    hash,
                    path,
                    idx,
                    symbol,
                    text,
                }
            })
            .collect())
    }

    /// Vectors made by `model`, by chunk hash (the first one made for a hash stays).
    pub(in crate::context) fn put_embeddings(
        &self,
        model: &str,
        rows: &[(Vec<u8>, Vec<u8>)],
    ) -> Result<(), Error> {
        if rows.is_empty() {
            return Ok(());
        }
        block(
            sqlx::query(
                "INSERT INTO embeddings (model, hash, vector) SELECT $1, t.hash, t.vector \
                 FROM UNNEST($2::bytea[], $3::bytea[]) AS t (hash, vector) ON CONFLICT DO NOTHING",
            )
            .bind(model)
            .bind(rows.iter().map(|(h, _)| h.clone()).collect::<Vec<_>>())
            .bind(rows.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>())
            .execute(&self.pool),
        )?;
        Ok(())
    }

    /// The folder's chunk vectors from `model` (path, chunk index, vector): all of them, or
    /// those of these files.
    pub(in crate::context) fn vectors(
        &self,
        id: &ScopeId,
        model: &str,
        only: Option<&[String]>,
    ) -> Result<Vec<(String, i32, Vec<u8>)>, Error> {
        Ok(block(
            sqlx::query_as(
                "SELECT c.path, c.idx, e.vector FROM chunks c \
                 JOIN embeddings e ON e.model = $2 AND e.hash = c.hash \
                 WHERE c.scope_id = $1 AND ($3 OR c.path = ANY($4))",
            )
            .bind(&id[..])
            .bind(model)
            .bind(only.is_none())
            .bind(only.unwrap_or_default())
            .fetch_all(&self.pool),
        )?)
    }

    /// How many of the folder's chunks have a vector from `model`, of how many.
    pub(in crate::context) fn embedded(
        &self,
        id: &ScopeId,
        model: &str,
    ) -> Result<(i64, i64), Error> {
        Ok(block(
            sqlx::query_as(
                "SELECT count(*) FILTER (WHERE EXISTS \
                 (SELECT 1 FROM embeddings e WHERE e.model = $2 AND e.hash = c.hash)), count(*) \
                 FROM chunks c WHERE c.scope_id = $1",
            )
            .bind(&id[..])
            .bind(model)
            .fetch_one(&self.pool),
        )?)
    }
}
