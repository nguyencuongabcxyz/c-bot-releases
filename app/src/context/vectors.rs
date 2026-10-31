//! A folder's chunk vectors, in an index in memory (usearch: HNSW, half precision, cosine),
//! derived from the store's: loaded whole the first time search by meaning needs them, then
//! kept in step as files are written (look.rs) and chunks embedded (embed/). Up to EXACT
//! vectors, a search compares the question with every one the filter keeps (exact); past that,
//! the HNSW graph finds the nearest quickly, skipping what the filter doesn't keep as it goes.

use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

use super::*;

/// Up to this many vectors, a search is exact.
const EXACT: usize = 50_000;

#[derive(Default)]
pub(super) struct Vectors {
    index: Option<Index>,
    keys: HashMap<u64, (String, i32)>, // key -> its chunk (path, index)
    by_path: HashMap<String, Vec<u64>>, // a file -> its chunks' keys
    pub loaded: bool,
}

/// A chunk's key in the index.
fn key(path: &str, idx: i32) -> u64 {
    let mut h = blake3::Hasher::new();
    h.update(path.as_bytes());
    h.update(&[0]);
    h.update(&idx.to_le_bytes());
    let mut k = [0; 8];
    k.copy_from_slice(&h.finalize().as_bytes()[..8]);
    u64::from_le_bytes(k)
}

fn failed(e: impl std::fmt::Display) -> Error {
    format!("The search by meaning's index: {e}").into()
}

impl Vectors {
    fn index(&mut self) -> Result<&Index, Error> {
        if self.index.is_none() {
            let options = IndexOptions {
                dimensions: embed::DIMENSIONS,
                metric: MetricKind::Cos,
                quantization: ScalarKind::F16,
                ..IndexOptions::default()
            };
            self.index = Some(Index::new(&options).map_err(failed)?);
        }
        self.index.as_ref().ok_or_else(|| failed("not made"))
    }

    /// All of a folder's vectors (path, chunk index, vector as stored), in place of any before.
    pub(super) fn load(&mut self, rows: Vec<(String, i32, Vec<u8>)>) -> Result<(), Error> {
        *self = Vectors::default();
        self.put(rows)?;
        self.loaded = true;
        Ok(())
    }

    /// These vectors in (replacing a chunk's own if it had one).
    pub(super) fn put(&mut self, rows: Vec<(String, i32, Vec<u8>)>) -> Result<(), Error> {
        for (path, idx, bytes) in rows {
            let k = key(&path, idx);
            let index = self.index()?;
            if index.contains(k) {
                index.remove(k).map_err(failed)?;
            }
            if index.size() + 1 > index.capacity() {
                index
                    .reserve((index.capacity() * 2).max(1024))
                    .map_err(failed)?;
            }
            index.add(k, &embed::from_bytes(&bytes)).map_err(failed)?;
            if self.keys.insert(k, (path.clone(), idx)).is_none() {
                self.by_path.entry(path).or_default().push(k);
            }
        }
        Ok(())
    }

    /// How many chunks have their vector in it.
    pub(super) fn len(&self) -> usize {
        self.keys.len()
    }

    /// Every chunk of these files out.
    pub(super) fn remove(&mut self, paths: &[String]) -> Result<(), Error> {
        for path in paths {
            let Some(keys) = self.by_path.remove(path) else {
                continue;
            };
            for k in keys {
                self.keys.remove(&k);
                if let Some(index) = &self.index {
                    index.remove(k).map_err(failed)?;
                }
            }
        }
        Ok(())
    }

    /// The `n` chunks nearest the question's vector among those the filter keeps, nearest first
    /// (path, index, similarity).
    pub(super) fn search(
        &self,
        query: &[f32],
        n: usize,
        filter: Filter,
    ) -> Result<Vec<(String, i32, f32)>, Error> {
        let Some(index) = &self.index else {
            return Ok(vec![]);
        };
        if self.keys.is_empty() {
            return Ok(vec![]);
        }
        let exact = self.keys.len() <= EXACT;
        let keeps = |k: u64| {
            self.keys.get(&k).is_some_and(|(p, _)| {
                filter.keeps(p, matches!(FileType::of(p), Some(FileType::Code(_))))
            })
        };
        let found = match (filter.all(), exact) {
            (true, true) => index.exact_search(query, n),
            (true, false) => index.search(query, n),
            (false, true) => return self.exact_among(index, query, n, &keeps),
            (false, false) => index.filtered_search(query, n, keeps),
        }
        .map_err(failed)?;
        Ok(found
            .keys
            .iter()
            .zip(&found.distances)
            .filter_map(|(k, d)| self.keys.get(k).map(|(p, i)| (p.clone(), *i, 1.0 - d)))
            .collect())
    }

    /// The `n` nearest among the chunks `keeps` takes, each compared with the question.
    fn exact_among(
        &self,
        index: &Index,
        query: &[f32],
        n: usize,
        keeps: &dyn Fn(u64) -> bool,
    ) -> Result<Vec<(String, i32, f32)>, Error> {
        let norm = |v: &[f32]| v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
        let q = norm(query);
        let mut v = vec![0f32; embed::DIMENSIONS];
        let mut near: Vec<(f32, u64)> = vec![];
        for &k in self.keys.keys().filter(|&&k| keeps(k)) {
            if index.get(k, &mut v).map_err(failed)? == 0 {
                continue;
            }
            let dot: f32 = v.iter().zip(query).map(|(a, b)| a * b).sum();
            near.push((dot / (norm(&v) * q), k));
        }
        near.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        Ok(near
            .into_iter()
            .take(n)
            .filter_map(|(s, k)| self.keys.get(&k).map(|(p, i)| (p.clone(), *i, s)))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(v: &[f32]) -> Vec<u8> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        let mut full = vec![0.0; embed::DIMENSIONS];
        for (i, x) in v.iter().enumerate() {
            full[i] = x / n;
        }
        embed::to_bytes(&full)
    }

    #[test]
    fn the_nearest_chunks_come_first_and_files_go_out_whole() {
        let mut v = Vectors::default();
        v.load(vec![
            ("a.rs".into(), 0, unit(&[1.0, 0.0])),
            ("a.rs".into(), 1, unit(&[0.7, 0.7])),
            ("b.rs".into(), 0, unit(&[0.0, 1.0])),
        ])
        .unwrap();
        assert_eq!(v.keys.len(), 3);
        let all = Filter::default();
        let q = embed::from_bytes(&unit(&[0.9, 0.1]));
        let got = v.search(&q, 2, all).unwrap();
        assert_eq!((got[0].0.as_str(), got[0].1), ("a.rs", 0));
        assert_eq!((got[1].0.as_str(), got[1].1), ("a.rs", 1));
        assert!(got[0].2 > 0.98);
        v.remove(&["a.rs".into()]).unwrap();
        let got = v.search(&q, 3, all).unwrap();
        assert_eq!(
            got.iter().map(|g| g.0.as_str()).collect::<Vec<_>>(),
            ["b.rs"]
        );
        // (a chunk put again replaces its vector)
        v.put(vec![("b.rs".into(), 0, unit(&[1.0, 0.0]))]).unwrap();
        assert_eq!(v.keys.len(), 1);
        assert!(v.search(&q, 1, all).unwrap()[0].2 > 0.98);
    }

    #[test]
    fn a_filtered_search_compares_only_what_the_filter_keeps() {
        let mut v = Vectors::default();
        v.load(vec![
            ("src/a.rs".into(), 0, unit(&[1.0, 0.0])),
            ("src/b.rs".into(), 0, unit(&[0.9, 0.1])),
            ("docs/a.md".into(), 0, unit(&[0.95, 0.05])),
            ("lib/c.rs".into(), 0, unit(&[0.0, 1.0])),
        ])
        .unwrap();
        let q = embed::from_bytes(&unit(&[1.0, 0.0]));
        let paths = |under, within| -> Vec<String> {
            v.search(&q, 2, Filter { under, within })
                .unwrap()
                .into_iter()
                .map(|g| g.0)
                .collect()
        };
        assert_eq!(paths("src", Within::All), ["src/a.rs", "src/b.rs"]);
        assert_eq!(paths("", Within::Docs), ["docs/a.md"]);
        // (the farthest, but the only one there)
        assert_eq!(paths("lib", Within::Code), ["lib/c.rs"]);
        let got = v
            .search(
                &q,
                1,
                Filter {
                    under: "src/a.rs",
                    within: Within::All,
                },
            )
            .unwrap();
        assert!(got[0].2 > 0.98);
    }

    #[test]
    fn keys_tell_chunks_apart() {
        assert_ne!(key("a.rs", 0), key("a.rs", 1));
        assert_ne!(key("a.rs", 1), key("a.rs1", 0));
        assert_eq!(key("a.rs", 3), key("a.rs", 3));
    }
}
