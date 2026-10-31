//! The files the context engine reads: code in the languages it knows (their tree-sitter
//! grammar, which of their syntax nodes define something, and what, or name something); the
//! files that set code up or lay out its pages (XML and XAML, Razor views, YAML, Dockerfiles,
//! JSON, TOML, SQL, HTML with Vue and Svelte, CSS), cut along their structure and searched with
//! the code; and documents, read for search only. Kotlin, Swift, PHP, Ruby, shell and
//! PowerShell are read for what they define and the names they use, not yet for their links.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Lang {
    TypeScript,
    Tsx, // (and JavaScript: the TSX grammar reads it too)
    #[serde(rename = "csharp")]
    CSharp,
    Go,
    Python,
    Rust,
    Java,
    Cpp, // (and C: the C++ grammar reads it too)
    // (what they define, and their names: no links to the rest yet, graph/ leaves them be)
    Kotlin,
    Swift,
    Php,
    Ruby,
    Bash,
    #[serde(rename = "powershell")]
    PowerShell,
}

/// A file that sets code up rather than runs: searched with the code, no definitions of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Config {
    Xml,   // (XAML, project files, .config too)
    Razor, // (ASP.NET's views: .cshtml, .razor)
    Yaml,
    Docker, // (Dockerfile, Containerfile)
    Json,
    Toml,
    Sql,
    Html, // (Vue's and Svelte's components too)
    Css,  // (SCSS, Less)
}

/// What a file is to the engine: code in a language, a config file, or a document.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum FileType {
    Code(Lang),
    Config(Config),
    Markdown,
    Text,
}

/// What a definition is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Kind {
    Module,
    Class,
    Struct,
    Interface,
    Trait,
    Enum,
    Type,
    Impl, // (a Rust impl block: named after its type, it holds the methods)
    Function,
    Method,
    Constructor,
    Property,
    Const,
    Macro,
}

impl Lang {
    /// The language of a file, by its extension.
    pub(super) fn of(path: &str) -> Option<Lang> {
        let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
        Some(match ext.as_str() {
            "ts" | "mts" | "cts" => Lang::TypeScript,
            "tsx" | "js" | "jsx" | "mjs" | "cjs" => Lang::Tsx,
            "cs" => Lang::CSharp,
            "go" => Lang::Go,
            "py" | "pyi" => Lang::Python,
            "rs" => Lang::Rust,
            "java" => Lang::Java,
            "cpp" | "cc" | "cxx" | "c++" | "hpp" | "hh" | "hxx" | "h++" | "ipp" | "inl" | "tpp"
            | "c" | "h" => Lang::Cpp,
            "kt" | "kts" => Lang::Kotlin,
            "swift" => Lang::Swift,
            "php" | "phtml" => Lang::Php,
            "rb" | "rake" | "gemspec" => Lang::Ruby,
            "sh" | "bash" | "zsh" => Lang::Bash,
            "ps1" | "psm1" | "psd1" => Lang::PowerShell,
            _ => return None,
        })
    }

    pub(super) fn grammar(self) -> tree_sitter::Language {
        match self {
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
            Lang::Go => tree_sitter_go::LANGUAGE.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::Java => tree_sitter_java::LANGUAGE.into(),
            Lang::Cpp => tree_sitter_cpp::LANGUAGE.into(),
            Lang::Kotlin => tree_sitter_kotlin_ng::LANGUAGE.into(),
            Lang::Swift => tree_sitter_swift::LANGUAGE.into(),
            Lang::Php => tree_sitter_php::LANGUAGE_PHP.into(), // (with the HTML around it)
            Lang::Ruby => tree_sitter_ruby::LANGUAGE.into(),
            Lang::Bash => tree_sitter_bash::LANGUAGE.into(),
            Lang::PowerShell => tree_sitter_powershell::LANGUAGE.into(),
        }
    }

    pub(super) fn name(self) -> &'static str {
        match self {
            Lang::TypeScript | Lang::Tsx => "TypeScript/JavaScript",
            Lang::CSharp => "C#",
            Lang::Go => "Go",
            Lang::Python => "Python",
            Lang::Rust => "Rust",
            Lang::Java => "Java",
            Lang::Cpp => "C/C++",
            Lang::Kotlin => "Kotlin",
            Lang::Swift => "Swift",
            Lang::Php => "PHP",
            Lang::Ruby => "Ruby",
            Lang::Bash => "Shell",
            Lang::PowerShell => "PowerShell",
        }
    }

    /// What a node of this kind defines, when it's a definition. Some need a closer look
    /// (parse.rs: a TypeScript variable holding a function, a Go type, top-level constants).
    pub(super) fn def(self, node: &str) -> Option<Kind> {
        match self {
            Lang::TypeScript | Lang::Tsx => ts_def(node),
            Lang::CSharp => cs_def(node),
            Lang::Go => go_def(node),
            Lang::Python => match node {
                "class_definition" => Some(Kind::Class),
                "function_definition" => Some(Kind::Function),
                "assignment" => Some(Kind::Const),
                _ => None,
            },
            Lang::Rust => rust_def(node),
            Lang::Java => java_def(node),
            Lang::Cpp => cpp_def(node),
            Lang::Kotlin => kotlin_def(node),
            Lang::Swift => swift_def(node),
            Lang::Php => php_def(node),
            Lang::Ruby => ruby_def(node),
            Lang::Bash => match node {
                "function_definition" => Some(Kind::Function),
                "variable_assignment" => Some(Kind::Const),
                _ => None,
            },
            Lang::PowerShell => powershell_def(node),
        }
    }

    /// A node that names something (where a symbol can be used).
    pub(super) fn is_name(self, node: &str) -> bool {
        match self {
            Lang::TypeScript | Lang::Tsx => matches!(
                node,
                "identifier"
                    | "type_identifier"
                    | "property_identifier"
                    | "shorthand_property_identifier"
            ),
            Lang::CSharp | Lang::Python => node == "identifier",
            Lang::Java => matches!(node, "identifier" | "type_identifier"),
            Lang::Go | Lang::Rust => {
                matches!(node, "identifier" | "type_identifier" | "field_identifier")
            }
            Lang::Cpp => matches!(
                node,
                "identifier" | "type_identifier" | "field_identifier" | "namespace_identifier"
            ),
            Lang::Kotlin => node == "identifier",
            Lang::Swift => matches!(node, "simple_identifier" | "type_identifier"),
            Lang::Php => node == "name",
            Lang::Ruby => matches!(node, "identifier" | "constant"),
            Lang::Bash => matches!(node, "word" | "variable_name"), // (a command is a word)
            Lang::PowerShell => matches!(node, "simple_name" | "command_name"),
        }
    }
}

impl FileType {
    /// A file's type by its name or extension (None: not one the engine reads).
    pub(super) fn of(path: &str) -> Option<FileType> {
        if let Some(lang) = Lang::of(path) {
            return Some(FileType::Code(lang));
        }
        let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
        // (Dockerfile, Dockerfile.dev, api.dockerfile; Containerfile alike)
        let docker = ["dockerfile", "containerfile"].iter().any(|d| {
            name == *d || name.starts_with(&format!("{d}.")) || name.ends_with(&format!(".{d}"))
        });
        if docker {
            return Some(FileType::Config(Config::Docker));
        }
        let ext = name.rsplit_once('.')?.1;
        match ext {
            "xml" | "xaml" | "axaml" | "csproj" | "vbproj" | "fsproj" | "vcxproj" | "props"
            | "targets" | "config" | "xsd" | "wxs" => Some(FileType::Config(Config::Xml)),
            "cshtml" | "razor" => Some(FileType::Config(Config::Razor)),
            "yaml" | "yml" => Some(FileType::Config(Config::Yaml)),
            "json" | "jsonc" | "json5" => Some(FileType::Config(Config::Json)),
            "toml" => Some(FileType::Config(Config::Toml)),
            "sql" => Some(FileType::Config(Config::Sql)),
            "html" | "htm" | "vue" | "svelte" => Some(FileType::Config(Config::Html)),
            "css" | "scss" | "less" => Some(FileType::Config(Config::Css)),
            "md" | "mdx" | "markdown" => Some(FileType::Markdown),
            "txt" | "rst" | "adoc" => Some(FileType::Text),
            _ => None,
        }
    }

    /// As the store keeps it.
    pub(super) fn id(self) -> &'static str {
        match self {
            FileType::Code(Lang::TypeScript) => "typescript",
            FileType::Code(Lang::Tsx) => "tsx",
            FileType::Code(Lang::CSharp) => "csharp",
            FileType::Code(Lang::Go) => "go",
            FileType::Code(Lang::Python) => "python",
            FileType::Code(Lang::Rust) => "rust",
            FileType::Code(Lang::Java) => "java",
            FileType::Code(Lang::Cpp) => "cpp",
            FileType::Code(Lang::Kotlin) => "kotlin",
            FileType::Code(Lang::Swift) => "swift",
            FileType::Code(Lang::Php) => "php",
            FileType::Code(Lang::Ruby) => "ruby",
            FileType::Code(Lang::Bash) => "bash",
            FileType::Code(Lang::PowerShell) => "powershell",
            FileType::Config(Config::Xml) => "xml",
            FileType::Config(Config::Razor) => "razor",
            FileType::Config(Config::Yaml) => "yaml",
            FileType::Config(Config::Docker) => "dockerfile",
            FileType::Config(Config::Json) => "json",
            FileType::Config(Config::Toml) => "toml",
            FileType::Config(Config::Sql) => "sql",
            FileType::Config(Config::Html) => "html",
            FileType::Config(Config::Css) => "css",
            FileType::Markdown => "markdown",
            FileType::Text => "text",
        }
    }

    pub(super) fn from_id(id: &str) -> Option<FileType> {
        ALL.into_iter().find(|t| t.id() == id)
    }

    /// As the chat names it.
    pub(super) fn name(self) -> &'static str {
        match self {
            FileType::Code(lang) => lang.name(),
            FileType::Config(Config::Xml) => "XML/XAML",
            FileType::Config(Config::Razor) => "Razor",
            FileType::Config(Config::Yaml) => "YAML",
            FileType::Config(Config::Docker) => "Dockerfile",
            FileType::Config(Config::Json) => "JSON",
            FileType::Config(Config::Toml) => "TOML",
            FileType::Config(Config::Sql) => "SQL",
            FileType::Config(Config::Html) => "HTML/Vue/Svelte",
            FileType::Config(Config::Css) => "CSS",
            FileType::Markdown => "Markdown",
            FileType::Text => "Text",
        }
    }

    pub(super) fn lang(self) -> Option<Lang> {
        match self {
            FileType::Code(lang) => Some(lang),
            _ => None,
        }
    }

    /// Whether search counts it as code (`kind: "code"`) rather than a document.
    pub(super) fn is_code(self) -> bool {
        matches!(self, FileType::Code(_) | FileType::Config(_))
    }
}

const ALL: [FileType; 25] = [
    FileType::Code(Lang::TypeScript),
    FileType::Code(Lang::Tsx),
    FileType::Code(Lang::CSharp),
    FileType::Code(Lang::Go),
    FileType::Code(Lang::Python),
    FileType::Code(Lang::Rust),
    FileType::Code(Lang::Java),
    FileType::Code(Lang::Cpp),
    FileType::Code(Lang::Kotlin),
    FileType::Code(Lang::Swift),
    FileType::Code(Lang::Php),
    FileType::Code(Lang::Ruby),
    FileType::Code(Lang::Bash),
    FileType::Code(Lang::PowerShell),
    FileType::Config(Config::Xml),
    FileType::Config(Config::Razor),
    FileType::Config(Config::Yaml),
    FileType::Config(Config::Docker),
    FileType::Config(Config::Json),
    FileType::Config(Config::Toml),
    FileType::Config(Config::Sql),
    FileType::Config(Config::Html),
    FileType::Config(Config::Css),
    FileType::Markdown,
    FileType::Text,
];

fn ts_def(node: &str) -> Option<Kind> {
    Some(match node {
        "function_declaration" | "generator_function_declaration" | "function_signature" => {
            Kind::Function
        }
        "class_declaration" | "abstract_class_declaration" => Kind::Class,
        "interface_declaration" => Kind::Interface,
        "type_alias_declaration" => Kind::Type,
        "enum_declaration" => Kind::Enum,
        "method_definition" | "method_signature" | "abstract_method_signature" => Kind::Method,
        "public_field_definition" | "property_signature" => Kind::Property,
        "internal_module" | "module" => Kind::Module,
        "variable_declarator" => Kind::Const,
        _ => return None,
    })
}

fn cs_def(node: &str) -> Option<Kind> {
    Some(match node {
        "class_declaration" | "record_declaration" => Kind::Class,
        "struct_declaration" | "record_struct_declaration" => Kind::Struct,
        "interface_declaration" => Kind::Interface,
        "enum_declaration" => Kind::Enum,
        "delegate_declaration" => Kind::Type,
        "method_declaration" => Kind::Method,
        "local_function_statement" => Kind::Function,
        "constructor_declaration" => Kind::Constructor,
        "property_declaration" => Kind::Property,
        "namespace_declaration" | "file_scoped_namespace_declaration" => Kind::Module,
        _ => return None,
    })
}

fn go_def(node: &str) -> Option<Kind> {
    Some(match node {
        "function_declaration" => Kind::Function,
        "method_declaration" | "method_elem" | "method_spec" => Kind::Method,
        "type_spec" | "type_alias" => Kind::Type,
        "field_declaration" => Kind::Property,
        "const_spec" | "var_spec" => Kind::Const,
        _ => return None,
    })
}

fn rust_def(node: &str) -> Option<Kind> {
    Some(match node {
        "function_item" | "function_signature_item" => Kind::Function,
        "struct_item" | "union_item" => Kind::Struct,
        "enum_item" => Kind::Enum,
        "trait_item" => Kind::Trait,
        "type_item" => Kind::Type,
        "mod_item" => Kind::Module,
        "macro_definition" => Kind::Macro,
        "const_item" | "static_item" => Kind::Const,
        "impl_item" => Kind::Impl,
        _ => return None,
    })
}

fn java_def(node: &str) -> Option<Kind> {
    Some(match node {
        "class_declaration" | "record_declaration" => Kind::Class,
        "interface_declaration" | "annotation_type_declaration" => Kind::Interface,
        "enum_declaration" => Kind::Enum,
        "method_declaration" | "annotation_type_element_declaration" => Kind::Method,
        "constructor_declaration" | "compact_constructor_declaration" => Kind::Constructor,
        "field_declaration" => Kind::Property,
        "constant_declaration" => Kind::Const,
        "package_declaration" => Kind::Module,
        _ => return None,
    })
}

/// (A member function declared in a class is a field_declaration, and one defined outside it,
/// `void Store::open() {}`, a function_definition: parse.rs tells them apart.)
fn cpp_def(node: &str) -> Option<Kind> {
    Some(match node {
        "function_definition" => Kind::Function,
        "class_specifier" => Kind::Class,
        "struct_specifier" | "union_specifier" => Kind::Struct,
        "enum_specifier" => Kind::Enum,
        "namespace_definition" => Kind::Module,
        "type_definition" | "alias_declaration" => Kind::Type,
        "field_declaration" => Kind::Property,
        "declaration" => Kind::Method,
        "preproc_def" | "preproc_function_def" => Kind::Macro,
        _ => return None,
    })
}

/// (An interface or enum is a class_declaration too, and an object a class; a property at the
/// top of the file is a constant: parse.rs tells them apart.)
fn kotlin_def(node: &str) -> Option<Kind> {
    Some(match node {
        "class_declaration" | "object_declaration" => Kind::Class,
        "function_declaration" => Kind::Function,
        "secondary_constructor" => Kind::Constructor,
        "property_declaration" => Kind::Property,
        "type_alias" => Kind::Type,
        "package_header" => Kind::Module,
        _ => return None,
    })
}

/// (A struct, enum, actor or extension is a class_declaration too, told apart by its keyword
/// in parse.rs.)
fn swift_def(node: &str) -> Option<Kind> {
    Some(match node {
        "class_declaration" => Kind::Class,
        "protocol_declaration" => Kind::Interface,
        "function_declaration" => Kind::Function,
        "protocol_function_declaration" => Kind::Method,
        "init_declaration" => Kind::Constructor,
        "property_declaration" => Kind::Property,
        "typealias_declaration" => Kind::Type,
        _ => return None,
    })
}

fn php_def(node: &str) -> Option<Kind> {
    Some(match node {
        "class_declaration" => Kind::Class,
        "interface_declaration" => Kind::Interface,
        "trait_declaration" => Kind::Trait,
        "enum_declaration" => Kind::Enum,
        "function_definition" => Kind::Function,
        "method_declaration" => Kind::Method,
        "namespace_definition" => Kind::Module,
        "const_element" => Kind::Const,
        "property_element" => Kind::Property,
        _ => return None,
    })
}

fn ruby_def(node: &str) -> Option<Kind> {
    Some(match node {
        "class" => Kind::Class,
        "module" => Kind::Module,
        "method" => Kind::Function,
        "singleton_method" => Kind::Method,
        "assignment" => Kind::Const, // (to a Constant: parse.rs)
        _ => return None,
    })
}

fn powershell_def(node: &str) -> Option<Kind> {
    Some(match node {
        "function_statement" => Kind::Function,
        "class_statement" => Kind::Class,
        "enum_statement" => Kind::Enum,
        "class_method_definition" => Kind::Method,
        "class_property_definition" => Kind::Property,
        _ => return None,
    })
}

impl Kind {
    pub(super) fn word(self) -> &'static str {
        match self {
            Kind::Module => "module",
            Kind::Class => "class",
            Kind::Struct => "struct",
            Kind::Interface => "interface",
            Kind::Trait => "trait",
            Kind::Enum => "enum",
            Kind::Type => "type",
            Kind::Impl => "impl",
            Kind::Function => "function",
            Kind::Method => "method",
            Kind::Constructor => "constructor",
            Kind::Property => "property",
            Kind::Const => "const",
            Kind::Macro => "macro",
        }
    }

    /// A type of some sort: what methods belong to.
    pub(super) fn holds_methods(self) -> bool {
        matches!(
            self,
            Kind::Class | Kind::Struct | Kind::Interface | Kind::Trait | Kind::Enum | Kind::Impl
        )
    }

    /// Whether it's what find_symbol's `kind` asks for: a word as `word()` gives it, or
    /// "type" for any type and "function" for anything callable.
    pub(super) fn fits(self, wanted: &str) -> bool {
        match wanted {
            "" => true,
            "type" => (self.holds_methods() && self != Kind::Impl) || self == Kind::Type,
            "function" => matches!(self, Kind::Function | Kind::Method | Kind::Constructor),
            w => self.word() == w,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_known_by_their_extension() {
        assert_eq!(Lang::of("src/a.ts"), Some(Lang::TypeScript));
        assert_eq!(Lang::of("src/A.TSX"), Some(Lang::Tsx));
        assert_eq!(Lang::of("web/app.mjs"), Some(Lang::Tsx));
        assert_eq!(Lang::of("Program.cs"), Some(Lang::CSharp));
        assert_eq!(Lang::of("main.go"), Some(Lang::Go));
        assert_eq!(Lang::of("x/y.py"), Some(Lang::Python));
        assert_eq!(Lang::of("lib.rs"), Some(Lang::Rust));
        assert_eq!(Lang::of("src/main/java/App.java"), Some(Lang::Java));
        assert_eq!(Lang::of("src/store.cpp"), Some(Lang::Cpp));
        assert_eq!(Lang::of("include/store.hpp"), Some(Lang::Cpp));
        assert_eq!(Lang::of("legacy/io.c"), Some(Lang::Cpp));
        assert_eq!(Lang::of("legacy/io.h"), Some(Lang::Cpp));
        assert_eq!(Lang::of("README.md"), None);
        assert_eq!(Lang::of("Makefile"), None);
    }

    #[test]
    fn the_languages_read_for_their_definitions_are_known_too() {
        assert_eq!(Lang::of("app/Main.kt"), Some(Lang::Kotlin));
        assert_eq!(Lang::of("build.gradle.kts"), Some(Lang::Kotlin));
        assert_eq!(Lang::of("App/View.swift"), Some(Lang::Swift));
        assert_eq!(Lang::of("src/Order.php"), Some(Lang::Php));
        assert_eq!(Lang::of("app/models/order.rb"), Some(Lang::Ruby));
        assert_eq!(Lang::of("Rakefile.rake"), Some(Lang::Ruby));
        assert_eq!(Lang::of("scripts/deploy.sh"), Some(Lang::Bash));
        assert_eq!(Lang::of("tools/Build.PS1"), Some(Lang::PowerShell));
        assert_eq!(Lang::of("Module.psm1"), Some(Lang::PowerShell));
        assert_eq!(serde_json::json!(Lang::PowerShell), "powershell");
    }

    #[test]
    fn config_files_are_known_by_their_extension_or_name() {
        let config = |p: &str| match FileType::of(p) {
            Some(FileType::Config(c)) => Some(c),
            _ => None,
        };
        assert_eq!(config("Views/Main.xaml"), Some(Config::Xml));
        assert_eq!(config("App/App.csproj"), Some(Config::Xml));
        assert_eq!(config("Web.config"), Some(Config::Xml));
        assert_eq!(config("pom.xml"), Some(Config::Xml));
        assert_eq!(config("Views/Orders/Index.cshtml"), Some(Config::Razor));
        assert_eq!(config("Pages/Counter.razor"), Some(Config::Razor));
        assert_eq!(config(".github/workflows/ci.yml"), Some(Config::Yaml));
        assert_eq!(config("k8s/deploy.YAML"), Some(Config::Yaml));
        assert_eq!(config("Dockerfile"), Some(Config::Docker));
        assert_eq!(config("docker/Dockerfile.dev"), Some(Config::Docker));
        assert_eq!(config("api.dockerfile"), Some(Config::Docker));
        assert_eq!(config("Containerfile"), Some(Config::Docker));
        assert_eq!(config("dockerfiles/readme"), None);
        assert_eq!(config("package.json"), Some(Config::Json));
        assert_eq!(config(".vscode/settings.jsonc"), Some(Config::Json));
        assert_eq!(config("Cargo.toml"), Some(Config::Toml));
        assert_eq!(config("db/schema.SQL"), Some(Config::Sql));
        assert_eq!(config("public/index.html"), Some(Config::Html));
        assert_eq!(config("src/App.vue"), Some(Config::Html));
        assert_eq!(config("src/Card.svelte"), Some(Config::Html));
        assert_eq!(config("styles/site.scss"), Some(Config::Css));
        assert_eq!(config("theme.less"), Some(Config::Css));
        assert!(FileType::of("ci.yml").is_some_and(FileType::is_code));
        assert!(!FileType::Markdown.is_code());
    }

    #[test]
    fn documents_are_read_too_and_every_type_goes_by_its_id() {
        assert_eq!(FileType::of("docs/a.MD"), Some(FileType::Markdown));
        assert_eq!(FileType::of("notes.txt"), Some(FileType::Text));
        assert_eq!(FileType::of("a.rs"), Some(FileType::Code(Lang::Rust)));
        assert_eq!(FileType::of("a.png"), None);
        for t in ALL {
            assert_eq!(FileType::from_id(t.id()), Some(t));
        }
        assert_eq!(FileType::from_id("cobol"), None);
    }

    #[test]
    fn languages_and_kinds_are_kept_by_these_names() {
        assert_eq!(serde_json::json!(Lang::CSharp), "csharp");
        assert_eq!(serde_json::json!(Lang::TypeScript), "typescript");
        assert_eq!(serde_json::json!(Kind::Constructor), "constructor");
        assert_eq!(
            serde_json::from_str::<Kind>("\"impl\"").unwrap(),
            Kind::Impl
        );
    }

    #[test]
    fn every_grammar_loads() {
        for lang in ALL.into_iter().filter_map(FileType::lang) {
            let mut p = tree_sitter::Parser::new();
            assert!(p.set_language(&lang.grammar()).is_ok(), "{lang:?}");
        }
    }

    #[test]
    fn kinds_fit_what_is_asked_for() {
        assert!(Kind::Struct.fits("type") && Kind::Type.fits("type"));
        assert!(!Kind::Impl.fits("type") && !Kind::Method.fits("type"));
        assert!(Kind::Method.fits("function") && Kind::Constructor.fits("function"));
        assert!(Kind::Class.fits("class") && !Kind::Class.fits("struct"));
        assert!(Kind::Macro.fits(""));
    }
}
