# Third-party components

Glassnote uses these open-source projects. Their license and attribution files are available with their source distributions:

- [Tauri](https://github.com/tauri-apps/tauri): MIT / Apache-2.0; WebView2 is supplied by Microsoft under its runtime terms.
- [whisper-rs](https://codeberg.org/tazz4843/whisper-rs): Unlicense; Rust bindings to whisper.cpp.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp): MIT.
- [OpenAI Whisper](https://github.com/openai/whisper): MIT, including model weights. The app downloads the `tiny.en` model converted and quantized by the [whisper.cpp model repository](https://huggingface.co/ggerganov/whisper.cpp).
- [XCap](https://github.com/nashaofu/xcap): Apache-2.0.
- [CPAL](https://github.com/RustAudio/cpal): Apache-2.0.
- [Rubato](https://github.com/HEnquist/rubato): MIT.
- [Hound](https://github.com/ruuda/hound): Apache-2.0.
- [zip](https://github.com/zip-rs/zip2): MIT; stored ZIP entries avoid compression work on screenshots and recordings.
- [egui-glass](https://github.com/heonny/egui-glass): MIT, copyright 2026 heonny. The overlay adapts the lens profile, sampling ring, vibrancy, and specular rim from `glass.wgsl` at commit `63b467e68327c54ad17dbc9550d306d2ea1d17cd` to WebGL2. Circular rounded-box geometry and CSS shadows replace the native renderer's geometry and shadows. One downsampled frozen texture is uploaded per capture, with redraws only when controls change or animate; there is no idle render loop. The capture menu can switch to opaque surfaces; unavailable WebGL uses CSS glass, and Windows high contrast uses system colors. The Rust egui/wgpu runtime is not bundled.
- [LLVM/libclang](https://pypi.org/project/libclang/18.1.1/): Apache-2.0 with LLVM exceptions; build dependency only, not shipped with Glassnote.

Additional Rust and JavaScript dependency versions are recorded in `src-tauri/Cargo.lock` and `package-lock.json`. Full upstream notices are included in `THIRD_PARTY_LICENSES.txt` beside the installed executable. Regenerate them after dependency changes with `node scripts/licenses.mjs`.

The JFK audio fixture used for local verification comes from the whisper.cpp samples directory and is not bundled in the app or installer.
