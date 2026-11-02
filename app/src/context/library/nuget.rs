//! A .NET package's XML documentation (NuGet keeps no source): its members by their ids
//! (`M:Newtonsoft.Json.JsonConvert.SerializeObject(System.Object)`), each with its summary,
//! its parameters and what it returns, in words.

use super::*;

/// A documented member: its id, and its documentation in words.
pub(super) struct Doc {
    pub id: String,
    pub text: String,
}

impl Doc {
    /// What it is, by its id's letter.
    pub(super) fn kind(&self) -> &'static str {
        match self.id.split(':').next().unwrap_or("") {
            "T" => "type",
            "M" => "method",
            "P" => "property",
            "F" => "field",
            "E" => "event",
            _ => "member",
        }
    }

    /// Its full name, without its letter or its parameters: `Newtonsoft.Json.JsonConvert.SerializeObject`.
    fn path(&self) -> &str {
        let id = self.id.split_once(':').map_or(self.id.as_str(), |(_, r)| r);
        id.split('(').next().unwrap_or(id)
    }

    /// Its name as shown: its full name with its parameters' types.
    pub(super) fn shown(&self) -> &str {
        self.id.split_once(':').map_or(self.id.as_str(), |(_, r)| r)
    }

    /// Whether `name` names it: its own name (`SerializeObject`), or with what holds it
    /// (`JsonConvert.SerializeObject`), or in full.
    pub(super) fn named(&self, name: &str) -> bool {
        let path = self.path();
        path == name || path.ends_with(&format!(".{name}"))
    }
}

/// The documented members in an XML documentation file, in its order.
pub(super) fn members(xml: &str) -> Vec<Doc> {
    static MEMBER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?s)<member name="([^"]+)"\s*>(.*?)</member>"#).expect("a constant regex")
    });
    MEMBER
        .captures_iter(xml)
        .map(|c| Doc {
            id: c[1].to_string(),
            text: words(&c[2]),
        })
        .collect()
}

/// A member's documentation in words: its summary, then each parameter (`name: …`), what it
/// returns (`returns: …`), its remarks; references by their names.
fn words(xml: &str) -> String {
    static PART: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?s)<(summary|param|typeparam|returns|remarks|exception)(?:\s+(?:name|cref)="([^"]*)")?\s*>(.*?)</\w+>"#)
            .expect("a constant regex")
    });
    static REF: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"<(?:see|seealso|paramref|typeparamref)\s+(?:cref|name|langword)="(?:\w:)?([^"]*)"\s*/>"#)
            .expect("a constant regex")
    });
    static TAG: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<[^>]+>").expect("a constant regex"));
    let xml = REF.replace_all(xml, "$1");
    let mut out: Vec<String> = vec![];
    for c in PART.captures_iter(&xml) {
        let text = TAG.replace_all(&c[3], "");
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            continue;
        }
        let label = c.get(2).map_or("", |m| m.as_str());
        let label = label.rsplit(['.', ':']).next().unwrap_or(label);
        out.push(match &c[1] {
            "summary" => text,
            "returns" => format!("returns: {text}"),
            "remarks" => format!("remarks: {text}"),
            "exception" => format!("throws {label}: {text}"),
            _ => format!("{label}: {text}"),
        });
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<?xml version="1.0"?>
<doc><members>
<member name="T:Newtonsoft.Json.JsonConvert">
  <summary>Provides methods for converting between .NET types and JSON types.</summary>
</member>
<member name="M:Newtonsoft.Json.JsonConvert.SerializeObject(System.Object)">
  <summary>Serializes the specified object to a JSON string.</summary>
  <param name="value">The object to serialize.</param>
  <returns>A JSON string representation of the object, see <see cref="T:System.String"/>.</returns>
</member>
</members></doc>"#;

    #[test]
    fn a_members_documentation_is_read_into_words() {
        let docs = members(XML);
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].kind(), "type");
        assert_eq!(docs[1].kind(), "method");
        assert_eq!(
            docs[1].shown(),
            "Newtonsoft.Json.JsonConvert.SerializeObject(System.Object)"
        );
        assert_eq!(
            docs[1].text,
            "Serializes the specified object to a JSON string.\nvalue: The object to serialize.\nreturns: A JSON string representation of the object, see System.String."
        );
    }

    #[test]
    fn a_member_is_named_by_its_name_with_or_without_what_holds_it() {
        let docs = members(XML);
        assert!(docs[1].named("SerializeObject"));
        assert!(docs[1].named("JsonConvert.SerializeObject"));
        assert!(!docs[1].named("Serialize"));
        assert!(docs[0].named("JsonConvert"));
    }
}
