use crate::storage::{io_error, Result};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, SampleFormat, SizedSample,
};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, SyncSender, TrySendError},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

fn input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sender: SyncSender<Vec<f32>>,
    failure: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let callback_failure = failure.clone();
    device.build_input_stream(*config, move |data: &[T], _: &cpal::InputCallbackInfo| {
        let mono = data.chunks_exact(channels).map(|frame| frame.iter().map(|s|s.to_sample::<f32>()).sum::<f32>()/channels as f32).collect();
        if let Err(TrySendError::Full(_)) = sender.try_send(mono) {
            if let Ok(mut error) = callback_failure.lock() { *error = Some("Audio could not be saved fast enough. Close busy applications and record again.".into()); }
        }
    }, move |error| { if let Ok(mut failure) = failure.lock() { *failure = Some(format!("The microphone stopped working. Reconnect it and record again. {error}")); } }, None).map_err(|e|format!("The microphone could not be opened. Check Windows microphone access and try again. {e}"))
}
pub fn record(
    path: &Path,
    stop: &AtomicBool,
    mut meter: impl FnMut(f32, f64),
    mut pcm: impl FnMut(&[f32], u32),
) -> Result<()> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No microphone was found. Connect a microphone and try again.")?;
    let supported = device.default_input_config().map_err(|e|format!("The default microphone is unavailable. Choose a working default input in Windows Sound settings. {e}"))?;
    let config: cpal::StreamConfig = supported.into();
    if config.channels == 0 {
        return Err("The microphone has no input channels".into());
    }
    let (sender, receiver) = sync_channel::<Vec<f32>>(64);
    let failure = Arc::new(Mutex::new(None));
    let stream = match supported.sample_format() {
        SampleFormat::F32 => input_stream::<f32>(&device,&config,sender,failure.clone())?,
        SampleFormat::I16 => input_stream::<i16>(&device,&config,sender,failure.clone())?,
        SampleFormat::U16 => input_stream::<u16>(&device,&config,sender,failure.clone())?,
        other => return Err(format!("This microphone's {other} format is unsupported. Choose another default microphone in Windows.")),
    };
    let mut writer = hound::WavWriter::create(
        path,
        hound::WavSpec {
            channels: 1,
            sample_rate: config.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(io_error)?;
    stream.play().map_err(|e| {
        format!("The microphone could not start. Check microphone access in Windows Settings. {e}")
    })?;
    let started = Instant::now();
    let mut last_flush = Instant::now();
    let mut last_meter = Instant::now();
    let mut disk_error = None;
    while !stop.load(Ordering::Relaxed) {
        if failure.lock().map_err(io_error)?.is_some() {
            break;
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(samples) => {
                let mut energy = 0.0;
                for sample in &samples {
                    let sample = if sample.is_finite() {
                        sample.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    };
                    energy += sample * sample;
                    if let Err(e) = writer.write_sample((sample * 32767.0) as i16) {
                        disk_error = Some(io_error(e));
                        break;
                    }
                }
                if disk_error.is_some() {
                    break;
                }
                pcm(&samples, config.sample_rate);
                if last_meter.elapsed() >= Duration::from_millis(100) {
                    meter(
                        (energy / samples.len().max(1) as f32).sqrt(),
                        started.elapsed().as_secs_f64(),
                    );
                    last_meter = Instant::now();
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
            Err(_) => break,
        }
        if last_flush.elapsed() >= Duration::from_secs(1) {
            if let Err(e) = writer.flush() {
                disk_error = Some(io_error(e));
                break;
            }
            last_flush = Instant::now();
        }
    }
    drop(stream);
    // Drain the bounded queue after stopping the stream so the end of a sentence is retained.
    for samples in receiver.try_iter() {
        for sample in samples {
            if let Err(e) = writer.write_sample((sample.clamp(-1.0, 1.0) * 32767.0) as i16) {
                disk_error = Some(io_error(e));
                break;
            }
        }
        if disk_error.is_some() {
            break;
        }
    }
    writer.finalize().map_err(io_error)?;
    if let Some(error) = disk_error.or_else(|| failure.lock().ok().and_then(|mut v| v.take())) {
        return Err(error);
    }
    Ok(())
}

/// Publish a mono 16 kHz WAV without ever truncating the earlier recording.
pub fn append_recording(previous: Option<&Path>, segment: &Path, destination: &Path) -> Result<()> {
    let mut file =
        tempfile::NamedTempFile::new_in(destination.parent().ok_or("Invalid audio folder")?)
            .map_err(io_error)?;
    {
        let mut writer = hound::WavWriter::new(
            file.as_file_mut(),
            hound::WavSpec {
                channels: 1,
                sample_rate: 16000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .map_err(io_error)?;
        for path in previous.into_iter().chain(std::iter::once(segment)) {
            let mut reader = hound::WavReader::open(path).map_err(io_error)?;
            let spec = reader.spec();
            if spec.channels == 1
                && spec.sample_rate == 16000
                && spec.bits_per_sample == 16
                && spec.sample_format == hound::SampleFormat::Int
            {
                for sample in reader.samples::<i16>() {
                    writer
                        .write_sample(sample.map_err(io_error)?)
                        .map_err(io_error)?;
                }
            } else {
                for sample in crate::speech::read_audio(path)? {
                    writer
                        .write_sample((sample.clamp(-1.0, 1.0) * 32767.0) as i16)
                        .map_err(io_error)?;
                }
            }
        }
        writer.finalize().map_err(io_error)?;
    }
    file.as_file().sync_all().map_err(io_error)?;
    file.persist(destination).map_err(io_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn appended_takes_keep_both_segments_and_convert_to_16khz() {
        let dir = tempfile::tempdir().unwrap();
        let make = |name: &str, rate, value| {
            let path = dir.path().join(name);
            let mut writer = hound::WavWriter::create(
                &path,
                hound::WavSpec {
                    channels: 1,
                    sample_rate: rate,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .unwrap();
            for _ in 0..rate {
                writer.write_sample::<i16>(value).unwrap();
            }
            writer.finalize().unwrap();
            path
        };
        let old = make("old.wav", 16000, 4000);
        let new = make("new.wav", 48000, -5000);
        let output = dir.path().join("audio.wav");
        append_recording(Some(&old), &new, &output).unwrap();
        let mut reader = hound::WavReader::open(output).unwrap();
        assert_eq!(reader.spec().sample_rate, 16000);
        assert_eq!(reader.duration(), 32000);
        let samples: Vec<i16> = reader.samples().map(|s| s.unwrap()).collect();
        assert!(samples[..16000].iter().all(|s| *s == 4000));
        assert!(samples[16500..31500].iter().all(|s| *s < -4500));
    }
}
