# setup-python-env.ps1 — provision philont's managed Python virtualenv (Windows).
#
# Creates a dedicated venv, installs requirements.txt into it, and persists
# PHILONT_PYTHON so the shell / z3 / document tools always use this interpreter
# instead of pip-installing at runtime.
#
# Usage:
#   pwsh scripts/setup-python-env.ps1                 # create / update the venv
#   $env:PHILONT_PYENV_DIR = "D:\philont\pyenv"; ...  # override the venv location
#
# Idempotent: re-running reuses an existing venv and just re-installs deps.

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Requirements = Join-Path $RepoRoot "requirements.txt"
if (-not (Test-Path $Requirements)) {
    Write-Error "requirements.txt not found at $Requirements"
    exit 1
}

# Resolve the venv directory (default: %USERPROFILE%\.philont\pyenv — next to philont's data dir).
$VenvDir = if ($env:PHILONT_PYENV_DIR) { $env:PHILONT_PYENV_DIR } else { Join-Path $env:USERPROFILE ".philont\pyenv" }
$PhilontHome = Split-Path -Parent $VenvDir

# Find a base Python 3 interpreter to build the venv from.
function Find-BasePython {
    $candidates = @(
        @{ exe = "py";      args = @("-3") },
        @{ exe = "python";  args = @() },
        @{ exe = "python3"; args = @() }
    )
    foreach ($c in $candidates) {
        try {
            $v = & $c.exe @($c.args + @("--version")) 2>&1
            if ($LASTEXITCODE -eq 0 -and "$v" -match "Python 3") {
                return ,@($c.exe) + $c.args
            }
        } catch { }
    }
    return $null
}

$BasePython = Find-BasePython
if (-not $BasePython) {
    Write-Error "No Python 3 found. Install Python 3.9+ (https://www.python.org/downloads/, tick 'Add to PATH') and re-run."
    exit 1
}
Write-Host "[setup] base python: $($BasePython -join ' ')"

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (Test-Path $VenvPython) {
    Write-Host "[setup] reusing existing venv at $VenvDir"
} else {
    Write-Host "[setup] creating venv at $VenvDir"
    & $BasePython[0] @($BasePython[1..($BasePython.Length-1)] + @("-m", "venv", $VenvDir))
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VenvPython)) {
        Write-Error "venv creation failed. Ensure the Python install includes venv (standard on python.org builds)."
        exit 1
    }
}

Write-Host "[setup] upgrading pip"
& $VenvPython -m pip install --upgrade pip --quiet

Write-Host "[setup] installing requirements (this is the only time deps install — runtime never pip-installs)"
& $VenvPython -m pip install -r $Requirements
if ($LASTEXITCODE -ne 0) {
    Write-Error "pip install failed. See output above."
    exit 1
}

# Persist PHILONT_PYTHON for future processes, and write a machine-readable hook for the launcher.
$VenvPythonResolved = (Resolve-Path $VenvPython).Path
setx PHILONT_PYTHON "$VenvPythonResolved" | Out-Null
New-Item -ItemType Directory -Force -Path $PhilontHome | Out-Null
$Manifest = @{
    pythonPath  = $VenvPythonResolved
    venvDir     = (Resolve-Path $VenvDir).Path
    requirements = (Resolve-Path $Requirements).Path
    updatedAt   = (Get-Date).ToString("o")
} | ConvertTo-Json
Set-Content -Path (Join-Path $PhilontHome "python-env.json") -Value $Manifest -Encoding UTF8

Write-Host ""
Write-Host "[setup] done."
Write-Host "  PHILONT_PYTHON = $VenvPythonResolved"
Write-Host "  (persisted via setx — restart philont / your terminal to pick it up)"
Write-Host "  For the current session:  `$env:PHILONT_PYTHON = `"$VenvPythonResolved`""
