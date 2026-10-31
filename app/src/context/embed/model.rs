//! The sentence model, run by ONNX Runtime on the CPU: multilingual-e5-small (it reads
//! Vietnamese as well as English). A text becomes its tokens (at most MAX_TOKENS: a chunk's
//! beginning, where it is and what it's in first), then the mean of their vectors from the
//! model's last layer, scaled to length 1, so that the dot product of two is how alike they
//! are.

use std::borrow::Cow;
use std::sync::OnceLock;

use ort::environment::Environment;
use ort::session::Session;
use ort::session::SessionInputValue;
use ort::value::Tensor;
use tokenizers::{Encoding, PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};

use super::*;

pub(super) const MAX_TOKENS: usize = 256;

/// ONNX Runtime, loaded from its DLL once for the app's life (it can't be loaded twice).
static RUNTIME: OnceLock<Environment> = OnceLock::new();

pub(in crate::context) struct Model {
    session: Mutex<Session>, // (a run needs it to itself)
    tokenizer: Tokenizer,
    types: bool, // (it takes token_type_ids too)
}

pub(super) type Failure = Box<dyn std::error::Error + Send + Sync>;

pub(super) fn failed(doing: &str, e: impl std::fmt::Display) -> Error {
    format!("Couldn't {doing} the search model: {e}").into()
}

/// ONNX Runtime, from the DLL at `dll` the first time.
fn runtime(dll: &Path) -> Result<&'static Environment, Error> {
    if let Some(env) = RUNTIME.get() {
        return Ok(env);
    }
    let env = ort::init_from(dll)
        .map_err(|e| failed("start ONNX Runtime for", e))?
        .with_name("c-bot")
        .build()
        .map_err(|e| failed("start ONNX Runtime for", e))?;
    Ok(RUNTIME.get_or_init(|| env))
}

impl Model {
    /// The model in `dir` (install::model's folder), run by the ONNX Runtime at `dll`.
    pub(in crate::context) fn load(dir: &Path, dll: &Path) -> Result<Model, Error> {
        Self::load_with(dir, dll, "model.onnx", None)
    }

    /// The model `file` in `dir`, on `threads` threads (None: ONNX Runtime's choice).
    fn load_with(
        dir: &Path,
        dll: &Path,
        file: &str,
        threads: Option<usize>,
    ) -> Result<Model, Error> {
        let tokenizer = tokenizer(dir, MAX_TOKENS)?;
        let session = session(dll, &dir.join(file), threads)?;
        let types = takes_types(&session);
        Ok(Model {
            session: Mutex::new(session),
            tokenizer,
            types,
        })
    }

    /// Each text's vector (DIMENSIONS long, of length 1).
    pub(in crate::context) fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, Error> {
        if texts.is_empty() {
            return Ok(vec![]);
        }
        self.vectors(texts).map_err(|e| failed("run", e))
    }

    fn vectors(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, Failure> {
        let encodings = self.tokenizer.encode_batch(texts.to_vec(), true)?;
        let (n, len) = (encodings.len(), encodings.first().map_or(0, |e| e.len()));
        let inputs = inputs(&encodings, self.types)?;
        let mut session = self.session.locked();
        let outputs = session.run(inputs)?;
        let (out_shape, tokens) = outputs[0].try_extract_tensor::<f32>()?; // [texts, tokens, dims]
        let dims = usize::try_from(*out_shape.last().unwrap_or(&0))?;
        if dims == 0 || tokens.len() != n * len * dims {
            return Err(
                format!("the model gave {out_shape:?} for {n} texts of {len} tokens").into(),
            );
        }
        Ok(encodings
            .iter()
            .zip(tokens.chunks_exact(len * dims))
            .map(|(e, t)| mean_of(t, e.get_attention_mask(), dims))
            .collect())
    }
}

/// A model's tokenizer, cutting texts at `max` tokens and padding a batch to its longest.
pub(super) fn tokenizer(dir: &Path, max: usize) -> Result<Tokenizer, Error> {
    let mut tokenizer =
        Tokenizer::from_file(dir.join("tokenizer.json")).map_err(|e| failed("read", e))?;
    tokenizer
        .with_truncation(Some(TruncationParams {
            max_length: max,
            ..TruncationParams::default()
        }))
        .map_err(|e| failed("set up", e))?;
    let pad = tokenizer.token_to_id("<pad>").unwrap_or(1);
    tokenizer.with_padding(Some(PaddingParams {
        strategy: PaddingStrategy::BatchLongest,
        pad_id: pad,
        pad_token: "<pad>".into(),
        ..PaddingParams::default()
    }));
    Ok(tokenizer)
}

/// A model file loaded into ONNX Runtime (the DLL at `dll`), on `threads` threads (None: ONNX
/// Runtime's choice).
pub(super) fn session(dll: &Path, file: &Path, threads: Option<usize>) -> Result<Session, Error> {
    let mut builder = Session::builder(runtime(dll)?).map_err(|e| failed("load", e))?;
    if let Some(n) = threads {
        builder = builder
            .with_intra_threads(n)
            .map_err(|e| failed("set up", e))?;
    }
    builder
        .commit_from_file(file)
        .map_err(|e| failed("load", e))
}

/// Whether a model takes token_type_ids too (BERT's do, XLM-RoBERTa's don't).
pub(super) fn takes_types(session: &Session) -> bool {
    session
        .inputs()
        .iter()
        .any(|i| i.name() == "token_type_ids")
}

/// A batch of texts, tokenized and padded alike, as a model's inputs.
pub(super) fn inputs(
    encodings: &[Encoding],
    types: bool,
) -> Result<Vec<(Cow<'static, str>, SessionInputValue<'static>)>, Failure> {
    let n = encodings.len();
    let len = encodings.first().map_or(0, Encoding::len);
    let flat = |part: fn(&Encoding) -> &[u32]| -> Vec<i64> {
        encodings
            .iter()
            .flat_map(|e| part(e).iter().map(|&x| i64::from(x)))
            .collect()
    };
    let shape = [i64::try_from(n)?, i64::try_from(len)?];
    let mut inputs: Vec<(Cow<'static, str>, SessionInputValue<'static>)> = vec![
        (
            "input_ids".into(),
            Tensor::from_array((shape, flat(Encoding::get_ids)))?.into(),
        ),
        (
            "attention_mask".into(),
            Tensor::from_array((shape, flat(Encoding::get_attention_mask)))?.into(),
        ),
    ];
    if types {
        inputs.push((
            "token_type_ids".into(),
            Tensor::from_array((shape, vec![0i64; n * len]))?.into(),
        ));
    }
    Ok(inputs)
}

/// The mean of a text's own tokens' vectors (not its padding's), scaled to length 1.
fn mean_of(tokens: &[f32], mask: &[u32], dims: usize) -> Vec<f32> {
    let mut sum = vec![0f32; dims];
    let mut count = 0f32;
    for (v, &m) in tokens.chunks_exact(dims).zip(mask) {
        if m != 0 {
            sum.iter_mut().zip(v).for_each(|(s, x)| *s += x);
            count += 1.0;
        }
    }
    let mean: Vec<f32> = sum.iter().map(|s| s / count.max(1.0)).collect();
    let length = mean.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    mean.iter().map(|x| x / length).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mean_leaves_padding_out_and_has_length_one() {
        // (two tokens and a padding one, of 2 dimensions)
        let v = mean_of(&[1.0, 0.0, 3.0, 4.0, 100.0, 100.0], &[1, 1, 0], 2);
        // (the mean is [2, 2])
        assert!(
            v.iter()
                .all(|x| (x - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6)
        );
    }
}
