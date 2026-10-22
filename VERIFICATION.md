# Verification

Checked on Windows 11 x64, Intel Core i7-1270P, CPU transcription, October 22, 2026.

## Automated checks

- **19 Rust tests** cover scaled/reversed/invalid crops, secondary-monitor coordinate
  conversion, annotation validation, atomic persistence and restart recovery,
  appended/interrupted recordings, transcript linkage, safe names, export links,
  optional audio/annotations, duplicate destinations, resampling, and silence.
- Project tests cover automatic sibling numbering, one-level creation, rename
  rejection, migration, scoped deletion, and unchanged capture links.
- TypeScript/Vite production build, Rust formatting, and Clippy with warnings denied.
- Headless browser checks run the real frontend with mocked native IPC: light/dark
  and minimum-width layouts, collapsible folders and keyboard navigation,
  save failure/retry, numbered note dictation, append, project sharing/deletion,
  stable text selection/scrolling, frozen screenshot handoff, and normal/reduced motion.
- The actual WebGL2 shader is exercised on synthetic, white, and near-black
  backgrounds. It stops drawing when controls are idle.

Run these checks using [the build guide](docs/build.md). They are not a substitute
for native Windows hardware testing.

## Real speech and native checks

The 32,166,155-byte tiny.en q5_1 model's download matched SHA-256
`c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b`.
The production decoder transcribed the official 11-second whisper.cpp JFK fixture
in **0.73 seconds**, with **0% word error rate on its 22-word reference**.
A paced stream produced the first partial at **2.11 seconds**, refreshed roughly
every **1.5 seconds**, and finalized **0.73 seconds** after Stop.
These are one clear sample on one laptop, not a general accuracy or latency claim.
The measurement used a debug Rust wrapper with the optimized native speech engine.

Earlier hands-on native checks covered region capture, frozen backdrop, physical
crop dimensions, microphone activity, retained mono 16 kHz WAV, Stop/transcription,
editable text, inline numbered notes, annotation PNGs, hotkeys, repeated launches,
cancellation, tray behavior, and recovery. Quiet audio producing punctuation alone
was rejected by the production decoder while preserving the recording.

The per-user installer and Explorer launch were checked. Updates were validated
against backups with SHA-256 media/model preservation checks and unchanged project
selection. No real user data or verification recordings are included in this repo.

## Remaining hardware coverage

The test laptop had one display. Mixed-DPI multi-monitor hardware, microphone
unplugging mid-recording, the latest native clipboard/ZIP picker, all latest tray
menu actions, and a physically disconnected network have not been manually
exercised. Recent frontend timing and glass changes have browser coverage rather
than a new hands-on graphics-driver check. Transcription uses local files and
makes no cloud inference requests.
