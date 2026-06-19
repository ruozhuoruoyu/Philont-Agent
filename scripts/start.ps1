# Start philont: launch only (no auto-build).
#
# The launcher serves the web UI (localhost:20267), opens your browser to the
# setup wizard (fill in API key etc.), and supervises the agent process.
#
# Run .\scripts\build-all.ps1 first (or after a git pull) to (re)build.
#
# (ASCII-only on purpose: PowerShell 5 on a zh-CN console misreads UTF-8.)

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))

if (-not (Test-Path 'launcher/dist/index.js') -or -not (Test-Path 'web-ui/dist')) {
    Write-Host "Build output missing (launcher/dist or web-ui/dist). Run .\scripts\build-all.ps1 first." -ForegroundColor Red
    exit 1
}

# Make the managed Python interpreter available to philont (document / z3 tools).
# setx only reaches new shells; loading from the manifest guarantees this launch
# has it regardless of when the env var propagates.
if (-not $env:PHILONT_PYTHON) {
    $manifest = Join-Path $env:USERPROFILE '.philont\python-env.json'
    if (Test-Path $manifest) {
        try {
            $pp = (Get-Content $manifest -Raw | ConvertFrom-Json).pythonPath
            if ($pp -and (Test-Path $pp)) {
                $env:PHILONT_PYTHON = $pp
                Write-Host "Using managed Python: $pp" -ForegroundColor DarkGray
            }
        } catch { }
    }
}

Write-Host "Starting launcher (serves web UI + supervises agent + opens browser; Ctrl+C to exit)..." -ForegroundColor Green
node launcher/dist/index.js
