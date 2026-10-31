//! Walking the graph to answer: the symbols a name means, best first; who calls a symbol (and
//! who calls them, to a depth); the shortest chain of calls from one symbol to another; what
//! a file imports and who imports it, to a depth; a type's supertypes and subtypes; and the
//! methods that override one, or that it overrides. Every walk is breadth first, so each
//! symbol or file shows at its shortest distance.

use super::*;

/// A symbol reached by a walk: at what distance, and through which (the one it calls, or
/// imports, a step nearer).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::context) struct Reached {
    pub sym: usize,
    pub depth: usize,
    pub via: usize,
    pub lines: Vec<u32>,
}

impl Graph {
    /// The symbols a query names, best first: its full name exactly, a full name it ends,
    /// its name, the name in another case, a name it starts, then any full name holding it
    /// (`Store.open`, `Store::open` and `open` all find Store's open). Among equals: types,
    /// then what can be called, then the shorter full name.
    pub(in crate::context) fn resolve_name(&self, query: &str, kind: &str) -> Vec<usize> {
        let q = query.trim().trim_end_matches("()").replace("::", ".");
        let lower = q.to_lowercase();
        let suffix = format!(".{q}");
        let tier = |s: &Sym| -> Option<u8> {
            let name = s.name.to_lowercase();
            if s.fqn == q {
                Some(0)
            } else if s.fqn.ends_with(&suffix) {
                Some(1)
            } else if s.name == q {
                Some(2)
            } else if name == lower {
                Some(3)
            } else if name.starts_with(&lower) {
                Some(4)
            } else if s.fqn.to_lowercase().contains(&lower) {
                Some(5)
            } else {
                None
            }
        };
        let mut found: Vec<(u8, u8, usize, usize)> = self
            .syms
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind.fits(kind) && (s.kind != Kind::Impl || kind == "impl"))
            .filter_map(|(i, s)| {
                let t = tier(s)?;
                let sort = if self.is_type(i) {
                    0
                } else if s.kind.fits("function") {
                    1
                } else {
                    2
                };
                Some((t, sort, s.fqn.len(), i))
            })
            .collect();
        found.sort_unstable();
        // (past the best tier, what's left is noise)
        let best = found.first().map(|f| f.0);
        found
            .into_iter()
            .filter(|f| Some(f.0) == best || f.0 <= 1)
            .map(|f| f.3)
            .collect()
    }

    /// Who calls `sym`, and who calls them, up to `depth` calls away (each once, nearest
    /// first). A call to a method it overrides counts too, since through the supertype it may
    /// land here: its `via` is that method (`dispatched_through`). A caller `skip` turns down
    /// (by its file's path) isn't followed.
    pub(in crate::context) fn callers(
        &self,
        sym: usize,
        depth: usize,
        skip: &dyn Fn(&str) -> bool,
    ) -> Vec<Reached> {
        let mut from = vec![sym];
        from.extend(self.dispatched_through(sym));
        self.walk(&from, depth, |s| &self.calls_in[s], skip)
    }

    /// What `sym` calls, and what they call, up to `depth`.
    pub(in crate::context) fn callees(&self, sym: usize, depth: usize) -> Vec<Reached> {
        self.walk(&[sym], depth, |s| &self.calls_out[s], &|_| false)
    }

    /// The methods a call may reach a method through: those it overrides, and theirs, all the
    /// way up (`shape.area()` may run `Square.area`).
    pub(in crate::context) fn dispatched_through(&self, method: usize) -> Vec<usize> {
        let mut out: Vec<usize> = vec![];
        let mut queue = VecDeque::from([method]);
        while let Some(m) = queue.pop_front() {
            if !self.overriding(m) {
                continue;
            }
            for up in self.overridden(m) {
                if up != method && !out.contains(&up) {
                    out.push(up);
                    queue.push_back(up);
                }
            }
        }
        out
    }

    /// A breadth-first walk from `from` (each at distance 0, the first nearest).
    fn walk<'a>(
        &'a self,
        from: &[usize],
        depth: usize,
        next: impl Fn(usize) -> &'a [Edge],
        skip: &dyn Fn(&str) -> bool,
    ) -> Vec<Reached> {
        let mut seen: HashSet<usize> = from.iter().copied().collect();
        let mut out = vec![];
        let mut queue: VecDeque<(usize, usize)> = from.iter().map(|&s| (s, 0)).collect();
        while let Some((s, d)) = queue.pop_front() {
            if d >= depth {
                continue;
            }
            for e in next(s) {
                if skip(self.path(e.to)) || !seen.insert(e.to) {
                    continue;
                }
                out.push(Reached {
                    sym: e.to,
                    depth: d + 1,
                    via: s,
                    lines: e.lines.clone(),
                });
                queue.push_back((e.to, d + 1));
            }
        }
        out
    }

    /// The shortest chain of calls from one symbol to another (both included), within `depth`
    /// calls.
    pub(in crate::context) fn chain(
        &self,
        from: usize,
        to: usize,
        depth: usize,
    ) -> Option<Vec<usize>> {
        let reached = self.callees(from, depth);
        if from == to {
            return Some(vec![from]);
        }
        let back: HashMap<usize, usize> = reached.iter().map(|r| (r.sym, r.via)).collect();
        back.get(&to)?;
        let mut path = vec![to];
        let mut at = to;
        while let Some(&prev) = back.get(&at) {
            path.push(prev);
            if prev == from {
                break;
            }
            at = prev;
        }
        path.reverse();
        Some(path)
    }

    /// The files a file imports (`forward`) or that import it, and theirs, up to `depth`, with
    /// their distances.
    pub(in crate::context) fn file_closure(
        &self,
        file: usize,
        forward: bool,
        depth: usize,
    ) -> Vec<(usize, usize)> {
        let mut seen = HashSet::from([file]);
        let mut out = vec![];
        let mut queue = VecDeque::from([(file, 0usize)]);
        while let Some((f, d)) = queue.pop_front() {
            if d >= depth {
                continue;
            }
            let next = if forward {
                &self.imports[f]
            } else {
                &self.imported_by[f]
            };
            for &n in next {
                if seen.insert(n) {
                    out.push((n, d + 1));
                    queue.push_back((n, d + 1));
                }
            }
        }
        out
    }

    /// A type's supertypes (`up`) or subtypes, all the way, with their distances.
    pub(in crate::context) fn lineage(&self, ty: usize, up: bool) -> Vec<(usize, usize, Heir)> {
        let mut seen = HashSet::from([ty]);
        let mut out = vec![];
        let mut queue = VecDeque::from([(ty, 0usize)]);
        while let Some((t, d)) = queue.pop_front() {
            let next = if up { &self.supers[t] } else { &self.subs[t] };
            for &(n, kind) in next {
                if seen.insert(n) {
                    out.push((n, d + 1, kind));
                    queue.push_back((n, d + 1));
                }
            }
        }
        out
    }

    /// The methods that override a method (in its type's subtypes), and those it overrides (an
    /// interface's or trait's it implements too): each time the nearest of the same name up a
    /// line of supertypes, so a method two classes down overrides the one between.
    pub(in crate::context) fn overrides(&self, method: usize) -> (Vec<usize>, Vec<usize>) {
        let (Some(owner), true) = (self.owner_of(method), self.overriding(method)) else {
            return (vec![], vec![]);
        };
        let name = &self.syms[method].name;
        let below = self
            .lineage(owner, false)
            .into_iter()
            .flat_map(|(t, _, _)| self.members_of(t).to_vec())
            .filter(|&m| self.syms[m].name == *name && self.overridden(m).contains(&method))
            .collect();
        (below, self.overridden(method))
    }

    /// A method that can override one: not a constructor, not a property.
    fn overriding(&self, m: usize) -> bool {
        let s = &self.syms[m];
        s.kind == Kind::Method && !matches!(s.name.as_str(), "constructor" | "__init__")
    }

    /// The nearest methods of a method's name up each line of its type's supertypes.
    fn overridden(&self, method: usize) -> Vec<usize> {
        let Some(owner) = self.owner_of(method) else {
            return vec![];
        };
        let name = &self.syms[method].name;
        let mut out = vec![];
        let mut seen = HashSet::from([owner]);
        let mut queue: VecDeque<usize> = self.supers[owner].iter().map(|(s, _)| *s).collect();
        while let Some(t) = queue.pop_front() {
            if !seen.insert(t) {
                continue;
            }
            let found = self
                .members_of(t)
                .iter()
                .copied()
                .find(|&m| self.syms[m].name == *name && self.overriding(m));
            match found {
                Some(m) => out.push(m),
                None => queue.extend(self.supers[t].iter().map(|(s, _)| *s)),
            }
        }
        out
    }
}
