<#
  test-update-locally.ps1

  See the in-app auto-update work from start to finish WITHOUT uploading anything
  to GitHub, by using THIS computer as a stand-in update server.

  Why: a real update needs two real builds (the app only updates to a higher
  version number). This lets you make both versions and watch the update happen
  locally, so you skip the slow GitHub upload while testing.

  One-time before you start: merge your branch into main so the build contains the
  latest code (including the corrected auto-update).

  Run these from the repo root (D:\worker pc app), in order:

    1) .\scripts\test-update-locally.ps1 -Version 0.1.0
       Then install apps\desktop\dist\WorkCrew-Setup-0.1.0.exe and open it once.

    2) .\scripts\test-update-locally.ps1 -Version 0.1.1 -SkipAppBuild
       Builds a NEWER version into the dist folder. Do NOT install this one.

    3) .\scripts\test-update-locally.ps1 -Serve
       Starts the local update server and leaves it running. Now open the app you
       installed in step 1: within a few seconds it finds 0.1.1, downloads it, and
       shows "Restart to update". Click it; the app reopens as 0.1.1. Done.

  When finished, press Ctrl+C to stop the server. Nothing here touches GitHub, and
  your real package.json is left untouched (the test settings are applied only for
  the duration of each build and then restored).
#>
param(
  [string]$Version = "0.1.0",
  [int]$Port = 8080,
  [switch]$SkipAppBuild,
  [switch]$Serve
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

if ($Serve) {
  Write-Host "Serving update files at http://localhost:$Port  (press Ctrl+C to stop)" -ForegroundColor Cyan
  py -m http.server $Port --directory "apps/desktop/dist"
  return
}

$pkgFull = Join-Path $root "apps/desktop/package.json"
$backup = [IO.File]::ReadAllText($pkgFull)
try {
  Write-Host "Pointing this test build at http://localhost:$Port (instead of GitHub)" -ForegroundColor Cyan
  node -e "const f='apps/desktop/package.json';const fs=require('fs');const p=JSON.parse(fs.readFileSync(f));p.build.publish=[{provider:'generic',url:'http://localhost:$Port'}];fs.writeFileSync(f,JSON.stringify(p,null,2));"

  if (-not $SkipAppBuild -or -not (Test-Path "apps/desktop/out/main/index.js")) {
    Write-Host "Building the Windows helper..." -ForegroundColor Cyan
    npm run build:helper -w @workcrew/desktop
    Write-Host "Building the app..." -ForegroundColor Cyan
    npm run build -w @workcrew/desktop
  }

  Write-Host "Packaging version $Version ..." -ForegroundColor Cyan
  Push-Location "apps/desktop"
  try {
    npx electron-builder --win nsis -c.extraMetadata.version=$Version
  } finally {
    Pop-Location
  }
}
finally {
  # Always restore the real package.json (GitHub publish settings, real version).
  [IO.File]::WriteAllText($pkgFull, $backup)
}

Write-Host ""
Write-Host "Built: apps\desktop\dist\WorkCrew-Setup-$Version.exe" -ForegroundColor Green
