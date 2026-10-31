//! What went wrong. Mostly a sentence for whoever asked (a page shows it as it is, an MCP
//! client gets it as the tool's error); the rest is what Tauri, a file or JSON said.
//! A command's error goes to its page as that text, the same as a plain String would.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    /// The context engine's database (context/store).
    #[error("The code index's database: {0}")]
    Database(#[from] sqlx::Error),
    /// The context engine's keyword index (context/keyword.rs).
    #[error("The code index's search: {0}")]
    Search(#[from] tantivy::TantivyError),
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Error::Message(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Error::Message(message.into())
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_gets_the_message() {
        let said: Error = "That conversation has closed.".into();
        assert_eq!(
            serde_json::to_value(&said).unwrap(),
            "That conversation has closed."
        );
        let io: Error = std::io::Error::new(std::io::ErrorKind::NotFound, "no such file").into();
        assert_eq!(serde_json::to_value(&io).unwrap(), "no such file");
    }
}
