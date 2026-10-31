//! What a file says about how it hangs together, kept with its definitions (parse.rs Facts):
//! what it imports, what it calls or makes and through what, what its types extend, and its
//! types' typed fields. Nothing here is resolved across files: the graph (build.rs) does that
//! when it's asked, from every file's facts at once, so the order files are read in never
//! matters and a file read again can't leave a stale edge behind.

use serde::{Deserialize, Serialize};

/// An import, as written.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::context) struct Import {
    /// The module: ./store, @/ipc, crate::store, os.path, .models, fmt, System.IO; `mod` for a
    /// Rust `mod x;`.
    pub spec: String,
    /// What it brings in, and under what name here.
    pub names: Vec<(String, String)>,
    /// Everything the module has: `*`, a re-export, a C# using.
    pub all: bool,
    /// The module itself under a name: `import * as ns`, `import os.path as p`, a Go package.
    pub alias: Option<String>,
    pub line: u32,
}

/// What a reference does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(in crate::context) enum RefKind {
    Call,
    New,
}

/// What a call goes through, as far as the syntax can tell.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "via", content = "of")]
pub(in crate::context) enum Via {
    /// `load()`: a name in scope.
    Bare,
    /// `this.load()`, `self.load()`: the type it's written in.
    This,
    /// `super.load()`, `super()` (a call of `constructor`): the type it's written in's supertypes.
    Super,
    /// `this.store.load()`: a field of the type it's written in; `this.yard.stacks` a field of
    /// that field's type (`yard#stacks`).
    Field(String),
    /// `store.load()` where `store` is known to be a Store (a parameter, a local); `t.log.write()`
    /// where `t` is a Terminal, a field of it (`Terminal#log`).
    Typed(String),
    /// `Store.load()`, `utils.format()`, `fmt.Println()`: a type, a module, a package.
    Name(String),
    /// Anything else: `a().b()`, `x[0].b()`.
    Unknown,
}

/// A call or a construction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::context) struct Ref {
    pub kind: RefKind,
    pub name: String,
    pub via: Via,
    pub line: u32,
    /// The definition it's in (an index into the file's definitions), if any.
    pub within: Option<u32>,
    /// How many arguments it's given, where that picks between overloads (TypeScript).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<u32>,
}

/// How one type stands to another.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(in crate::context) enum Heir {
    Extends,
    Implements,
}

/// A type extending or implementing another, by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::context) struct Heritage {
    pub kind: Heir,
    pub sub: String,
    pub sup: String,
    pub line: u32,
}

/// A typed field of a type: `store: Store`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::context) struct Member {
    pub holder: String,
    pub name: String,
    pub ty: String,
}

/// A method declared outside its type (Go's `func (s *S) Go()`): the line it starts on, and
/// its receiver's type.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::context) struct Receiver {
    pub line: u32,
    pub ty: String,
}

/// Everything above, for one file.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::context) struct Links {
    #[serde(default)]
    pub imports: Vec<Import>,
    #[serde(default)]
    pub refs: Vec<Ref>,
    #[serde(default)]
    pub heritage: Vec<Heritage>,
    #[serde(default)]
    pub members: Vec<Member>,
    #[serde(default)]
    pub receivers: Vec<Receiver>,
    /// The file's own names exported under another: ("default", "Store") for `export default
    /// Store`, ("load", "open") for `export { open as load }`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exports: Vec<(String, String)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reference_is_kept_by_these_names() {
        let r = Ref {
            kind: RefKind::Call,
            name: "open".into(),
            via: Via::Field("store".into()),
            line: 3,
            within: Some(1),
            args: None,
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            serde_json::json!({ "kind": "call", "name": "open", "via": { "via": "field", "of": "store" }, "line": 3, "within": 1 })
        );
        assert_eq!(
            serde_json::to_value(Via::Bare).unwrap(),
            serde_json::json!({ "via": "bare" })
        );
        assert_eq!(
            serde_json::to_value(Heir::Implements).unwrap(),
            "implements"
        );
    }
}
