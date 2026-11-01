//! TypeScript's and JavaScript's imports: by relative path (with or without an extension, an
//! index file, `.js` written for a `.ts`) or through the `paths` of the nearest tsconfig.json
//! (and its siblings, tsconfig.app.json…, and what they extend).

use super::*;

/// How far a tsconfig's `extends` is followed.
const EXTENDS: usize = 5;

/// A tsconfig's paths: each alias and where it goes, ("@/*", ["src/*"]), already joined to
/// where they're from.
pub(super) type TsPaths = Vec<(String, Vec<String>)>;

/// A tsconfig paths for each of these folders that has some, the deepest folder first.
pub(super) fn ts_settings(root: &Path, dirs: BTreeSet<String>) -> Vec<(String, TsPaths)> {
    let mut ts: Vec<(String, TsPaths)> = dirs
        .into_iter()
        .filter_map(|dir| {
            let paths: Vec<_> = ts_configs(root, &dir)
                .iter()
                .flat_map(|c| ts_config(root, c))
                .collect();
            (!paths.is_empty()).then_some((dir, paths))
        })
        .collect();
    ts.sort_by_key(|(dir, _)| {
        std::cmp::Reverse(if dir.is_empty() {
            0
        } else {
            dir.matches('/').count() + 1
        })
    });
    ts
}

impl Settings {
    /// The tsconfig paths a file sees: its nearest folder's first.
    pub(super) fn ts_paths_for<'a>(
        &'a self,
        file: &'a str,
    ) -> impl Iterator<Item = &'a (String, Vec<String>)> {
        self.ts
            .iter()
            .filter(move |(dir, _)| crate::context::search::under_path(file, dir))
            .flat_map(|(_, paths)| paths)
    }
}

/// A folder's tsconfigs (tsconfig.json first, then jsconfig.json, then tsconfig.*.json), as
/// paths in the folder.
fn ts_configs(root: &Path, dir: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
        return vec![];
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| {
            n == "tsconfig.json"
                || n == "jsconfig.json"
                || (n.starts_with("tsconfig.") && n.ends_with(".json"))
        })
        .collect();
    names.sort_by_key(|n| (n != "tsconfig.json", n != "jsconfig.json", n.clone()));
    names.into_iter().map(|n| join(dir, &n)).collect()
}

/// The alias a `baseUrl` stands for: any import that isn't relative may be a file under it
/// (`src/common/x` with `"baseUrl": "./"`), after the `paths`, and a package's when it isn't.
pub(super) const BASE_URL: &str = "*";

/// A tsconfig's `compilerOptions.paths`, joined to where they're from: its `baseUrl` (or that
/// of one it extends), else the folder of the config that gave them; then the `baseUrl`
/// itself (BASE_URL). `rel` is its path in the folder.
fn ts_config(root: &Path, rel: &str) -> TsPaths {
    let mut paths: Option<(String, serde_json::Map<String, serde_json::Value>)> = None;
    let mut base: Option<String> = None;
    let mut at = Some(rel.to_string());
    let mut seen = HashSet::new();
    while let Some(file) = at.take() {
        if !seen.insert(file.clone()) || seen.len() > EXTENDS {
            break;
        }
        let Some(json) = std::fs::read_to_string(root.join(&file))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&strip_jsonc(&t)).ok())
        else {
            break;
        };
        let dir = dir_of(&file);
        let options = &json["compilerOptions"];
        if base.is_none() {
            base = options["baseUrl"].as_str().and_then(|b| climb(dir, b));
        }
        if paths.is_none() {
            paths = options["paths"]
                .as_object()
                .map(|p| (dir.to_string(), p.clone()));
        }
        // (only a file of the folder: a package's, `@tsconfig/node20`, says nothing of its paths)
        at = extended(&json["extends"]).and_then(|e| {
            let e = if e.ends_with(".json") {
                e.to_string()
            } else {
                format!("{e}.json")
            };
            climb(dir, &e)
        });
    }
    let mut out: TsPaths = vec![];
    if let Some((dir, paths)) = paths {
        let from = base.clone().unwrap_or(dir);
        out.extend(paths.iter().map(|(alias, to)| {
            let to = to
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(serde_json::Value::as_str)
                        .filter_map(|p| climb(&from, p))
                        .collect()
                })
                .unwrap_or_default();
            (alias.clone(), to)
        }));
    }
    if let Some(base) = base {
        out.push((BASE_URL.to_string(), vec![join(&base, "*")]));
    }
    out
}

/// The file a tsconfig extends (the last given wins: it's the one that counts most), if it's
/// a path rather than a package.
fn extended(value: &serde_json::Value) -> Option<&str> {
    let last = match value {
        serde_json::Value::Array(a) => a.iter().rev().find_map(serde_json::Value::as_str),
        v => v.as_str(),
    }?;
    last.starts_with('.').then_some(last)
}

/// JSON with comments (`//`, `/* */`) and trailing commas, as tsconfig.json allows: as JSON.
fn strip_jsonc(text: &str) -> String {
    let c: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    while i < c.len() {
        if in_string {
            out.push(c[i]);
            if c[i] == '\\' {
                if let Some(&n) = c.get(i + 1) {
                    out.push(n);
                    i += 1;
                }
            } else if c[i] == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if let Some(after) = comment_end(&c, i) {
            i = after;
        } else if c[i] == ',' && closes(&c, i + 1) {
            i += 1;
        } else {
            in_string = c[i] == '"';
            out.push(c[i]);
            i += 1;
        }
    }
    out
}

/// Where a comment starting at `i` ends, if one does.
fn comment_end(c: &[char], i: usize) -> Option<usize> {
    match (c.get(i), c.get(i + 1)) {
        (Some('/'), Some('/')) => Some((i + 2..c.len()).find(|&j| c[j] == '\n').unwrap_or(c.len())),
        (Some('/'), Some('*')) => Some(
            (i + 2..c.len())
                .find(|&j| c[j] == '*' && c.get(j + 1) == Some(&'/'))
                .map_or(c.len(), |j| j + 2),
        ),
        _ => None,
    }
}

/// What comes at `i`, past spaces and comments, closes an object or an array.
fn closes(c: &[char], mut i: usize) -> bool {
    loop {
        match c.get(i) {
            Some(ch) if ch.is_whitespace() => i += 1,
            Some('}' | ']') => return true,
            Some(_) => match comment_end(c, i) {
                Some(after) => i = after,
                None => return false,
            },
            None => return false,
        }
    }
}

/// `rel` from folder `dir`, as a path in the folder: None if it climbs out of it.
fn climb(dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    for p in rel.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    Some(parts.join("/"))
}

pub(super) fn typescript(g: &Graph, settings: &Settings, from: &str, spec: &str) -> Target {
    let package = || {
        let package = match spec.split('/').collect::<Vec<_>>()[..] {
            [scope, name, ..] if scope.starts_with('@') => format!("{scope}/{name}"),
            [name, ..] => name.to_string(),
            _ => spec.to_string(),
        };
        Target::External(package)
    };
    let mut bases = vec![];
    // (only a baseUrl matched: a package's, unless a file of the folder is there)
    let mut only_base = true;
    if spec.starts_with('.') {
        bases.push(join(dir_of(from), spec));
        only_base = false;
    } else {
        for (alias, to) in settings.ts_paths_for(from) {
            let (head, wild) = alias
                .split_once('*')
                .map_or((alias.as_str(), false), |(h, _)| (h, true));
            let before = bases.len();
            if wild && spec.starts_with(head) {
                let rest = &spec[head.len()..];
                bases.extend(to.iter().map(|t| t.replacen('*', rest, 1)));
            } else if !wild && spec == alias {
                bases.extend(to.iter().cloned());
            }
            if bases.len() > before && alias != BASE_URL {
                only_base = false;
            }
        }
        if bases.is_empty() {
            return package();
        }
    }
    const EXTENSIONS: &[&str] = &[
        ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
    ];
    for base in bases {
        // (`./x.js` written for `./x.ts`, as ESM wants)
        let stem = base.strip_suffix(".js").unwrap_or(&base);
        let mut candidates = vec![base.clone()];
        candidates.extend(EXTENSIONS.iter().map(|e| format!("{stem}{e}")));
        candidates.extend(EXTENSIONS.iter().map(|e| format!("{base}/index{e}")));
        if let Some(f) = first(g, &candidates) {
            return Target::Files(vec![f]);
        }
    }
    if only_base {
        package()
    } else {
        Target::Nowhere
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::Folder;
    use super::*;

    fn strings(v: &[(&str, &[&str])]) -> TsPaths {
        v.iter()
            .map(|(a, to)| {
                (
                    (*a).to_string(),
                    to.iter().map(|t| (*t).to_string()).collect(),
                )
            })
            .collect()
    }
    #[test]
    fn jsonc_loses_its_comments_and_trailing_commas_but_not_its_strings() {
        let t = "{\n  // the pages\n  \"a\": \"http://x/*y*/\", /* why */\n  \"b\": [1, 2,],\n  \"c\": {\"d\": \",}\",}, // last\n}";
        let json: serde_json::Value = serde_json::from_str(&strip_jsonc(t)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"a": "http://x/*y*/", "b": [1, 2], "c": {"d": ",}"}})
        );
    }

    #[test]
    fn tsconfig_paths_come_from_its_base_or_what_it_extends() {
        let f = Folder::of(&[
            (
                "tsconfig.base.json",
                "{ \"compilerOptions\": { \"baseUrl\": \"./src\", } }",
            ),
            (
                "tsconfig.json",
                "{\n  \"extends\": \"./tsconfig.base\",\n  /* the pages */\n  \"compilerOptions\": { \"paths\": { \"@/*\": [\"./gui/*\"], \"x\": [\"../lib/x\"] } },\n}",
            ),
            (
                "web/tsconfig.app.json",
                "{ \"compilerOptions\": { \"paths\": { \"~/*\": [\"./app/*\"] } } }",
            ),
        ]);
        assert_eq!(
            ts_config(&f.0, "tsconfig.json"),
            strings(&[
                ("@/*", &["src/gui/*"]),
                ("x", &["lib/x"]),
                ("*", &["src/*"])
            ])
        );
        // (no baseUrl: from its own folder)
        assert_eq!(
            ts_config(&f.0, "web/tsconfig.app.json"),
            strings(&[("~/*", &["web/app/*"])])
        );
        assert!(ts_config(&f.0, "nope.json").is_empty());
    }

    #[test]
    fn a_path_cannot_climb_out_of_the_folder() {
        assert_eq!(climb("a/b", "../c").as_deref(), Some("a/c"));
        assert_eq!(climb("", "./x/*").as_deref(), Some("x/*"));
        assert_eq!(climb("a", "../../c"), None);
    }

    #[test]
    fn a_base_url_alone_finds_files_under_it_and_leaves_packages_outside() {
        let f = Folder::of(&[(
            "tsconfig.json",
            "{ \"compilerOptions\": { \"baseUrl\": \"./\" } }",
        )]);
        let mut code = Code::default();
        let files = [
            (
                "src/common/date.utils.ts",
                "export const convertUtcToString = (d: Date): string => '';\n",
            ),
            (
                "src/care/care.controller.ts",
                "import { convertUtcToString } from 'src/common/date.utils';\nimport { Controller } from '@nestjs/common';\nexport function list() { return convertUtcToString(new Date()); }\n",
            ),
        ];
        for (path, src) in files {
            let ty = crate::context::langs::FileType::of(path).unwrap();
            code.put(
                path,
                ty,
                crate::context::parse::read(Lang::TypeScript, src).unwrap(),
            );
        }
        let g = Graph::build(&code, &f.0);
        let controller = g.file_of("src/care/care.controller.ts").unwrap();
        let utils = g.file_of("src/common/date.utils.ts").unwrap();
        assert!(g.imports[controller].contains(&utils));
        assert!(g.externals[controller].contains("@nestjs/common"));
    }
}
