<#
 .SYNOPSIS
  Builds the signed Android App Bundle (.aab) for Google Play (flavor "play": no in-app updater, no installer
  permission) and copies it to dist\play\.

 .EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-aab.ps1

 .NOTES
  Upload the .aab in Play Console > Testing / Production > Create new release. With Play App Signing the file is
  signed here with the UPLOAD key (mobile/android/key.properties + cocoffee-release.jks); Google re-signs it for users.
  Keep that keystore backed up outside this PC. Steps and store text: docs/chplay-submission.md.
  Flutter is run through the D:\flutter_sdk junction (the real path has a space that breaks Gradle's native hooks).
#>
param(
  [string]$Flutter = 'D:\flutter_sdk\bin\flutter.bat',
  [string]$GradleTmp = 'D:\tmp'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$mobile = Join-Path $root 'mobile'
$aab = Join-Path $mobile 'build\app\outputs\bundle\playRelease\app-play-release.aab'

if (-not (Test-Path (Join-Path $mobile 'android\key.properties'))) {
  throw 'mobile/android/key.properties not found: Google Play rejects a bundle signed with the debug key.'
}
New-Item -ItemType Directory -Force (Join-Path $GradleTmp 'uds') | Out-Null
$env:JAVA_TOOL_OPTIONS = "-Djdk.net.unixdomain.tmpdir=$GradleTmp\uds -Djava.io.tmpdir=$GradleTmp"
Push-Location $mobile
try {
  & $Flutter build appbundle --release --flavor play --dart-define=PLAY_STORE=true
  if ($LASTEXITCODE -ne 0) { throw "flutter build appbundle failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

if (-not (Test-Path $aab)) { throw "AAB not found: $aab" }
$ver = (Select-String -Path (Join-Path $mobile 'pubspec.yaml') -Pattern '^version:\s*(\S+)').Matches[0].Groups[1].Value -replace '\+', '-'
$out = Join-Path $root 'dist\play'
New-Item -ItemType Directory -Force $out | Out-Null
$dest = Join-Path $out "tasotek-fnb-$ver.aab"
Copy-Item $aab $dest -Force
Write-Host "AAB: $dest ($([math]::Round((Get-Item $dest).Length / 1MB, 1)) MB)"
