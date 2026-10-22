use crate::storage::{io_error, Result};
use rubato::{FftFixedInOut, Resampler};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const MODEL_NAME: &str = "ggml-tiny.en-q5_1.bin";
pub const MODEL_SIZE: u64 = 32_166_155;
const MODEL_SHA256: &str = "c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin";

pub fn model_ready(path: &Path) -> bool {
    path.metadata()
        .map(|m| m.is_file() && m.len() == MODEL_SIZE)
        .unwrap_or(false)
}
pub fn download_model(path: &Path, cancel: &AtomicBool, progress: impl Fn(u64)) -> Result<()> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(io_error)?;
    let mut response = client.get(MODEL_URL).send().and_then(|r| r.error_for_status()).map_err(|e| format!("The speech model could not be downloaded. Check your internet connection and retry. {e}"))?;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid model location")?)
        .map_err(io_error)?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut reported = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Download cancelled. You can retry whenever you're ready.".into());
        }
        let read = response
            .read(&mut buffer)
            .map_err(|e| format!("The model download was interrupted. Retry the download. {e}"))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > MODEL_SIZE {
            return Err("The downloaded model had an unexpected size. Retry the download.".into());
        }
        file.write_all(&buffer[..read]).map_err(io_error)?;
        hasher.update(&buffer[..read]);
        if total - reported >= 1024 * 1024 || total == MODEL_SIZE {
            progress(total);
            reported = total;
        }
    }
    if total != MODEL_SIZE || format!("{:x}", hasher.finalize()) != MODEL_SHA256 {
        return Err(
            "The model verification failed. Retry the download to get a complete copy.".into(),
        );
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("Download cancelled.".into());
    }
    file.as_file().sync_all().map_err(io_error)?;
    file.persist(path).map_err(io_error)?;
    Ok(())
}

pub fn resample_mono(samples: Vec<f32>, rate: u32) -> Result<Vec<f32>> {
    if rate == 16_000 {
        return Ok(samples);
    }
    if !(8_000..=384_000).contains(&rate) {
        return Err("The microphone uses an unsupported sample rate".into());
    }
    let desired = (samples.len() as u64 * 16_000 / rate as u64) as usize;
    let mut resampler =
        FftFixedInOut::<f32>::new(rate as usize, 16_000, 1024, 1).map_err(io_error)?;
    let input_size = resampler.input_frames_next();
    let delay = resampler.output_delay();
    let mut result = Vec::with_capacity(desired + delay + 4096);
    for chunk in samples.chunks(input_size) {
        let mut input = vec![0.0; input_size];
        input[..chunk.len()].copy_from_slice(chunk);
        result.extend_from_slice(&resampler.process(&[input], None).map_err(io_error)?[0]);
    }
    while result.len() < desired + delay {
        result.extend_from_slice(
            &resampler
                .process(&[vec![0.0; input_size]], None)
                .map_err(io_error)?[0],
        );
    }
    Ok(result[delay..delay + desired].to_vec())
}

pub fn read_audio(path: &Path) -> Result<Vec<f32>> {
    if fs::metadata(path).map_err(io_error)?.len() > 512 * 1024 * 1024 {
        return Err("This recording is too large to transcribe in one note.".into());
    }
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| format!("The recording could not be read. Record the note again. {e}"))?;
    let spec = reader.spec();
    if spec.channels == 0 || spec.channels > 32 {
        return Err("The recording has an unsupported channel layout".into());
    }
    let samples = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Int, 16) => reader
            .samples::<i16>()
            .map(|s| s.map(|n| n as f32 / 32768.0))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(io_error)?,
        (hound::SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(io_error)?,
        _ => return Err("The recording must use 16-bit PCM or 32-bit float WAV audio".into()),
    };
    let channels = spec.channels as usize;
    let mono = samples
        .chunks_exact(channels)
        .map(|frame| {
            frame
                .iter()
                .copied()
                .map(|n| {
                    if n.is_finite() {
                        n.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    }
                })
                .sum::<f32>()
                / channels as f32
        })
        .collect();
    resample_mono(mono, spec.sample_rate)
}
pub struct Decoder {
    state: whisper_rs::WhisperState,
}
impl Decoder {
    pub fn load(path: &Path) -> Result<Self> {
        // Guard before entering the native engine compiled with MSVC /arch:AVX2.
        #[cfg(target_arch = "x86_64")]
        if !(std::arch::is_x86_feature_detected!("avx2")
            && std::arch::is_x86_feature_detected!("fma")
            && std::arch::is_x86_feature_detected!("f16c")
            && std::arch::is_x86_feature_detected!("bmi2"))
        {
            return Err("Local transcription needs an AVX2-compatible x64 CPU (with FMA, F16C and BMI2). Screenshots and typed notes still work on this PC.".into());
        }
        if !model_ready(path) {
            return Err("Download the speech model in Settings, then retry transcription.".into());
        }
        let mut params = WhisperContextParameters::default();
        params.use_gpu(false);
        let context =
            WhisperContext::new_with_params(path.to_str().ok_or("Invalid model path")?, params)
                .map_err(|e| {
                    format!(
                        "The speech model could not be loaded. Download it again in Settings. {e}"
                    )
                })?;
        Ok(Self {
            state: context.create_state().map_err(io_error)?,
        })
    }
    pub fn decode(
        &mut self,
        samples: &[f32],
        live: bool,
        progress: impl Fn(i32) + Send + 'static,
    ) -> Result<String> {
        if samples.len() < 1600
            || !samples
                .chunks(480)
                .any(|c| c.iter().map(|x| x * x).sum::<f32>() / c.len().max(1) as f32 > 0.000_004)
        {
            return Err("No speech was detected. Check your microphone and record again.".into());
        }
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(
            std::thread::available_parallelism()
                .map(|n| n.get().min(4))
                .unwrap_or(2) as i32,
        );
        params.set_language(Some("en"));
        params.set_translate(false);
        params.set_no_context(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        // Disable expensive temperature fallback on short or quiet microphone input.
        params.set_temperature_inc(0.0);
        if live {
            params.set_audio_ctx(512);
            params.set_single_segment(true);
        }
        params.set_progress_callback_safe(progress);
        self.state.full(params, samples).map_err(|e| {
            format!("Transcription stopped. Your audio is kept; retry when ready. {e}")
        })?;
        let mut text = String::new();
        for segment in self.state.as_iter() {
            if segment.no_speech_probability() < 0.8 {
                text.push_str(&segment.to_str_lossy().map_err(io_error)?);
            }
        }
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.chars().any(char::is_alphanumeric) {
            return Err("No clear speech was detected. Your recording is kept.".into());
        }
        Ok(text)
    }
}
pub fn transcribe(
    path: &Path,
    audio: &Path,
    cancelled: impl Fn() -> bool + Send + Sync + 'static,
    progress: impl Fn(i32) + Send + 'static,
) -> Result<String> {
    let samples = read_audio(audio)?;
    // Reject silence before loading the model, including for interrupted-note recovery.
    if samples.len() < 1600 || !samples.iter().any(|s| s.abs() > 0.002) {
        return Err("No speech was detected. Check your microphone and record again.".into());
    }
    if cancelled() {
        return Err("Transcription cancelled. Your audio is saved.".into());
    }
    let text = Decoder::load(path)?.decode(&samples, false, progress)?;
    if cancelled() {
        return Err("Transcription cancelled. Your audio is saved.".into());
    }
    Ok(text)
}

/// Bounded microphone history; decoding never blocks the audio device or disk writer.
#[derive(Default)]
pub struct LiveAudio {
    samples: std::collections::VecDeque<f32>,
    rate: u32,
    total: u64,
}
impl LiveAudio {
    pub fn push(&mut self, samples: &[f32], rate: u32) {
        self.rate = rate;
        self.total += samples.len() as u64;
        self.samples.extend(samples.iter().map(|&s| {
            if s.is_finite() {
                s.clamp(-1.0, 1.0)
            } else {
                0.0
            }
        }));
        let excess = self.samples.len().saturating_sub(rate as usize * 16);
        self.samples.drain(..excess);
    }
}
pub fn live_decode(
    path: &Path,
    audio: std::sync::Arc<std::sync::Mutex<LiveAudio>>,
    done: std::sync::Arc<AtomicBool>,
    mut partial: impl FnMut(String),
) -> Result<Decoder> {
    let mut decoder = Decoder::load(path)?;
    let mut last = 0;
    let mut start = 0;
    let mut committed = String::new();
    while !done.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
        let next = {
            let audio = audio.lock().map_err(io_error)?;
            let rate = audio.rate as u64;
            if rate == 0 || audio.total < rate * 2 || audio.total - last < rate * 3 / 2 {
                None
            } else {
                let oldest = audio.total - audio.samples.len() as u64;
                // A slow decode may fall behind. Keep interim work short; the final
                // pass always reads the complete WAV, including any omitted words.
                start = start.max(oldest).max(audio.total.saturating_sub(rate * 8));
                let samples = audio
                    .samples
                    .iter()
                    .skip((start - oldest) as usize)
                    .copied()
                    .collect();
                Some((samples, audio.rate, audio.total))
            }
        };
        if let Some((samples, rate, total)) = next {
            let samples = resample_mono(samples, rate)?;
            if done.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(text) = decoder.decode(&samples, true, |_| {}) {
                let combined = merge_text(&committed, &text);
                partial(combined.clone());
                if total - start >= u64::from(rate) * 8 {
                    committed = combined;
                    start = total.saturating_sub(u64::from(rate));
                }
            }
            last = total;
        }
    }
    Ok(decoder)
}
fn merge_text(prefix: &str, suffix: &str) -> String {
    let left: Vec<_> = prefix.split_whitespace().collect();
    let right: Vec<_> = suffix.split_whitespace().collect();
    let clean = |w: &str| {
        w.trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase()
    };
    let overlap = (1..=left.len().min(right.len()).min(12))
        .rev()
        .find(|&n| {
            left[left.len() - n..]
                .iter()
                .zip(&right[..n])
                .all(|(a, b)| clean(a) == clean(b))
        })
        .unwrap_or(0);
    left.into_iter()
        .chain(right.into_iter().skip(overlap))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_history_is_bounded_and_overlap_does_not_repeat_words() {
        let mut audio = LiveAudio::default();
        audio.push(&vec![0.1; 48_000 * 20], 48_000);
        assert_eq!(audio.samples.len(), 48_000 * 16);
        assert_eq!(audio.total, 48_000 * 20);
        assert_eq!(
            merge_text("Save this screenshot.", "This screenshot needs a note."),
            "Save this screenshot. needs a note."
        );
        assert_eq!(merge_text("", "A first thought."), "A first thought.");
    }
    #[test]
    fn resampling_preserves_duration_and_silence() {
        for rate in [16000, 44100, 48000, 96000] {
            let result = resample_mono(vec![0.0; rate as usize], rate).unwrap();
            assert_eq!(result.len(), 16000);
            assert!(result.iter().all(|x| x.abs() < 0.00001));
        }
    }
    #[test]
    fn silent_audio_does_not_hallucinate() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("silence.wav");
        let mut writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for _ in 0..16000 {
            writer.write_sample(0i16).unwrap();
        }
        writer.finalize().unwrap();
        assert!(
            transcribe(&dir.path().join("missing.bin"), &path, || false, |_| {})
                .unwrap_err()
                .contains("No speech")
        );
    }
}
