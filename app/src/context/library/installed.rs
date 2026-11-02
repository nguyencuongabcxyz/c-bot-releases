//! Finding a package the project has installed, as each ecosystem keeps it: an npm package in
//! node_modules (its types, or @types/<it>), a Rust crate at the version Cargo.lock pins in
//! Cargo's registry, a Python package in the project's virtualenv, a Go module at the version
//! go.mod requires in the module cache, a NuGet package at the version a .csproj references.
//! Each is looked for at the project's root and in the folders right under it (a repo with its
//! app in `app/`).

use super::*;

/// The files of a package read, at most.
const FILES_MAX: usize = 4_000;

/// Where the user's tools keep what they download.
pub(super) struct Homes {
    pub cargo: PathBuf,
    pub go: PathBuf,
    pub nuget: PathBuf,
}

impl Homes {
    /// As the user's environment says, else the tools' defaults under their home.
    pub(super) fn of_user() -> Homes {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from);
        let home = var("USERPROFILE")
            .or_else(|| var("HOME"))
            .unwrap_or_default();
        Homes {
            cargo: var("CARGO_HOME").unwrap_or_else(|| home.join(".cargo")),
            go: var("GOMODCACHE")
                .or_else(|| var("GOPATH").map(|p| p.join("pkg").join("mod")))
                .unwrap_or_else(|| home.join("go").join("pkg").join("mod")),
            nuget: var("NUGET_PACKAGES").unwrap_or_else(|| home.join(".nuget").join("packages")),
        }
    }
}

/// A package found: what it is, its version, where, and its files to read (none for NuGet:
/// its XML documentation instead).
pub(super) struct Installed {
    pub what: &'static str,
    pub name: String,
    pub version: String,
    pub dir: PathBuf,
    pub files: Vec<PathBuf>,
    /// A .NET package's XML documentation.
    pub docs: Option<PathBuf>,
}

/// The package named so, in the ecosystems `lang` says (None: any), first found.
pub(super) fn find(
    root: &Path,
    homes: &Homes,
    package: &str,
    lang: Option<Lang>,
) -> Option<Installed> {
    let wants = |l: &[Lang]| lang.is_none_or(|x| l.contains(&x));
    let places = places(root);
    let mut found = None;
    if wants(&[Lang::TypeScript, Lang::Tsx]) {
        found = found.or_else(|| places.iter().find_map(|p| npm(p, package)));
    }
    if wants(&[Lang::Rust]) {
        found = found.or_else(|| places.iter().find_map(|p| cargo(p, homes, package)));
    }
    if wants(&[Lang::Python]) {
        found = found.or_else(|| places.iter().find_map(|p| python(p, package)));
    }
    if wants(&[Lang::Go]) {
        found = found.or_else(|| places.iter().find_map(|p| go(p, homes, package)));
    }
    if wants(&[Lang::CSharp]) {
        found = found.or_else(|| nuget(root, homes, package));
    }
    found
}

/// The root and the folders right under it.
fn places(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![root.to_path_buf()];
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() && !hidden(p))
            .collect();
        dirs.sort();
        out.extend(dirs);
    }
    out
}

fn hidden(p: &Path) -> bool {
    p.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.') || n == "node_modules" || n == "target")
}

/// The files under `dir` that `keep` takes (by path), not in the folders `skip` names, at most
/// FILES_MAX.
fn files_under(dir: &Path, keep: &dyn Fn(&str) -> bool, skip: &[&str], deep: bool) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut queue = vec![dir.to_path_buf()];
    while let Some(d) = queue.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                if deep && !skip.contains(&name.as_str()) {
                    queue.push(p);
                }
            } else if keep(&name) && out.len() < FILES_MAX {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

/// A value in a JSON file's top level, as text.
fn json_string(text: &str, key: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    v.get(key)?.as_str().map(str::to_string)
}

// ---------------------------------------------------------------- npm

/// An npm package in `place`'s node_modules: its own types, else @types/<it>'s, else its
/// JavaScript.
fn npm(place: &Path, package: &str) -> Option<Installed> {
    let modules = place.join("node_modules");
    let dir = modules.join(package);
    let typed = |dir: &Path| {
        files_under(
            dir,
            &|n| n.ends_with(".d.ts") || n.ends_with(".d.mts"),
            &["node_modules"],
            true,
        )
    };
    let types_dir = {
        let bare = package.trim_start_matches('@').replace('/', "__");
        modules.join("@types").join(bare)
    };
    let (dir, files) = if dir.join("package.json").is_file() {
        match typed(&dir) {
            f if !f.is_empty() => (dir, f),
            _ if types_dir.join("package.json").is_file() => {
                let f = typed(&types_dir);
                (types_dir, f)
            }
            _ => {
                let js = |n: &str| n.ends_with(".js") || n.ends_with(".mjs") || n.ends_with(".cjs");
                let f = files_under(&dir, &js, &["node_modules", "test", "tests"], true);
                (dir, f)
            }
        }
    } else if types_dir.join("package.json").is_file() {
        let f = typed(&types_dir);
        (types_dir, f)
    } else {
        return None;
    };
    let version = json_string(&read(&dir.join("package.json")), "version").unwrap_or_default();
    Some(Installed {
        what: "npm package",
        name: package.to_string(),
        version,
        dir,
        files,
        docs: None,
    })
}

// ---------------------------------------------------------------- cargo

/// A crate at the version `place`'s Cargo.lock pins, in Cargo's registry (its `src/`).
fn cargo(place: &Path, homes: &Homes, package: &str) -> Option<Installed> {
    let lock = read(&place.join("Cargo.lock"));
    let wanted = package.replace('-', "_");
    let (name, version) = locked(&lock)
        .into_iter()
        .find(|(n, _)| n.replace('-', "_") == wanted)?;
    let registry = homes.cargo.join("registry").join("src");
    let folder = format!("{name}-{version}");
    let dir = std::fs::read_dir(&registry)
        .ok()?
        .flatten()
        .map(|e| e.path().join(&folder))
        .find(|d| d.is_dir())?;
    let files = files_under(&dir.join("src"), &|n| n.ends_with(".rs"), &[], true);
    Some(Installed {
        what: "Rust crate",
        name,
        version,
        dir,
        files,
        docs: None,
    })
}

/// The packages a Cargo.lock pins: (name, version), in its order.
pub(super) fn locked(lock: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    for block in lock.split("[[package]]").skip(1) {
        let field = |key: &str| {
            block.lines().find_map(|l| {
                let (k, v) = l.split_once('=')?;
                (k.trim() == key).then(|| v.trim().trim_matches('"').to_string())
            })
        };
        if let (Some(n), Some(v)) = (field("name"), field("version")) {
            out.push((n, v));
        }
    }
    out
}

// ---------------------------------------------------------------- python

/// A Python package in `place`'s virtualenv (.venv, venv, env), its version from its
/// dist-info.
fn python(place: &Path, package: &str) -> Option<Installed> {
    let module = package.replace('-', "_");
    for venv in [".venv", "venv", "env"] {
        for site in site_packages(&place.join(venv)) {
            let dir = site.join(&module);
            let single = site.join(format!("{module}.py"));
            let files = if dir.is_dir() {
                let py = |n: &str| n.ends_with(".py") || n.ends_with(".pyi");
                files_under(&dir, &py, &["tests", "test", "__pycache__"], true)
            } else if single.is_file() {
                vec![single]
            } else {
                continue;
            };
            let version = dist_version(&site, &module).unwrap_or_default();
            return Some(Installed {
                what: "Python package",
                name: package.to_string(),
                version,
                dir: if dir.is_dir() { dir } else { site },
                files,
                docs: None,
            });
        }
    }
    None
}

/// A virtualenv's site-packages: Windows' `Lib/site-packages`, else `lib/python3.x/…`.
fn site_packages(venv: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let windows = venv.join("Lib").join("site-packages");
    if windows.is_dir() {
        out.push(windows);
    }
    if let Ok(entries) = std::fs::read_dir(venv.join("lib")) {
        for e in entries.flatten() {
            let site = e.path().join("site-packages");
            if site.is_dir() {
                out.push(site);
            }
        }
    }
    out
}

/// A package's version, from its `<name>-<version>.dist-info` folder.
fn dist_version(site: &Path, module: &str) -> Option<String> {
    let prefix = format!("{}-", module.to_lowercase());
    std::fs::read_dir(site).ok()?.flatten().find_map(|e| {
        let name = e
            .file_name()
            .to_string_lossy()
            .to_lowercase()
            .replace('-', "_");
        let rest = name.strip_suffix(".dist_info")?;
        let prefix = prefix.replace('-', "_");
        rest.strip_prefix(&prefix).map(|v| v.replace('_', "-"))
    })
}

// ---------------------------------------------------------------- go

/// A Go package from a module `place`'s go.mod requires, in the module cache at that version:
/// the package's own folder (its files, not its tests').
fn go(place: &Path, homes: &Homes, package: &str) -> Option<Installed> {
    let module_file = read(&place.join("go.mod"));
    let (module, version) = required(&module_file)
        .into_iter()
        .filter(|(m, _)| package == m || package.starts_with(&format!("{m}/")))
        .max_by_key(|(m, _)| m.len())?;
    let sub = package[module.len()..].trim_start_matches('/');
    let dir = homes
        .go
        .join(format!("{}@{version}", escaped(&module)))
        .join(sub);
    let go_file = |n: &str| n.ends_with(".go") && !n.ends_with("_test.go");
    let files = files_under(&dir, &go_file, &[], false);
    if files.is_empty() {
        return None;
    }
    Some(Installed {
        what: "Go package",
        name: package.to_string(),
        version,
        dir,
        files,
        docs: None,
    })
}

/// The modules a go.mod requires: (path, version).
pub(super) fn required(go_mod: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let mut block = false;
    for line in go_mod.lines() {
        let line = line.split("//").next().unwrap_or("").trim();
        let spec = if block {
            if line == ")" {
                block = false;
                continue;
            }
            line
        } else if line == "require (" {
            block = true;
            continue;
        } else if let Some(rest) = line.strip_prefix("require ") {
            rest
        } else {
            continue;
        };
        let mut parts = spec.split_whitespace();
        if let (Some(m), Some(v)) = (parts.next(), parts.next()) {
            out.push((m.to_string(), v.to_string()));
        }
    }
    out
}

/// A module path as the module cache spells it: each capital as `!` and its small letter.
fn escaped(module: &str) -> String {
    module
        .chars()
        .flat_map(|c| {
            if c.is_ascii_uppercase() {
                vec!['!', c.to_ascii_lowercase()]
            } else {
                vec![c]
            }
        })
        .collect()
}

// ---------------------------------------------------------------- nuget

/// A NuGet package a .csproj of the project references (by its id, or by a namespace it
/// starts: `Newtonsoft.Json.Linq` is Newtonsoft.Json's), at that version: its XML docs.
fn nuget(root: &Path, homes: &Homes, package: &str) -> Option<Installed> {
    let projects = files_under(
        root,
        &|n| n.ends_with(".csproj"),
        &["node_modules", "bin", "obj", ".git"],
        true,
    );
    let wanted = package.to_lowercase();
    let (id, version) = projects
        .iter()
        .flat_map(|p| references(&read(p)))
        .filter(|(id, _)| {
            let id = id.to_lowercase();
            wanted == id || wanted.starts_with(&format!("{id}."))
        })
        .max_by_key(|(id, _)| id.len())?;
    let dir = homes.nuget.join(id.to_lowercase()).join(&version);
    let docs = files_under(&dir.join("lib"), &|n| n.ends_with(".xml"), &[], true)
        .into_iter()
        .filter(|p| {
            p.file_stem()
                .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case(&id))
        })
        .max_by_key(|p| p.to_string_lossy().to_string());
    Some(Installed {
        what: "NuGet package",
        name: id,
        version,
        dir,
        files: vec![],
        docs,
    })
}

/// The packages a .csproj references: (id, version).
pub(super) fn references(csproj: &str) -> Vec<(String, String)> {
    static REF: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)""#)
            .expect("a constant regex")
    });
    REF.captures_iter(csproj)
        .map(|c| (c[1].to_string(), c[2].to_string()))
        .collect()
}
