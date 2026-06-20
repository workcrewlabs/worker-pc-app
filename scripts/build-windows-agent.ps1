$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$agent = Join-Path $root "python\windows-agent"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python 3.12 or newer is required to build the WorkCrew Windows helper."
}

Push-Location $agent
try {
    python -m venv .venv
    & ".venv\Scripts\python.exe" -m pip install --upgrade pip
    & ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    & ".venv\Scripts\python.exe" -m unittest test_agent.py
    & ".venv\Scripts\pyinstaller.exe" --clean --noconfirm workcrew-windows-agent.spec
    Write-Host "Built helper: $agent\dist\workcrew-windows-agent.exe"
} finally {
    Pop-Location
}
