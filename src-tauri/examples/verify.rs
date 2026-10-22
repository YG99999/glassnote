//! Runs the production downloader, transcription, and export paths without UI fixtures.
use glassnote_lib::{speech, storage::Store};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect()
}
fn word_error_rate(reference: &str, hypothesis: &str) -> f64 {
    let a = words(reference);
    let b = words(hypothesis);
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.iter().enumerate() {
        let mut row = vec![i + 1; b.len() + 1];
        for (j, y) in b.iter().enumerate() {
            row[j + 1] = (row[j] + 1)
                .min(previous[j + 1] + 1)
                .min(previous[j] + usize::from(x != y));
        }
        previous = row;
    }
    previous[b.len()] as f64 / a.len().max(1) as f64
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).ok_or(
        "Use: verify download MODEL | transcribe MODEL WAV REFERENCE | live MODEL WAV | export LIBRARY FOLDER",
    )?;
    let path = PathBuf::from(args.get(2).ok_or("A path is required")?);
    match mode.as_str() {
        "download" => {
            std::fs::create_dir_all(path.parent().ok_or("Model needs a parent folder")?)?;
            if !speech::model_ready(&path) {
                let last = AtomicU64::new(0);
                speech::download_model(&path, &AtomicBool::new(false), |n| {
                    let percent = n * 100 / speech::MODEL_SIZE;
                    if percent >= last.load(Ordering::Relaxed) + 10 {
                        last.store(percent, Ordering::Relaxed);
                        eprintln!("Model download: {percent}%");
                    }
                })
                .map_err(std::io::Error::other)?;
            }
            println!("Verified model ready: {}", path.display());
        }
        "transcribe" => {
            let wav = PathBuf::from(args.get(3).ok_or("WAV path is required")?);
            let reference = std::fs::read_to_string(
                args.get(4).ok_or("Reference transcript path is required")?,
            )?;
            let seconds = speech::read_audio(&wav)
                .map_err(std::io::Error::other)?
                .len() as f64
                / 16000.0;
            let started = Instant::now();
            let text =
                speech::transcribe(&path, &wav, || false, |_| {}).map_err(std::io::Error::other)?;
            let elapsed = started.elapsed().as_secs_f64();
            let error = word_error_rate(&reference, &text);
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &serde_json::json!({"transcript":text,"audioSeconds":seconds,"processingSeconds":elapsed,"wordErrorRate":error,"realTimeFactor":elapsed/seconds})
                )?
            );
            if error > 0.15 {
                return Err("The fixture exceeded 15% word error rate".into());
            }
        }
        "live" => {
            let wav = PathBuf::from(args.get(3).ok_or("WAV path is required")?);
            let samples = speech::read_audio(&wav).map_err(std::io::Error::other)?;
            let audio = Arc::new(Mutex::new(speech::LiveAudio::default()));
            let done = Arc::new(AtomicBool::new(false));
            let history = audio.clone();
            let finished = done.clone();
            let started = Instant::now();
            let worker = std::thread::spawn(move || {
                let mut first = None;
                let decoder = speech::live_decode(&path, history, finished, |text| {
                    let elapsed = started.elapsed().as_secs_f64();
                    first.get_or_insert(elapsed);
                    println!(
                        "{}",
                        serde_json::json!({"partialSeconds":elapsed,"text":text})
                    );
                });
                (decoder, first)
            });
            for chunk in samples.chunks(1600) {
                audio.lock().unwrap().push(chunk, 16000);
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let stopped = Instant::now();
            done.store(true, Ordering::Relaxed);
            let (decoder, first) = worker.join().map_err(|_| "Live worker panicked")?;
            let final_text = decoder
                .map_err(std::io::Error::other)?
                .decode(&samples, false, |_| {})
                .map_err(std::io::Error::other)?;
            println!(
                "{}",
                serde_json::json!({"firstPartialSeconds":first,"finalAfterStopSeconds":stopped.elapsed().as_secs_f64(),"text":final_text})
            );
            if first.is_none() {
                return Err("No live text arrived before Stop".into());
            }
        }
        "export" => {
            let store = Store::open(path).map_err(std::io::Error::other)?;
            let output = PathBuf::from(args.get(3).ok_or("Export folder is required")?);
            let destination = store
                .export(&store.settings().active_project_id, &output)
                .map_err(std::io::Error::other)?;
            println!("{}", destination.display());
        }
        _ => return Err("Unknown verification mode".into()),
    }
    Ok(())
}
