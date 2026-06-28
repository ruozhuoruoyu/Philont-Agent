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

# Disable console QuickEdit mode. Otherwise a click / text-selection in this window PAUSES console output;
# the launcher's stdout write then blocks, it stops draining the agent's stdout pipe, the pipe buffer fills,
# and the agent's own stdout write blocks -> the WHOLE agent event loop freezes (autonomous loop + the
# in-flight turn) until a key is pressed. Observed in the wild as a turn "hanging" for hours. Disabling
# QuickEdit makes a click never pause output. Best-effort; non-fatal if it fails.
try {
    if (-not ([System.Management.Automation.PSTypeName]'Win32.PhilontConsole').Type) {
        Add-Type -Name PhilontConsole -Namespace Win32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr GetStdHandle(int handle);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(System.IntPtr handle, out uint mode);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(System.IntPtr handle, uint mode);
'@
    }
    $stdin = [Win32.PhilontConsole]::GetStdHandle(-10)  # STD_INPUT_HANDLE
    $mode = 0
    if ([Win32.PhilontConsole]::GetConsoleMode($stdin, [ref]$mode)) {
        $QUICK_EDIT = 0x40
        $EXTENDED_FLAGS = 0x80
        $newMode = ($mode -band (-bnot $QUICK_EDIT)) -bor $EXTENDED_FLAGS
        [void][Win32.PhilontConsole]::SetConsoleMode($stdin, $newMode)
        Write-Host "Console QuickEdit disabled (a click no longer freezes the agent)." -ForegroundColor DarkGray
    }
} catch {
    Write-Host "Could not disable console QuickEdit (non-fatal): $_" -ForegroundColor DarkGray
}

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
