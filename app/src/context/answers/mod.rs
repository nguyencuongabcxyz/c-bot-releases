//! What the code tools answer, as text for Claude: a file's or a folder's outline, where a
//! name is used when there's nothing to follow calls to (each file read again for the lines,
//! so they're as the file is now), and code found; and what the graph's tools answer
//! (relations.rs).

mod relations;

pub(super) use relations::*;

use super::*;

/// About how long an answer may get (characters): past it, it says what it left out.
const ANSWER_MAX: usize = 24_000;
const FIND_MAX: usize = 30;
const BODY_MAX_LINES: usize = 150;
const BODIES: usize = 3;
const USES_MAX: usize = 120;
const SNIPPET_LINES: usize = 12;

// ---------------------------------------------------------------- code_outline

/// A file's definitions, or the top level of each file in a folder ('' for all of it).
pub(super) fn outline(ix: &Code, rel: &str) -> Result<String, String> {
    if let Some((rel, f)) = ix.file(rel) {
        if f.defs.is_empty() {
            return Ok(format!(
                "{rel} defines nothing (no functions, types or constants)."
            ));
        }
        let mut out = format!("{rel} ({}):\n", f.lang.name());
        for d in &f.defs {
            out.push_str(&map::line_of(d));
            out.push('\n');
        }
        return Ok(out);
    }
    let files: Vec<(&String, &File)> = ix
        .files
        .iter()
        .filter(|(r, _)| search::under_path(r, rel))
        .map(|(r, f)| (r, &**f))
        .collect();
    if files.is_empty() {
        return Err(format!(
            "There's no code file or folder \"{rel}\" here (the context engine reads TypeScript/JavaScript, C#, Java, C/C++, Go, Python and Rust)."
        ));
    }
    let mut out = String::new();
    for (i, (r, f)) in files.iter().enumerate() {
        let mut part = format!("{r}\n");
        for d in f.defs.iter().filter(|d| d.depth <= 1) {
            part.push_str(&map::line_of(d));
            part.push('\n');
        }
        if out.len() + part.len() > ANSWER_MAX {
            out.push_str(&format!(
                "… and {} more files: ask for a smaller folder, or one file.\n",
                files.len() - i
            ));
            break;
        }
        out.push_str(&part);
    }
    Ok(out)
}

/// "Store.open", "Store::open" or "open": what holds it (if said) and its name.
fn split_query(q: &str) -> (Option<&str>, &str) {
    let q = q.trim().trim_end_matches("()");
    for sep in ["::", "."] {
        if let Some((h, n)) = q.rsplit_once(sep)
            && !h.is_empty()
            && !n.is_empty()
        {
            let h = h.rsplit(sep).next().unwrap_or(h);
            return (Some(h), n);
        }
    }
    (None, q)
}

/// A definition's code (lines `line` to `end` of a file), with its line numbers.
fn body_of(root: &Path, rel: &str, line: u32, end: u32) -> String {
    let Ok(text) = std::fs::read_to_string(root.join(rel)) else {
        return "  (couldn't read the file)\n".into();
    };
    let lines: Vec<&str> = text.lines().collect();
    let from = (line as usize).saturating_sub(1);
    let to = (end as usize).min(lines.len()).min(from + BODY_MAX_LINES);
    let mut out = String::from("```\n");
    for (i, line) in lines.iter().enumerate().take(to).skip(from) {
        out.push_str(&format!("{:>6}│ {line}\n", i + 1));
    }
    if (end as usize) > to {
        out.push_str(&format!("       … (to line {end}: Read the rest)\n"));
    }
    out.push_str("```\n");
    out
}

// ---------------------------------------------------------------- names alone

/// The files that use a name (to read again), under `under`.
fn users(ix: &Code, name: &str, under: &str) -> Vec<(String, Lang)> {
    let Some(id) = ix.names.get(name) else {
        return vec![];
    };
    ix.files
        .iter()
        .filter(|(r, f)| search::under_path(r, under) && f.uses(id) > 0)
        .map(|(r, f)| (r.clone(), f.lang))
        .collect()
}

/// Where a name is used, by name alone (when nothing of that name is defined here to follow
/// calls to): each file read again, each line with what it's in.
fn name_uses(ix: &Code, root: &Path, name: &str, under: &str) -> String {
    let (_, name) = split_query(name);
    let defined: Vec<String> = ix
        .files
        .iter()
        .flat_map(|(r, f)| {
            f.defs
                .iter()
                .filter(|d| d.name == name)
                .map(move |d| format!("{r}:{}", d.line))
        })
        .collect();
    let users = users(ix, name, under);
    if users.is_empty() {
        return format!("Nothing here uses \"{name}\" (names are matched exactly, case included).");
    }
    let mut out = String::new();
    if !defined.is_empty() {
        out.push_str(&format!("{name} is defined at {}\n\n", defined.join(", ")));
    }
    let (mut shown, mut total, mut files) = (0, 0, 0);
    for (rel, lang) in &users {
        let Some(text) = ingest::read_code(&root.join(rel)) else {
            continue;
        };
        let Some(facts) = parse::read_for(*lang, &text, Some(name)) else {
            continue;
        };
        if facts.uses.is_empty() {
            continue;
        }
        files += 1;
        total += facts.uses.len();
        if shown >= USES_MAX {
            continue;
        }
        let lines: Vec<&str> = text.lines().collect();
        out.push_str(&format!("{rel}\n"));
        for &l in facts.uses.iter().take(USES_MAX - shown) {
            let code = lines.get(l as usize - 1).map_or("", |s| s.trim());
            let within = inside(&facts.defs, l)
                .map(|h| format!("   (in {h})"))
                .unwrap_or_default();
            out.push_str(&format!("{l:>6}│ {}{within}\n", parse::cut(code, 160)));
            shown += 1;
        }
    }
    out.push_str(&format!("\n{total} uses in {files} files"));
    if total > shown {
        out.push_str(&format!(" ({shown} shown: give a path to narrow it)"));
    }
    out.push('\n');
    out
}

/// The innermost definition holding a line, as Holder.name.
fn inside(defs: &[Def], line: u32) -> Option<String> {
    defs.iter()
        .filter(|d| d.line <= line && line <= d.end && d.kind != Kind::Module)
        .max_by_key(|d| d.depth)
        .map(|d| match &d.container {
            Some(c) => format!("{c}.{}", d.name),
            None => d.name.clone(),
        })
}

// ---------------------------------------------------------------- search_code

/// Code found: each chunk with where it is, what it's in, which lanes found it, and its lines
/// that hold the words (its first lines, when it was found by name or meaning alone).
/// `chunks`: the results' chunks, from the store.
pub(super) fn search_code(
    query: &str,
    found: &[Ranked],
    chunks: &HashMap<(String, i32), StoredChunk>,
) -> String {
    let words = search::query_words(query);
    let mut out = String::new();
    for r in found {
        let Some(c) = chunks.get(&(r.path.clone(), r.idx)) else {
            continue; // (gone since it was found)
        };
        let within = if c.symbol.is_empty() {
            String::new()
        } else {
            format!("   ({})", c.symbol)
        };
        let lanes = r.lanes.join("+");
        out.push_str(&format!(
            "{}:{}-{}{within}   [{lanes}]\n",
            r.path, c.line_from, c.line_to
        ));
        let from = u32::try_from(c.line_from).unwrap_or(1);
        out.push_str(&snippet(&c.text, from, &words));
        out.push('\n');
    }
    if out.is_empty() {
        return format!(
            "Nothing here matches \"{query}\". Try other words, or the names you'd expect."
        );
    }
    out
}

/// The lines of a chunk (its first being line `from`) that hold the words, with a line round
/// each, numbered; its first lines when none does.
fn snippet(text: &str, from: u32, words: &[String]) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut keep: BTreeSet<usize> = BTreeSet::new();
    for (i, line) in lines.iter().enumerate() {
        let mut hit = false;
        search::words(line, |w| hit |= words.contains(&w));
        if hit {
            keep.extend(i.saturating_sub(1)..=(i + 1).min(lines.len() - 1));
        }
    }
    if keep.is_empty() {
        keep.extend(0..lines.len().min(SNIPPET_LINES));
    }
    let mut out = String::new();
    let mut last = None;
    for &i in keep.iter().take(SNIPPET_LINES) {
        if last.is_some_and(|l: usize| i > l + 1) {
            out.push_str("      ┆\n");
        }
        out.push_str(&format!(
            "{:>6}│ {}\n",
            from as usize + i,
            parse::cut(lines[i], 200)
        ));
        last = Some(i);
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of code, read as the engine does.
    fn project() -> (PathBuf, Code) {
        let dir = std::env::temp_dir().join(format!(
            "cbot-ctx-answers-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let write = |p: &str, text: &str| {
            let path = dir.join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(
            "src/store.ts",
            "export class OrderStore {\n  open(id: string): Order {\n    return load(id);\n  }\n}\n",
        );
        write(
            "src/api.ts",
            "import { OrderStore } from './store';\nexport function getOrder(id: string) {\n  const s = new OrderStore();\n  return s.open(id);\n}\n",
        );
        write(
            "svc/Orders.cs",
            "public class Orders {\n  // refresh the token before it expires\n  public void RefreshToken() { }\n}\n",
        );
        let (found, _) = ingest::find(&dir);
        let mut ix = Code::default();
        for r in ingest::read_all(&dir, found, &HashMap::new(), &|_| {}) {
            if let ingest::Read::Written(w) = r {
                ix.put(&w.found.rel, w.found.ty, w.facts);
            }
        }
        (dir, ix)
    }

    #[test]
    fn the_tools_answer_from_a_real_folder() {
        let (dir, ix) = project();
        let one = outline(&ix, "src/store.ts").unwrap();
        assert_eq!(
            one,
            "src/store.ts (TypeScript/JavaScript):\n     1│ export class OrderStore\n     2│   open(id: string): Order\n"
        );
        assert!(outline_of_folder_lists_each_file(&ix));
        assert!(outline(&ix, "nowhere").is_err());

        let g = Graph::build(&ix, &dir);
        let found = find(&g, &dir, "OrderStore.open", "", true);
        assert!(found.starts_with("method src.store.OrderStore.open — src/store.ts:2-4   (1 callers)\n  open(id: string): Order\n```\n     2│   open(id: string): Order {\n"), "{found}");
        assert!(
            find(&g, &dir, "orderstore", "class", false)
                .starts_with("class src.store.OrderStore — src/store.ts:1-5")
        );

        // (found through the graph: the call, where it is, what it's in)
        let uses = references(&g, &ix, &dir, "OrderStore.open", "", 1);
        assert!(uses.starts_with("method src.store.OrderStore.open — src/store.ts:2-4\n  1 callers:\n  src/api.ts:4  in src.api.getOrder\n    return s.open(id);\n"), "{uses}");
        // (by name alone, when nothing of that name is defined here)
        let uses = name_uses(&ix, &dir, "OrderStore", "");
        assert!(uses.starts_with("OrderStore is defined at src/store.ts:1\n\nsrc/api.ts\n"));
        assert!(uses.contains("     3│ const s = new OrderStore();   (in getOrder)\n"));
        assert!(uses.ends_with("\n2 uses in 1 files\n"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_search_shows_where_each_hit_is_and_its_lines_with_the_words() {
        let hit = Ranked {
            path: "svc/Orders.cs".into(),
            idx: 0,
            lanes: vec!["bm25", "vector"],
        };
        let chunk = StoredChunk {
            path: hit.path.clone(),
            idx: 0,
            code: true,
            line_from: 10,
            line_to: 14,
            symbol: "Orders".into(),
            text: "public class Orders {\n  int n;\n  // refresh the token before it expires\n  public void RefreshToken() { }\n}".into(),
        };
        let chunks: HashMap<(String, i32), StoredChunk> =
            [((hit.path.clone(), 0), chunk)].into_iter().collect();
        let got = search_code("refresh expired token", std::slice::from_ref(&hit), &chunks);
        assert_eq!(
            got,
            "svc/Orders.cs:10-14   (Orders)   [bm25+vector]\n    11│   int n;\n    12│   // refresh the token before it expires\n    13│   public void RefreshToken() { }\n    14│ }\n\n"
        );
        // (found by meaning alone: its first lines)
        let got = search_code("renew credentials", &[hit], &chunks);
        assert!(got.contains("    10│ public class Orders {\n    11│   int n;\n"));
        assert!(search_code("x", &[], &chunks).starts_with("Nothing here matches"));
    }

    fn outline_of_folder_lists_each_file(ix: &Code) -> bool {
        let all = outline(ix, "").unwrap();
        all.starts_with("src/api.ts\n     2│ export function getOrder(id: string)\nsrc/store.ts\n")
            && all.contains("svc/Orders.cs\n")
    }

    #[test]
    fn a_symbol_is_asked_for_with_or_without_what_holds_it() {
        assert_eq!(split_query("open"), (None, "open"));
        assert_eq!(split_query("Store::open"), (Some("Store"), "open"));
        assert_eq!(
            split_query("crate::store::Store::open()"),
            (Some("Store"), "open")
        );
        assert_eq!(split_query("Store.open"), (Some("Store"), "open"));
        assert_eq!(split_query("."), (None, "."));
    }

    #[test]
    fn a_line_is_inside_its_innermost_definition() {
        let def = |name: &str, container: Option<&str>, line, end, depth| Def {
            name: name.into(),
            kind: Kind::Function,
            container: container.map(str::to_string),
            line,
            end,
            depth,
            sig: String::new(),
        };
        let defs = [
            def("Store", None, 1, 20, 0),
            def("open", Some("Store"), 5, 9, 1),
        ];
        assert_eq!(inside(&defs, 6).as_deref(), Some("Store.open"));
        assert_eq!(inside(&defs, 12).as_deref(), Some("Store"));
        assert_eq!(inside(&defs, 30), None);
    }
}
