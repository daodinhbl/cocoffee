<#
 .SYNOPSIS
  Builds the signed release APK of the Flutter app (mobile/) and publishes it to releases/android/, which the
  server offers at /download (QR code on the login page). Then deploy: node scripts/package-deploy.js.

 .EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1            # build + publish
  powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1 -SkipBuild # publish the APK already in mobile/build

 .NOTES
  Flutter is run through the D:\flutter_sdk junction (the real SDK path contains a space, which breaks Gradle's
  native-asset hooks) and Gradle gets its temp dirs on D:\ (see mobile/CONVENTIONS.md). Release signing needs
  mobile/android/key.properties + the keystore it names; without them the APK is signed with the debug key.
#>
param(
  [switch]$SkipBuild,
  [string]$Flutter = 'D:\flutter_sdk\bin\flutter.bat',
  [string]$GradleTmp = 'D:\tmp'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$mobile = Join-Path $root 'mobile'
$apk = Join-Path $mobile 'build\app\outputs\flutter-apk\app-direct-release.apk'   # flavor "direct" = the APK offered at /download (the Google Play build is scripts\build-aab.ps1)

if (-not $SkipBuild) {
  if (-not (Test-Path (Join-Path $mobile 'android\key.properties'))) {
    Write-Warning 'mobile/android/key.properties not found: the APK will be signed with the DEBUG key and cannot update a release-signed install.'
  }
  New-Item -ItemType Directory -Force (Join-Path $GradleTmp 'uds') | Out-Null
  $env:JAVA_TOOL_OPTIONS = "-Djdk.net.unixdomain.tmpdir=$GradleTmp\uds -Djava.io.tmpdir=$GradleTmp"
  Push-Location $mobile
  try {
    & $Flutter build apk --release --flavor direct
    if ($LASTEXITCODE -ne 0) { throw "flutter build apk failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }
}

if (-not (Test-Path $apk)) { throw "APK not found: $apk" }
& node (Join-Path $root 'scripts\publish-apk.js') $apk
if ($LASTEXITCODE -ne 0) { throw 'scripts/publish-apk.js failed' }
