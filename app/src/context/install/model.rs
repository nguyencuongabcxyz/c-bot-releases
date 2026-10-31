//! The models search runs (embed/), downloaded from Hugging Face the first time they're needed
//! into <dir>/models/<name>: each one's tokenizer and the model itself, as ONNX. The sentence
//! model (about 470 MB) gives chunks their vectors; the reranker (about 135 MB) reads a question
//! with each chunk found and puts them in order. Each file comes down as a .part and is renamed
//! once whole, so a download cut short is picked up again; a model's folder is complete once
//! its files are all there.

use super::*;

/// A model on Hugging Face: its repository, its files (as there, as here), and what the chat
/// calls it while it downloads.
pub(in crate::context) struct Spec {
    repo: &'static str,
    files: [(&'static str, &'static str); 2],
    called: &'static str,
}

/// The sentence model (multilingual-e5-small: trained to find passages that answer a question,
/// in about a hundred languages, Vietnamese among them).
pub(in crate::context) const SENTENCE: Spec = Spec {
    repo: "intfloat/multilingual-e5-small",
    files: [
        ("tokenizer.json", "tokenizer.json"),
        ("onnx/model.onnx", "model.onnx"),
    ],
    called: "the search model (once, about 470 MB)",
};

/// The reranker (a cross-encoder trained on mMARCO, in 14 languages, Vietnamese among them),
/// quantized to 8 bits for any x64 CPU with AVX2: a quarter of the size, several times faster.
pub(in crate::context) const RERANKER: Spec = Spec {
    repo: "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1",
    files: [
        ("tokenizer.json", "tokenizer.json"),
        ("onnx/model_quint8_avx2.onnx", "model.onnx"),
    ],
    called: "the reranker (once, about 135 MB)",
};

impl Spec {
    /// Its repository on Hugging Face.
    pub(in crate::context) fn name(&self) -> &'static str {
        self.repo
    }

    fn folder(&self, dir: &Path) -> PathBuf {
        let name = self.repo.rsplit('/').next().unwrap_or(self.repo);
        dir.join("models").join(name)
    }
}

/// A model's folder under `dir`, if it's been downloaded.
pub(in crate::context) fn model_downloaded(dir: &Path, spec: &Spec) -> Option<PathBuf> {
    let at = spec.folder(dir);
    spec.files
        .iter()
        .all(|(_, name)| at.join(name).exists())
        .then_some(at)
}

/// A model's folder under `dir`, its files downloaded if need be (`say` hears how far).
pub(in crate::context) fn model(
    dir: &Path,
    spec: &Spec,
    say: &(dyn Fn(&str) + Sync),
) -> Result<PathBuf, Error> {
    if let Some(at) = model_downloaded(dir, spec) {
        return Ok(at);
    }
    let at = spec.folder(dir);
    std::fs::create_dir_all(&at).map_err(|e| format!("Couldn't make {}: {e}", at.display()))?;
    let client = client()?;
    let from = format!("https://huggingface.co/{}/resolve/main", spec.repo);
    for (i, (file, name)) in spec.files.iter().enumerate() {
        let target = at.join(name);
        if target.exists() {
            continue;
        }
        let tell = |pct: u64| {
            say(&format!(
                "Downloading {}: {}%",
                spec.called,
                (i as u64 * 100 + pct) / spec.files.len() as u64
            ));
        };
        block(download(&client, &format!("{from}/{file}"), &target, &tell))
            .map_err(|e| format!("Couldn't download {} ({name}): {e}", spec.called))?;
    }
    Ok(at)
}

/// The client downloads go through.
pub(super) fn client() -> Result<reqwest::Client, Error> {
    let _ = rustls::crypto::ring::default_provider().install_default(); // (as the updater does)
    reqwest::Client::builder()
        .build()
        .map_err(|e| format!("Couldn't download: {e}").into())
}

/// One file, into `target` (by way of a .part), `tell` hearing the percentage as it goes.
pub(super) async fn download(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    tell: &(dyn Fn(u64) + Sync),
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut response = client.get(url).send().await?.error_for_status()?;
    let total = response.content_length().unwrap_or(0);
    let part = target.with_extension("part");
    let mut out = std::fs::File::create(&part)?;
    let (mut got, mut said) = (0u64, u64::MAX);
    while let Some(bytes) = response.chunk().await? {
        out.write_all(&bytes)?;
        got += bytes.len() as u64;
        let pct = (got * 100).checked_div(total).unwrap_or(0);
        if pct != said {
            said = pct;
            tell(pct);
        }
    }
    out.flush()?;
    drop(out);
    if total > 0 && got != total {
        return Err(format!("got {got} of {total} bytes").into());
    }
    std::fs::rename(&part, target)?;
    Ok(())
}
