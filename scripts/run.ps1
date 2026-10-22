param([ValidateSet('dev','build','test','check','lint')][string]$Mode = 'dev')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'setup-build.ps1')
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$workspace = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $workspace
try {
    switch ($Mode) {
        'dev' { & npm.cmd exec tauri dev }
        'build' { & npm.cmd exec tauri build -- --bundles nsis }
        'test' { Push-Location -LiteralPath (Join-Path $workspace 'src-tauri'); try { & cargo test --locked --lib } finally { Pop-Location } }
        'lint' {
            Push-Location -LiteralPath (Join-Path $workspace 'src-tauri')
            try {
                & cargo fmt --check
                if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
                & cargo clippy --locked --lib --tests -- -D warnings
            } finally { Pop-Location }
        }
        'check' { Push-Location -LiteralPath (Join-Path $workspace 'src-tauri'); try { & cargo check --tests } finally { Pop-Location } }
    }
    exit $LASTEXITCODE
} finally { Pop-Location }
