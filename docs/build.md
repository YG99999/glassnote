# Build and test

Glassnote targets **Windows 11 x64**. There are no supported macOS or Linux builds.

Install Rust 1.90 or later with the MSVC toolchain, Node.js 22.12 or later,
Visual Studio Build Tools with **Desktop development with C++** and a Windows SDK,
CMake, and Microsoft Edge WebView2 Runtime.

```powershell
git clone https://github.com/YG99999/glassnote.git
cd glassnote
npm ci
npm run app:dev
```

## Checks

```powershell
npm run build
npm run test:rust
npm run lint:rust
npx playwright install chromium
npm run test:ui
```

UI checks drive the actual frontend with mocked Tauri IPC and synthetic demo
content. They exercise both themes, narrow windows, recording state changes,
annotations, save failures, project deletion, one-level subfolders, keyboard
navigation, stable text selection/scrolling, and the glass shader. Results and
screenshots go into ignored `test-results/`. They do not test a physical
microphone, native capture, Windows clipboard, or graphics-driver compatibility.
To use installed Edge instead of downloading Chromium:

```powershell
$env:GLASSNOTE_BROWSER_CHANNEL = 'msedge'
npm run test:ui
```

Rust checks use temporary libraries, never the normal user library. Build scripts
download a checksum-verified, build-only libclang DLL into `.tools/` and locate
installed Visual C++ and Windows SDK headers. No system LLVM or Python is needed.
Node, libclang, and the test browser are not shipped in the app.

To regenerate the original synthetic fixture and README images:

```powershell
node scripts/demo-image.mjs
$env:GLASSNOTE_SCREENSHOTS = '1'
npm run test:ui
```

## Installer

```powershell
npm run app:build
```

The executable is `src-tauri/target/release/glassnote.exe`; the per-user installer
is `src-tauri/target/release/bundle/nsis/Glassnote_0.1.1_x64-setup.exe`.
The installer creates a desktop capture shortcut. `glassnote.exe --capture`
starts capture directly. Open installed builds from Start or Explorer rather
than a packaged terminal that redirects AppData.

`GLASSNOTE_DATA_DIR` can point a verification instance at a separate test library.
Exit the running instance first: single-instance launches forward to that process.
Never use a real library for destructive development checks.

The verification example calls the production functions:

```powershell
& .\scripts\setup-build.ps1
cd src-tauri
cargo run --example verify -- download C:\test\ggml-tiny.en-q5_1.bin
cargo run --example verify -- transcribe C:\test\model.bin C:\test\audio.wav C:\test\reference.txt
cargo run --example verify -- live C:\test\model.bin C:\test\audio.wav
cargo run --example verify -- export C:\test\library C:\test\exports
```

## Release maintenance

Update the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json` together. Run the checks,
update `CHANGELOG.md`, and regenerate notices after dependency changes with
`node scripts/licenses.mjs`. Push a matching `vX.Y.Z` tag to build and publish
the installer and SHA-256 checksum through GitHub Actions. Main-branch builds
also keep the installer as a workflow artifact. Release builds are currently unsigned. The native speech engine uses a fixed
AVX2/FMA/F16C/BMI2 target instead of the build host's native instruction set;
a runtime check prevents loading it on unsupported CPUs.
