//! The structure of a config file, as definitions the chunker cuts along (chunk.rs), the way it
//! cuts code: an XML or XAML file's elements (named by their tag and what names them: `Grid
//! Main` for x:Name="Main", `PackageReference Serilog` for Include="Serilog", `form order` for
//! id="order"), and a Razor view's, with its route and its C# blocks (`@code › OnInitialized`);
//! a YAML file's keys (`jobs › build › steps`; a list item by its name), a Dockerfile's stages
//! (`stage build` from `FROM node:20 AS build`), a JSON file's keys, a TOML file's tables and
//! keys, an INI file's sections and keys (a .properties file's keys, nginx's and Apache's
//! blocks in a .conf), what SQL creates (`table orders`), CSS's rules (`.card:hover`, `@media
//! (max-width: 600px)`); an HTML page, Vue or Svelte component as XML. Only the first DEPTH
//! levels: deeper is what's in a chunk.
//!   xml.rs      XML's and HTML's elements, Razor's too
//!   keys.rs     YAML's, JSON's, TOML's and INI's keys
//!   blocks.rs   Dockerfile stages, SQL, CSS rules

mod blocks;
mod keys;
mod xml;

use blocks::*;
use keys::*;
use xml::*;

use super::*;

/// How many levels of nesting are definitions.
const DEPTH: usize = 3;
/// A name taken from a value (a list item's, an attribute's) is cut at this many characters.
const NAME_CHARS: usize = 60;

/// A config file's structure, as definitions.
pub(super) fn defs(config: Config, text: &str) -> Vec<Def> {
    match config {
        // (an HTML page, and a Vue or Svelte component's template, script and style, too)
        Config::Xml | Config::Html => xml(text),
        Config::Razor => razor(text),
        Config::Yaml => yaml(text),
        Config::Docker => docker(text),
        Config::Json => json(text),
        Config::Toml => toml(text),
        Config::Sql => sql(text),
        Config::Css => css(text),
        Config::Ini => ini(text),
    }
}

fn def(name: String, depth: usize, line: u32, end: u32) -> Def {
    Def {
        name,
        kind: Kind::Property,
        container: None,
        line,
        end,
        depth: u8::try_from(depth).unwrap_or(u8::MAX),
        sig: String::new(),
    }
}

fn line_no(i: usize) -> u32 {
    u32::try_from(i + 1).unwrap_or(u32::MAX)
}

/// The line of a place in a text, counted on from the last place asked about (they only go
/// forward), so a big file isn't counted from its start each time.
struct Lines<'a> {
    text: &'a str,
    at: usize,
    line: usize,
}

impl Lines<'_> {
    fn of(&mut self, at: usize) -> u32 {
        if at < self.at {
            (self.at, self.line) = (0, 0);
        }
        self.line += self.text[self.at..at].matches('\n').count();
        self.at = at;
        line_no(self.line)
    }
}

/// Where a string that starts at `at` (its quote) ends: past its closing quote, escapes let be.
fn string_end(text: &str, at: usize) -> usize {
    let quote = text.as_bytes()[at];
    let mut escaped = false;
    for (i, b) in text.as_bytes()[at + 1..].iter().enumerate() {
        match b {
            _ if escaped => escaped = false,
            b'\\' => escaped = true,
            b if *b == quote => return at + i + 2,
            _ => {}
        }
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn shown(defs: &[Def]) -> Vec<String> {
        defs.iter()
            .map(|d| {
                format!(
                    "{}{} @{}-{}",
                    "  ".repeat(d.depth.into()),
                    d.name,
                    d.line,
                    d.end
                )
            })
            .collect()
    }

    #[test]
    fn text_in_any_script_is_read_without_breaking_it() {
        // (bytes past ASCII: never cut inside a character)
        let src = "{ \"tên\": \"đăng nhập\", /* chú thích */ \"x\": 1 }\n.thẻ::after { content: \"→\"; }\n";
        assert_eq!(shown(&json(src)), ["tên @1-1", "x @1-1"]);
        assert_eq!(shown(&css(src)), [".thẻ::after @2-2"]); // (the JSON's { has no selector)
    }

    #[test]
    fn a_vue_component_is_its_blocks_and_template() {
        let src = "<template>\n  <div id=\"app\">\n    <Card v-if=\"a < b\" />\n  </div>\n</template>\n<script setup lang=\"ts\">\nconst a = 1 < 2;\n</script>\n<style scoped>\n.a { }\n</style>\n";
        assert_eq!(
            shown(&defs(Config::Html, src)),
            [
                "template @1-5",
                "  div app @2-4",
                "    Card @3-3",
                "script @6-8",
                "style @9-11",
            ]
        );
    }
}
