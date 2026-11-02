//! library_api: what a library the project uses offers, read from the version it has
//! installed (not what a model remembers of another one): a name's definitions there, each
//! with its doc comment, attributes and signature, a type with its members; or, with no name,
//! the package's top level. The package is the one asked for, else the one the project's
//! imports bring the name in from.
//!   installed.rs   finding it: npm, Cargo's registry, a virtualenv, Go's module cache, NuGet
//!   nuget.rs       a .NET package's XML documentation (NuGet keeps no source)

mod installed;
mod nuget;

use std::sync::LazyLock;

use regex::Regex;

use super::*;
use installed::{Homes, Installed};

/// Definitions shown, at most; a type's members; a doc comment's lines; the top level's.
const FOUND_MAX: usize = 6;
const MEMBERS_MAX: usize = 40;
const DOC_LINES: usize = 25;
const TOP_MAX: usize = 150;
/// About how long an answer may get (characters).
const ANSWER_MAX: usize = 24_000;

/// library_api: `name` in `package` as installed ('' package: the one the project imports
/// the name from; '' name: the package's top level).
pub fn library_api(app: &AppHandle, id: &str, package: &str, name: &str) -> Result<String, Error> {
    let f = fresh(app, id)?;
    let name = name.trim();
    let (package, lang) = match package.trim() {
        "" => package_of(&f.code.locked(), name).ok_or_else(|| {
            format!("Which package is \"{name}\" from? No import of the project brings it in: give the package too.")
        })?,
        p => (p.to_string(), None),
    };
    answer(&f.root, &Homes::of_user(), &package, lang, name)
}

/// The package (and its language) the project's imports bring a name in from: a Rust path's
/// crate (`serde_json::from_str`), else an import naming it, or the module it's a member of
/// (`np.array`, `fmt.Println`). Never the project's own modules.
fn package_of(code: &Code, name: &str) -> Option<(String, Option<Lang>)> {
    if let Some((krate, _)) = name.split_once("::") {
        return Some((krate.to_string(), Some(Lang::Rust)));
    }
    let first = name.split('.').next().unwrap_or(name);
    for f in code.files.values() {
        for imp in &f.links.imports {
            let names_it = imp
                .names
                .iter()
                .any(|(n, local)| n == first || local == first)
                || imp.alias.as_deref() == Some(first)
                || imp.spec.rsplit(['/', '.', ':']).next() == Some(first);
            if names_it && let Some(p) = package_in(&imp.spec, f.lang) {
                return Some((p, Some(f.lang)));
            }
        }
    }
    None
}

/// The package an import's module is in: `@scope/pkg/sub` is `@scope/pkg`, `a.b` is `a`,
/// `serde::de` is `serde`; None for the project's own (`./x`, `@/x`, `crate::x`).
fn package_in(spec: &str, lang: Lang) -> Option<String> {
    let own = ["./", "../", "@/", "~/", "crate", "self", "super"];
    if spec == "." || own.iter().any(|p| spec.starts_with(p)) {
        return None;
    }
    Some(match lang {
        Lang::TypeScript | Lang::Tsx => {
            let mut parts = spec.split('/');
            let first = parts.next()?;
            match parts.next() {
                Some(second) if first.starts_with('@') => format!("{first}/{second}"),
                _ => first.to_string(),
            }
        }
        Lang::Python => spec.trim_start_matches('.').split('.').next()?.to_string(),
        Lang::Rust => spec.split("::").next()?.to_string(),
        _ => spec.to_string(),
    })
}

/// What `name` is in `package` (found in the ecosystem `lang` says, else any).
fn answer(
    root: &Path,
    homes: &Homes,
    package: &str,
    lang: Option<Lang>,
    name: &str,
) -> Result<String, Error> {
    let Some(pkg) = installed::find(root, homes, package, lang) else {
        return Err(format!(
            "\"{package}\" isn't installed where this project keeps its packages (node_modules, Cargo.lock with Cargo's registry, a .venv, go.mod with Go's module cache, a .csproj with NuGet's cache). Install it, or check its name."
        )
        .into());
    };
    let mut out = format!(
        "{} {} — {} ({})\n",
        pkg.name,
        pkg.version,
        pkg.what,
        pkg.dir.display()
    );
    if pkg.what == "NuGet package" {
        match &pkg.docs {
            Some(docs) => out.push_str(&dotnet(docs, name)),
            None => out.push_str("It has no XML documentation to read.\n"),
        }
    } else if name.is_empty() {
        out.push_str(&top_level(&pkg));
    } else {
        out.push_str(&definitions(&pkg, name));
    }
    if out.len() > ANSWER_MAX {
        out = parse::cut(&out, ANSWER_MAX);
        out.push_str("\n… (cut: ask for a narrower name)");
    }
    Ok(out)
}

/// A definition found: its file, itself, its doc comment and attributes, its members.
struct Found {
    file: String,
    def: Def,
    doc: Vec<String>,
    /// A Python docstring: the doc that comes after its signature.
    docstring: Vec<String>,
    members: Vec<Def>,
    public: bool,
}

/// The definitions of `name` (or `Holder.name`, `a::b::name`) in the package's files: those
/// in what the name says holds them first (no holder: those nothing holds), then the public.
fn definitions(pkg: &Installed, name: &str) -> String {
    let path = name.replace("::", ".");
    let (holder, last) = match path.rsplit_once('.') {
        Some((h, l)) => (h.rsplit('.').next(), l),
        None => (None, path.as_str()),
    };
    let mut found: Vec<Found> = vec![];
    for file in &pkg.files {
        let rel = file
            .strip_prefix(&pkg.dir)
            .unwrap_or(file)
            .to_string_lossy()
            .replace('\\', "/");
        let Some(lang) = Lang::of(&rel) else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        if !text.contains(last) {
            continue;
        }
        let Some(facts) = parse::read(lang, &text) else {
            continue;
        };
        found.extend(named_in(&facts.defs, &text, lang, &rel, last));
    }
    if found.is_empty() {
        return format!("Nothing named \"{last}\" is defined in it.\n");
    }
    // (what the name says holds it first; asked with no holder, what nothing holds first)
    let held = |f: &Found| match holder {
        Some(h) => f.def.container.as_deref() == Some(h),
        None => f.def.container.is_none(),
    };
    found.sort_by_key(|f| (!held(f), !f.public, f.file.len(), f.def.line));
    let mut out = String::new();
    for f in found.iter().take(FOUND_MAX) {
        out.push_str(&shown(f));
    }
    if found.len() > FOUND_MAX {
        out.push_str(&format!(
            "… and {} more of that name: say what holds it (Holder.name).\n",
            found.len() - FOUND_MAX
        ));
    }
    out
}

/// The definitions of `last` in one file, each with its doc comment and its members.
fn named_in(defs: &[Def], text: &str, lang: Lang, rel: &str, last: &str) -> Vec<Found> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = vec![];
    for (i, d) in defs.iter().enumerate() {
        if d.name != last {
            continue;
        }
        let from = d.head.clamp(1, d.line) as usize - 1;
        let doc = lines
            .get(from..d.line as usize - 1)
            .unwrap_or_default()
            .iter()
            .map(|l| l.trim().to_string())
            .collect();
        let members = defs[i + 1..]
            .iter()
            .take_while(|m| m.line <= d.end)
            .filter(|m| m.depth == d.depth + 1)
            .cloned()
            .collect();
        out.push(Found {
            file: rel.to_string(),
            public: public(lang, rel, d),
            def: d.clone(),
            doc,
            docstring: docstring(lang, &lines, d),
            members,
        });
    }
    out
}

/// A Python definition's docstring: the string its body starts with, a line each.
fn docstring(lang: Lang, lines: &[&str], d: &Def) -> Vec<String> {
    if lang != Lang::Python {
        return vec![];
    }
    let body = lines
        .get(d.line as usize..d.end as usize)
        .unwrap_or_default();
    let Some(first) = body.iter().position(|l| !l.trim().is_empty()) else {
        return vec![];
    };
    let start = body[first].trim();
    let Some(quote) = ["\"\"\"", "'''"].into_iter().find(|q| start.starts_with(q)) else {
        return vec![];
    };
    let mut out = vec![];
    for (i, l) in body[first..].iter().enumerate() {
        out.push(l.trim().to_string());
        let closes = if i == 0 {
            start.len() > 3 && start[3..].contains(quote)
        } else {
            l.contains(quote)
        };
        if closes {
            break;
        }
    }
    out
}

/// Whether a definition is part of what a package offers: Rust's `pub`, Go's capitalised,
/// Python's not `_`-led, a declaration file's anything (a script's what it exports).
fn public(lang: Lang, rel: &str, d: &Def) -> bool {
    match lang {
        Lang::Rust => d.sig.starts_with("pub") || d.container.is_some(),
        Lang::Go => d.name.starts_with(char::is_uppercase),
        Lang::Python => !d.name.starts_with('_'),
        _ => rel.ends_with(".d.ts") || rel.ends_with(".d.mts") || d.sig.contains("export"),
    }
}

/// A definition as shown: where, its doc comment, its signature, its members'.
fn shown(f: &Found) -> String {
    let d = &f.def;
    let holder = d
        .container
        .as_deref()
        .map_or(String::new(), |c| format!("{c}."));
    let mut out = format!(
        "\n{} {holder}{} — {}:{}-{}\n",
        d.kind.word(),
        d.name,
        f.file,
        d.line,
        d.end
    );
    for l in f.doc.iter().take(DOC_LINES) {
        out.push_str(&format!("  {l}\n"));
    }
    if f.doc.len() > DOC_LINES {
        out.push_str("  …\n");
    }
    out.push_str(&format!("  {}\n", d.sig));
    for l in f.docstring.iter().take(DOC_LINES) {
        out.push_str(&format!("    {l}\n"));
    }
    if !f.members.is_empty() {
        out.push_str(&format!("  members ({}):\n", f.members.len()));
        for m in f.members.iter().take(MEMBERS_MAX) {
            out.push_str(&format!("    {}\n", m.sig));
        }
        if f.members.len() > MEMBERS_MAX {
            out.push_str(&format!(
                "    … and {} more\n",
                f.members.len() - MEMBERS_MAX
            ));
        }
    }
    out
}

/// What a package offers at its top: its entry file's public definitions (and what it
/// re-exports): a package.json's `types`, a crate's lib.rs, a Python package's __init__.py, a
/// Go package's files.
fn top_level(pkg: &Installed) -> String {
    let entry = |p: PathBuf| pkg.files.iter().find(|f| **f == p).cloned();
    let manifest = std::fs::read_to_string(pkg.dir.join("package.json")).unwrap_or_default();
    let types = serde_json::from_str::<serde_json::Value>(&manifest)
        .ok()
        .and_then(|v| {
            v.get("types")
                .or_else(|| v.get("typings"))
                .and_then(|t| t.as_str().map(str::to_string))
        });
    let entries: Vec<PathBuf> = types
        .and_then(|t| entry(pkg.dir.join(t.trim_start_matches("./"))))
        .or_else(|| entry(pkg.dir.join("index.d.ts")))
        .or_else(|| entry(pkg.dir.join("src").join("lib.rs")))
        .or_else(|| entry(pkg.dir.join("__init__.py")))
        .map_or_else(|| pkg.files.iter().take(20).cloned().collect(), |e| vec![e]);
    let mut out = String::new();
    let mut shown = 0;
    for file in entries {
        let rel = file
            .strip_prefix(&pkg.dir)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let (Some(lang), Ok(text)) = (Lang::of(&rel), std::fs::read_to_string(&file)) else {
            continue;
        };
        let Some(facts) = parse::read(lang, &text) else {
            continue;
        };
        out.push_str(&format!("{rel}:\n"));
        for d in facts
            .defs
            .iter()
            .filter(|d| d.depth == 0 && public(lang, &rel, d))
        {
            shown += 1;
            if shown <= TOP_MAX {
                out.push_str(&format!("  {}:{}  {}\n", d.kind.word(), d.line, d.sig));
            }
        }
        let reexports: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|l| {
                l.starts_with("pub use ") || l.starts_with("export *") || l.starts_with("export {")
            })
            .take(40)
            .collect();
        if !reexports.is_empty() {
            out.push_str("  re-exports:\n");
            out.extend(
                reexports
                    .iter()
                    .map(|l| format!("    {}\n", parse::cut(l, 160))),
            );
        }
    }
    if shown > TOP_MAX {
        out.push_str(&format!("  … and {} more\n", shown - TOP_MAX));
    }
    out.push_str("Ask with a name for one of them, its doc comment and members.\n");
    out
}

/// A .NET package's documentation of `name` (and, a type's, its members'), or its types.
fn dotnet(docs: &Path, name: &str) -> String {
    let all = nuget::members(&std::fs::read_to_string(docs).unwrap_or_default());
    if name.is_empty() {
        let types: Vec<String> = all
            .iter()
            .filter(|d| d.kind() == "type")
            .take(TOP_MAX)
            .map(|d| {
                let first = d.text.lines().next().unwrap_or("");
                format!("  {}  {}\n", d.shown(), parse::cut(first, 120))
            })
            .collect();
        return format!("Its types ({}):\n{}", types.len(), types.concat());
    }
    let found: Vec<&nuget::Doc> = all.iter().filter(|d| d.named(name)).take(12).collect();
    if found.is_empty() {
        return format!("Nothing named \"{name}\" is documented in it.\n");
    }
    let mut out = String::new();
    for d in &found {
        out.push_str(&format!("\n{} {}\n", d.kind(), d.shown()));
        out.extend(d.text.lines().map(|l| format!("  {l}\n")));
        if d.kind() == "type" {
            let prefix = format!("{}.", d.shown());
            let members: Vec<&str> = all
                .iter()
                .filter(|m| m.kind() != "type" && m.shown().starts_with(&prefix))
                .map(|m| m.shown())
                .take(MEMBERS_MAX)
                .collect();
            if !members.is_empty() {
                out.push_str(&format!("  members ({}):\n", members.len()));
                out.extend(members.iter().map(|m| format!("    {m}\n")));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project with packages installed the way each tool keeps them, and those tools' homes.
    fn installed() -> (PathBuf, Homes) {
        let dir = std::env::temp_dir().join(format!(
            "cbot-ctx-library-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let write = |p: &str, text: &str| {
            let path = dir.join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(
            "project/node_modules/left-pad/package.json",
            r#"{ "name": "left-pad", "version": "1.3.0", "types": "index.d.ts" }"#,
        );
        write(
            "project/node_modules/left-pad/index.d.ts",
            "/** Pads a string on the left. */\nexport declare function leftPad(s: string, n: number): string;\nexport interface Options {\n  width: number;\n  fill?: string;\n}\n",
        );
        write(
            "project/app/Cargo.lock",
            "version = 4\n\n[[package]]\nname = \"tiny-math\"\nversion = \"0.2.1\"\n",
        );
        write(
            "cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tiny-math-0.2.1/src/lib.rs",
            "/// Adds two numbers.\n#[inline]\npub fn add(a: u32, b: u32) -> u32 {\n    a + b\n}\n\npub struct Meter(pub f64);\n\nimpl Meter {\n    /// In feet.\n    pub fn feet(&self) -> f64 {\n        self.0 * 3.28\n    }\n}\n",
        );
        write(
            "project/.venv/Lib/site-packages/tinypkg/__init__.py",
            "def greet(name: str) -> str:\n    \"\"\"Say hello.\n\n    To someone.\n    \"\"\"\n    return name\n",
        );
        write(
            "project/.venv/Lib/site-packages/tinypkg-0.1.0.dist-info/METADATA",
            "",
        );
        let homes = Homes {
            cargo: dir.join("cargo"),
            go: dir.join("go"),
            nuget: dir.join("nuget"),
        };
        (dir, homes)
    }

    #[test]
    fn an_npm_packages_function_comes_with_its_doc_from_its_types() {
        let (dir, homes) = installed();
        let got = answer(&dir.join("project"), &homes, "left-pad", None, "leftPad");
        let top = answer(&dir.join("project"), &homes, "left-pad", None, "");
        let _ = std::fs::remove_dir_all(&dir);
        let got = got.unwrap();
        assert!(got.starts_with("left-pad 1.3.0 — npm package ("), "{got}");
        assert!(
            got.contains("  /** Pads a string on the left. */\n  export declare function leftPad(s: string, n: number): string;\n"),
            "{got}"
        );
        let top = top.unwrap();
        assert!(top.contains("index.d.ts:\n"), "{top}");
        assert!(top.contains("Options"), "{top}");
    }

    #[test]
    fn a_crate_is_read_at_the_version_its_lock_pins() {
        let (dir, homes) = installed();
        let add = answer(
            &dir.join("project"),
            &homes,
            "tiny_math",
            None,
            "tiny_math::add",
        );
        let meter = answer(&dir.join("project"), &homes, "tiny-math", None, "Meter");
        let _ = std::fs::remove_dir_all(&dir);
        let add = add.unwrap();
        assert!(add.starts_with("tiny-math 0.2.1 — Rust crate ("), "{add}");
        assert!(
            add.contains("\nfunction add — src/lib.rs:3-5\n  /// Adds two numbers.\n  #[inline]\n  pub fn add(a: u32, b: u32) -> u32\n"),
            "{add}"
        );
        let meter = meter.unwrap();
        assert!(
            meter.contains("\nstruct Meter — src/lib.rs:7-7\n"),
            "{meter}"
        );
        assert!(
            meter.contains("  members (1):\n    pub fn feet(&self) -> f64\n"),
            "{meter}"
        );
    }

    #[test]
    fn a_python_function_comes_with_its_docstring() {
        let (dir, homes) = installed();
        let got = answer(&dir.join("project"), &homes, "tinypkg", None, "greet");
        let _ = std::fs::remove_dir_all(&dir);
        let got = got.unwrap();
        assert!(got.starts_with("tinypkg 0.1.0 — Python package ("), "{got}");
        assert!(
            got.contains("  def greet(name: str) -> str:\n    \"\"\"Say hello.\n    \n    To someone.\n    \"\"\"\n"),
            "{got}"
        );
    }

    #[test]
    fn a_package_not_installed_says_so() {
        let (dir, homes) = installed();
        let got = answer(&dir.join("project"), &homes, "nope", None, "x");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(got.unwrap_err().to_string().contains("isn't installed"));
    }

    #[test]
    fn a_name_is_from_the_package_an_import_brings_it_in_from() {
        let mut code = Code::default();
        let ts = "import { useQuery } from '@tanstack/react-query/build';\nimport { mine } from './mine';\n";
        code.put(
            "src/a.ts",
            FileType::Code(Lang::TypeScript),
            parse::read(Lang::TypeScript, ts).unwrap(),
        );
        let py = "import numpy as np\n";
        code.put(
            "b.py",
            FileType::Code(Lang::Python),
            parse::read(Lang::Python, py).unwrap(),
        );
        assert_eq!(
            package_of(&code, "useQuery"),
            Some(("@tanstack/react-query".into(), Some(Lang::TypeScript)))
        );
        assert_eq!(
            package_of(&code, "np.array"),
            Some(("numpy".into(), Some(Lang::Python)))
        );
        assert_eq!(package_of(&code, "mine"), None);
        assert_eq!(
            package_of(&code, "serde_json::from_str"),
            Some(("serde_json".into(), Some(Lang::Rust)))
        );
    }

    #[test]
    fn lock_files_and_manifests_say_their_versions() {
        let lock = "[[package]]\nname = \"serde\"\nversion = \"1.0.210\"\nsource = \"registry\"\n\n[[package]]\nname = \"tiny\"\nversion = \"0.1.0\"\n";
        assert_eq!(
            installed::locked(lock),
            [
                ("serde".to_string(), "1.0.210".to_string()),
                ("tiny".to_string(), "0.1.0".to_string())
            ]
        );
        let go_mod = "module example.com/app\n\nrequire github.com/BurntSushi/toml v1.4.0\n\nrequire (\n\tgolang.org/x/tools v0.52.0 // indirect\n)\n";
        assert_eq!(
            installed::required(go_mod),
            [
                (
                    "github.com/BurntSushi/toml".to_string(),
                    "v1.4.0".to_string()
                ),
                ("golang.org/x/tools".to_string(), "v0.52.0".to_string())
            ]
        );
        let csproj = r#"<ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup>"#;
        assert_eq!(
            installed::references(csproj),
            [("Newtonsoft.Json".to_string(), "13.0.3".to_string())]
        );
    }
}
