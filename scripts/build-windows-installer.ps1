<#
 .SYNOPSIS
  Builds the one-click Windows installer of POS Tasotek Server (desktop\): the Flutter manager, the web server, Node, ngrok and a
  portable MariaDB, staged into dist\win\POS-Tasotek-Server and packed with Inno Setup (or, without it, into a .zip with install.cmd).

 .EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-windows-installer.ps1 -MariaDbZip D:\downloads\mariadb-10.11.9-winx64.zip
  powershell -ExecutionPolicy Bypass -File scripts\build-windows-installer.ps1 -DownloadMariaDb        # fetches the official zip first
  powershell -ExecutionPolicy Bypass -File scripts\build-windows-installer.ps1 -SkipMariaDb            # stage everything else (testing)

 .NOTES
  MariaDB: the official Windows ZIP from https://archive.mariadb.org (the installer never changes it; GPLv2). Node: the node.exe of this PC.
  ngrok: the ngrok.exe of this PC (winget install ngrok.ngrok) or -NgrokExe. Inno Setup 6 (ISCC.exe) is optional.
  The server folder is `git archive HEAD` (commit first) with `npm ci --omit=dev`.
#>
param(
  [string]$MariaDbZip = '',
  [switch]$DownloadMariaDb,
  [switch]$SkipMariaDb,
  [string]$MariaDbUrl = 'https://archive.mariadb.org/mariadb-10.11.9/winx64-packages/mariadb-10.11.9-winx64.zip',
  [string]$NgrokExe = '',
  [string]$Flutter = 'D:\flutter_sdk\bin\flutter.bat',
  [string]$Iscc = '',
  [string]$Version = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $root 'desktop'
$out = Join-Path $root 'dist\win'
$stage = Join-Path $out 'POS-Tasotek-Server'
if (-not $Version) { $Version = ((Select-String -Path (Join-Path $desktop 'pubspec.yaml') -Pattern '^version:\s*(\S+)').Matches[0].Groups[1].Value -split '\+')[0] }
# the release is named without a zero patch (pubspec 1.2.0 -> Setup-1.2.exe); the manager's updater compares 1.2 == 1.2.0
$Version = $Version -replace '^(\d+\.\d+)\.0$', '$1'

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

Step "Cleaning $stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

Step 'Building the Flutter manager (windows release)'
Push-Location $desktop
try {
  & $Flutter build windows --release
  if ($LASTEXITCODE -ne 0) { throw "flutter build windows failed ($LASTEXITCODE)" }
} finally { Pop-Location }
Copy-Item -Recurse (Join-Path $desktop 'build\windows\x64\runner\Release') (Join-Path $stage 'manager')

Step 'Staging the web server (git archive HEAD + npm ci --omit=dev)'
$server = Join-Path $stage 'server'
New-Item -ItemType Directory -Force $server | Out-Null
$zip = Join-Path $out 'server-src.zip'
Push-Location $root
try { & git archive --format=zip -o $zip HEAD } finally { Pop-Location }
Expand-Archive -Force $zip $server
Remove-Item $zip
# the Android / iOS releases are served by the cloud site, not by the shop box
Remove-Item -Recurse -Force (Join-Path $server 'releases') -ErrorAction SilentlyContinue
Push-Location $server
try {
  & npm ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
} finally { Pop-Location }

Step 'Node.js runtime'
$nodeDir = Join-Path $stage 'runtime\node'
New-Item -ItemType Directory -Force $nodeDir | Out-Null
Copy-Item (Get-Command node).Source (Join-Path $nodeDir 'node.exe')

Step 'ngrok'
$ngrokDir = Join-Path $stage 'runtime\ngrok'
New-Item -ItemType Directory -Force $ngrokDir | Out-Null
if (-not $NgrokExe) { $c = Get-Command ngrok -ErrorAction SilentlyContinue; if ($c) { $NgrokExe = $c.Source } }
if ($NgrokExe -and (Test-Path $NgrokExe)) { Copy-Item $NgrokExe (Join-Path $ngrokDir 'ngrok.exe') }
else { Write-Warning 'ngrok.exe not found: the installer will have no public address until it is added (winget install ngrok.ngrok, or -NgrokExe).' }

Step 'MariaDB (portable)'
if ($SkipMariaDb) {
  Write-Warning 'MariaDB skipped (-SkipMariaDb): this is a test stage, the local database will not work.'
} else {
  if (-not $MariaDbZip) {
    if (-not $DownloadMariaDb) { throw 'Pass -MariaDbZip <path to mariadb-*-winx64.zip>, or -DownloadMariaDb to fetch it from archive.mariadb.org, or -SkipMariaDb.' }
    $MariaDbZip = Join-Path $out 'mariadb.zip'
    Write-Host "    downloading $MariaDbUrl"
    New-Item -ItemType Directory -Force $out | Out-Null
    Invoke-WebRequest -Uri $MariaDbUrl -OutFile $MariaDbZip -UseBasicParsing
  }
  $tmp = Join-Path $out 'mariadb-extract'
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive -Force $MariaDbZip $tmp
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  $dst = Join-Path $stage 'runtime\mariadb'
  New-Item -ItemType Directory -Force $dst | Out-Null
  foreach ($d in 'bin', 'lib', 'share') { if (Test-Path (Join-Path $inner.FullName $d)) { Copy-Item -Recurse (Join-Path $inner.FullName $d) $dst } }
  Remove-Item -Recurse -Force $tmp
  # the shop box never needs the test suite, headers or docs
  foreach ($junk in 'bin\mariadb-test.exe', 'bin\mysqltest.exe', 'bin\mariadb-test-embedded.exe', 'bin\mysql_embedded.exe') { Remove-Item -Force (Join-Path $dst $junk) -ErrorAction SilentlyContinue }
  if (-not (Test-Path (Join-Path $dst 'bin\mariadbd.exe'))) { throw 'The MariaDB zip has no bin\mariadbd.exe: wrong archive?' }
}

Step 'Installer'
Copy-Item (Join-Path $desktop 'installer\install.cmd') $stage -ErrorAction SilentlyContinue
$iss = Join-Path $desktop 'installer\pos-tasotek.iss'
if (-not $Iscc) {
  foreach ($c in "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") { if (Test-Path $c) { $Iscc = $c; break } }
}
if ($Iscc -and (Test-Path $Iscc)) {
  & $Iscc "/DAppVersion=$Version" "/DStageDir=$stage" "/DOutDir=$out" $iss
  if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)" }
  Write-Host "Installer: $out\POS-Tasotek-Server-Setup-$Version.exe" -ForegroundColor Green
} else {
  $pack = Join-Path $out "POS-Tasotek-Server-$Version-portable.zip"
  if (Test-Path $pack) { Remove-Item $pack }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $pack
  Write-Warning "Inno Setup (ISCC.exe) not found: wrote the portable package $pack. Unzip it and run install.cmd as administrator, or install Inno Setup 6 and run this script again for the one-click Setup.exe."
}
