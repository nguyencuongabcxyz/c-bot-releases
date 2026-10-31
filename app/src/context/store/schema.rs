//! The store's tables. Each migration runs once, in one transaction, under an advisory lock
//! (two C-Bots starting together don't run one twice), and is recorded in `migrations`.
//! Conventions: the scope comes first in every key, so every read is a range inside one
//! folder; paths sort as bytes (COLLATE "C"), as in Rust; a file's chunks and facts go with it.

use super::*;

/// The lock migrations are run under (any number of our own).
const LOCK: i64 = 0x0c0b_07c0_47e8;

/// Each migration, by its number. Never edit one that has shipped: add the next.
const MIGRATIONS: &[(i32, &str)] = &[
    (
        1,
        r#"
    CREATE TABLE scopes (
        id bytea PRIMARY KEY,
        root text NOT NULL,
        generation bigint NOT NULL DEFAULT 0,
        purged bigint NOT NULL DEFAULT 0
    );
    CREATE TABLE files (
        scope_id bytea NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
        path text COLLATE "C" NOT NULL,
        size bigint NOT NULL,
        mtime bigint NOT NULL,
        hash bytea NOT NULL,
        type text NOT NULL,
        generation bigint NOT NULL,
        PRIMARY KEY (scope_id, path)
    );
    CREATE INDEX files_by_generation ON files (scope_id, generation);
    CREATE TABLE chunks (
        scope_id bytea NOT NULL,
        path text COLLATE "C" NOT NULL,
        idx integer NOT NULL,
        code boolean NOT NULL,
        line_from integer NOT NULL,
        line_to integer NOT NULL,
        symbol text NOT NULL,
        text text NOT NULL,
        hash bytea NOT NULL,
        PRIMARY KEY (scope_id, path, idx),
        FOREIGN KEY (scope_id, path) REFERENCES files (scope_id, path) ON DELETE CASCADE
    );
    CREATE INDEX chunks_by_hash ON chunks (hash);
    CREATE TABLE embeddings (
        model text NOT NULL,
        hash bytea NOT NULL,
        vector bytea NOT NULL,
        PRIMARY KEY (model, hash)
    );
    CREATE TABLE code_facts (
        scope_id bytea NOT NULL,
        path text COLLATE "C" NOT NULL,
        facts text NOT NULL,
        PRIMARY KEY (scope_id, path),
        FOREIGN KEY (scope_id, path) REFERENCES files (scope_id, path) ON DELETE CASCADE
    );
    CREATE TABLE tombstones (
        scope_id bytea NOT NULL REFERENCES scopes (id) ON DELETE CASCADE,
        path text COLLATE "C" NOT NULL,
        generation bigint NOT NULL,
        PRIMARY KEY (scope_id, path)
    );
    CREATE INDEX tombstones_by_generation ON tombstones (scope_id, generation);
    "#,
    ),
    (
        2,
        // Every file read again: a chunk's hash now covers its file's opening comment
        // (embed::input_of), so every chunk's must be made again.
        r#"
    UPDATE files SET size = -1, hash = ''::bytea;
    "#,
    ),
    (
        3,
        // C# files read again: their chunks' hashes now cover the doc comment on their first type
        // (embed::input_of).
        r#"
    UPDATE files SET size = -1, hash = ''::bytea WHERE type = 'csharp';
    "#,
    ),
    (
        4,
        // TypeScript and JavaScript files read again: their facts now say what they export under
        // another name (`export default Store`), and a re-export's names (graph::Links).
        r#"
    UPDATE files SET size = -1, hash = ''::bytea WHERE type IN ('typescript', 'tsx');
    "#,
    ),
    (
        5,
        // The chunks still to embed are paged through by hash, inside a folder (unembedded).
        r#"
    CREATE INDEX chunks_by_scope_hash ON chunks (scope_id, hash);
    "#,
    ),
];

pub(super) async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(LOCK)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())",
    )
    .execute(&mut *tx)
    .await?;
    let done: Vec<i32> = sqlx::query_scalar("SELECT version FROM migrations")
        .fetch_all(&mut *tx)
        .await?;
    for (version, sql) in MIGRATIONS {
        if done.contains(version) {
            continue;
        }
        sqlx::raw_sql(*sql).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO migrations (version) VALUES ($1)")
            .bind(version)
            .execute(&mut *tx)
            .await?;
        log::info!("code index: migrated its database to {version}");
    }
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_go_up_one_by_one() {
        let versions: Vec<i32> = MIGRATIONS.iter().map(|(v, _)| *v).collect();
        let expected: Vec<i32> = (1..=i32::try_from(MIGRATIONS.len()).unwrap()).collect();
        assert_eq!(versions, expected);
    }
}
