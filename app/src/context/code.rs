//! A folder's code as the tools read it, in memory: each code file's definitions and the names
//! it uses (names interned once for all of them). It's derived from the store's code facts and
//! kept at the store's generation: loaded whole the first time, then caught up with what was
//! written or deleted after the generation it reflects.

use super::*;

/// Names, each kept once and known by a number.
#[derive(Default)]
pub(super) struct Names {
    ids: HashMap<Box<str>, u32>,
}

impl Names {
    fn id(&mut self, s: &str) -> u32 {
        if let Some(id) = self.ids.get(s) {
            return *id;
        }
        let id = u32::try_from(self.ids.len()).unwrap_or(u32::MAX);
        self.ids.insert(s.into(), id);
        id
    }

    pub(super) fn get(&self, s: &str) -> Option<u32> {
        self.ids.get(s).copied()
    }
}

/// A code file as the tools read it.
pub(super) struct File {
    pub lang: Lang,
    pub defs: Vec<Def>,
    pub names: Vec<(u32, u32)>, // (a name it uses, how often), by name id
    pub links: graph::Links,    // (its imports, calls, heritage: for the graph)
}

impl File {
    /// How often it uses a name (0: never).
    pub(super) fn uses(&self, name: u32) -> u32 {
        self.names
            .binary_search_by_key(&name, |(n, _)| *n)
            .map_or(0, |i| self.names[i].1)
    }
}

#[derive(Default)]
pub(super) struct Code {
    pub files: BTreeMap<String, Arc<File>>, // (shared, so a snapshot is cheap)
    pub names: Names,
    pub generation: i64, // (the store's, that this reflects; 0: not loaded)
    pub map_cache: Option<(i64, String)>, // (the map with nothing to focus on, for a generation)
}

impl Code {
    /// A file's facts in (in place of what it had); a file that isn't code just goes.
    pub(super) fn put(&mut self, path: &str, ty: FileType, facts: Facts) {
        self.files.remove(path);
        let Some(lang) = ty.lang() else {
            return;
        };
        let names = facts
            .names
            .iter()
            .map(|(n, c)| (self.names.id(n), *c))
            .collect::<BTreeMap<u32, u32>>()
            .into_iter()
            .collect();
        self.files.insert(
            path.to_string(),
            Arc::new(File {
                lang,
                defs: facts.defs,
                names,
                links: facts.links,
            }),
        );
    }

    pub(super) fn remove(&mut self, path: &str) {
        self.files.remove(path);
    }

    /// Its files as they are now (shared, not copied), to build the graph from without holding
    /// the code meanwhile. (Without the names: the graph doesn't count them.)
    pub(super) fn snapshot(&self) -> Code {
        Code {
            files: self.files.clone(),
            generation: self.generation,
            ..Code::default()
        }
    }

    pub(super) fn symbols(&self) -> usize {
        self.files.values().map(|f| f.defs.len()).sum()
    }

    /// A file by its path in the folder: exactly, else whatever its letters' case.
    pub(super) fn file(&self, rel: &str) -> Option<(&String, &File)> {
        self.files
            .get_key_value(rel)
            .or_else(|| self.files.iter().find(|(k, _)| k.eq_ignore_ascii_case(rel)))
            .map(|(k, f)| (k, &**f))
    }

    /// Bring it to the store's generation, from what was written and deleted after its own.
    pub(super) fn catch_up(&mut self, since: Since, written: Vec<StoredFacts>) {
        if since.full {
            *self = Code::default();
        }
        for path in &since.gone {
            self.remove(path);
        }
        for f in written {
            let ty = FileType::from_id(&f.ty);
            let facts: Facts = serde_json::from_str(&f.facts).unwrap_or_default();
            match ty {
                Some(ty) => self.put(&f.path, ty, facts),
                None => self.remove(&f.path),
            }
        }
        self.generation = since.generation;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(src: &str) -> Facts {
        parse::read(Lang::Rust, src).unwrap()
    }

    #[test]
    fn files_go_in_and_out_and_names_are_counted() {
        let mut code = Code::default();
        code.put(
            "a.rs",
            FileType::Code(Lang::Rust),
            facts("fn open() { store(); }"),
        );
        code.put("b.rs", FileType::Code(Lang::Rust), facts("fn store() {}"));
        code.put("README.md", FileType::Markdown, Facts::default());
        assert_eq!(code.files.len(), 2);
        assert_eq!(code.symbols(), 2);
        let store = code.names.get("store").unwrap();
        assert_eq!(code.files["a.rs"].uses(store), 1);
        assert_eq!(code.files["b.rs"].uses(store), 0); // (defining it isn't using it)
        code.put("a.rs", FileType::Code(Lang::Rust), facts("fn open() {}"));
        assert_eq!(code.files["a.rs"].uses(store), 0);
        code.remove("b.rs");
        assert_eq!(code.files.len(), 1);
    }

    #[test]
    fn it_catches_up_with_the_store() {
        let mut code = Code::default();
        let stored = |path: &str, src: &str| StoredFacts {
            path: path.into(),
            ty: "rust".into(),
            facts: serde_json::to_string(&facts(src)).unwrap(),
        };
        code.catch_up(
            Since {
                generation: 2,
                full: true,
                gone: vec![],
            },
            vec![stored("a.rs", "fn a() {}"), stored("b.rs", "fn b() {}")],
        );
        assert_eq!((code.generation, code.files.len()), (2, 2));
        code.catch_up(
            Since {
                generation: 3,
                full: false,
                gone: vec!["a.rs".into()],
            },
            vec![stored("c.rs", "fn c() {}")],
        );
        let paths: Vec<&str> = code.files.keys().map(String::as_str).collect();
        assert_eq!((code.generation, paths), (3, vec!["b.rs", "c.rs"]));
        code.catch_up(
            Since {
                generation: 5,
                full: true,
                gone: vec![],
            },
            vec![stored("d.rs", "fn d() {}")],
        );
        assert_eq!(code.files.keys().collect::<Vec<_>>(), ["d.rs"]);
    }

    #[test]
    fn a_file_is_found_whatever_its_case() {
        let mut code = Code::default();
        code.put(
            "Src/Main.rs",
            FileType::Code(Lang::Rust),
            facts("fn main() {}"),
        );
        assert_eq!(code.file("src/main.rs").unwrap().0, "Src/Main.rs");
        assert!(code.file("src/other.rs").is_none());
    }
}
