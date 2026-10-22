$ErrorActionPreference = 'Stop'
# libclang 18 predates Visual Studio 18 discovery. Pass the installed SDK paths explicitly.
$vsLocator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vsLocator)) { throw 'Install Visual Studio Build Tools with Desktop development with C++.' }
$vsInstall = & $vsLocator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vcVersion = Get-ChildItem -LiteralPath (Join-Path $vsInstall 'VC\Tools\MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Include'
$sdkVersion = Get-ChildItem -LiteralPath $sdkRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'ucrt\stdio.h') } | Sort-Object Name -Descending | Select-Object -First 1
if (!$vcVersion -or !$sdkVersion) { throw 'The Visual C++ headers and Windows SDK are required.' }
$vcInclude = Join-Path $vcVersion.FullName 'include'
$sdkInclude = $sdkVersion.FullName
$env:BINDGEN_EXTRA_CLANG_ARGS = "-isystem `"$vcInclude`" -isystem `"$sdkInclude\ucrt`" -isystem `"$sdkInclude\shared`" -isystem `"$sdkInclude\um`""
$workspace = Split-Path -Parent $PSScriptRoot
$toolDirectory = Join-Path $workspace '.tools\libclang'
$clangLibrary = Join-Path $toolDirectory 'native\libclang.dll'
if (Test-Path -LiteralPath $clangLibrary) { Write-Output 'Local libclang is ready.'; exit 0 }
$extractedLibrary = Join-Path $toolDirectory 'libclang-18.1.1.data\platlib\clang\native\libclang.dll'
if (Test-Path -LiteralPath $extractedLibrary) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $clangLibrary) -Force | Out-Null
    Copy-Item -LiteralPath $extractedLibrary -Destination $clangLibrary
    Write-Output 'Build-only libclang is ready.'
    exit 0
}
$url = 'https://files.pythonhosted.org/packages/0b/2d/3f480b1e1d31eb3d6de5e3ef641954e5c67430d5ac93b7fa7e07589576c7/libclang-18.1.1-py2.py3-none-win_amd64.whl'
$expectedHash = '4DD2D3B82FAB35E2BF9CA717D7B63AC990A3519C7E312F19FA8E86DCC712F7FB'
New-Item -ItemType Directory -Path $toolDirectory -Force | Out-Null
$archivePath = Join-Path $toolDirectory 'libclang.zip'
Invoke-WebRequest -Uri $url -OutFile $archivePath
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expectedHash) {
    Remove-Item -LiteralPath $archivePath
    throw 'The libclang download did not match its expected SHA-256 checksum.'
}
Expand-Archive -LiteralPath $archivePath -DestinationPath $toolDirectory -Force
Remove-Item -LiteralPath $archivePath
New-Item -ItemType Directory -Path (Split-Path -Parent $clangLibrary) -Force | Out-Null
Copy-Item -LiteralPath $extractedLibrary -Destination $clangLibrary
if (!(Test-Path -LiteralPath $clangLibrary)) { throw 'The libclang DLL was not found in the downloaded package.' }
Write-Output 'Build-only libclang is ready. It is not included in the app.'
