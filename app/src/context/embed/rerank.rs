//! The reranker, run by ONNX Runtime on the CPU: a cross-encoder (mmarco-mMiniLMv2-L12-H384-v1,
//! multilingual) that reads a question and a chunk together, as one text, and says how well the
//! chunk answers it. The lanes each judge a chunk on its own (its words, its vector), so the
//! reranker is surer of the order; it's too slow for a whole folder, so search_code asks it
//! only about the best of what the lanes found.

use ort::session::Session;
use tokenizers::{EncodeInput, Tokenizer};

use super::*;

/// The most tokens of a question and a chunk read together (the question first, whole; the
/// chunk's beginning: where it is, what it's in, then its text).
const MAX_TOKENS: usize = 256;

pub(in crate::context) struct Reranker {
    session: Mutex<Session>, // (a run needs it to itself)
    tokenizer: Tokenizer,
    types: bool,
}

impl Reranker {
    /// The reranker in `dir` (install::model's folder), run by the ONNX Runtime at `dll`.
    pub(in crate::context) fn load(dir: &Path, dll: &Path) -> Result<Reranker, Error> {
        let tokenizer = model::tokenizer(dir, MAX_TOKENS)?;
        let session = model::session(dll, &dir.join("model.onnx"), None)?;
        let types = model::takes_types(&session);
        Ok(Reranker {
            session: Mutex::new(session),
            tokenizer,
            types,
        })
    }

    /// How well each text answers the question: higher is better (a logit, not a probability).
    pub(in crate::context) fn scores(
        &self,
        question: &str,
        texts: &[String],
    ) -> Result<Vec<f32>, Error> {
        if texts.is_empty() {
            return Ok(vec![]);
        }
        self.run(question, texts)
            .map_err(|e| model::failed("run", e))
    }

    fn run(&self, question: &str, texts: &[String]) -> Result<Vec<f32>, model::Failure> {
        let pairs: Vec<EncodeInput> = texts
            .iter()
            .map(|t| (question.to_string(), t.clone()).into())
            .collect();
        let encodings = self.tokenizer.encode_batch(pairs, true)?;
        let inputs = model::inputs(&encodings, self.types)?;
        let mut session = self.session.locked();
        let outputs = session.run(inputs)?;
        let (_, logits) = outputs[0].try_extract_tensor::<f32>()?; // [texts, 1]
        if logits.len() != texts.len() {
            return Err(format!(
                "the reranker gave {} scores for {} texts",
                logits.len(),
                texts.len()
            )
            .into());
        }
        Ok(logits.to_vec())
    }
}
