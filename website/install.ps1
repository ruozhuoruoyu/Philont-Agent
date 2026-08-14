# Philont Windows installer.
# Designed for Windows PowerShell 5.1 and later; keep this file ASCII-only.

[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Philont'),
    [string]$Ref = 'main',
    [switch]$NoLaunch,
    [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$NodeVersion = '24.16.0'
$Repository = 'ruozhuoruoyu/Philont-Agent'

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Assert-SafeInstallPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $root = [IO.Path]::GetPathRoot($full).TrimEnd('\')
    if (-not $full -or $full -eq $root -or $full -eq $env:USERPROFILE.TrimEnd('\')) {
        throw "Refusing unsafe install directory: $full"
    }
    return $full
}

function Invoke-Download([string]$Uri, [string]$OutFile) {
    $params = @{ Uri = $Uri; OutFile = $OutFile; UseBasicParsing = $true }
    Invoke-WebRequest @params
}

function Test-LauncherRunning {
    try {
        $null = Invoke-RestMethod -Uri 'http://127.0.0.1:20267/api/launcher/status' -TimeoutSec 2
        return $true
    } catch {
        return $false
    }
}

if ($env:OS -ne 'Windows_NT') {
    throw 'This installer is for Windows. Use scripts/start.sh on macOS or Linux.'
}
if ($Ref -notmatch '^[A-Za-z0-9._/-]+$' -or $Ref.Contains('..')) {
    throw "Invalid Git ref: $Ref"
}

$InstallDir = Assert-SafeInstallPath $InstallDir
$parentDir = Split-Path -Parent $InstallDir
$leaf = Split-Path -Leaf $InstallDir
$workDir = Join-Path $parentDir ('.philont-install-' + [Guid]::NewGuid().ToString('N'))
$stageDir = Join-Path $workDir 'stage'
$nodeZip = Join-Path $workDir 'node.zip'
$sourceZip = Join-Path $workDir 'source.zip'
$backupDir = Join-Path $parentDir ($leaf + '.previous')
$oldInstallMoved = $false
$newInstallPlaced = $false

try {
    New-Item -ItemType Directory -Force -Path $parentDir, $workDir | Out-Null

    if ((Test-Path $InstallDir) -and (Test-LauncherRunning)) {
        throw "Philont is running. Stop its launcher window, then run the installer again."
    }

    $arch = if ([Environment]::Is64BitOperatingSystem) {
        if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    } else {
        throw 'Philont requires 64-bit Windows.'
    }

    Write-Step "Downloading portable Node.js $NodeVersion ($arch)"
    $nodeFile = "node-v$NodeVersion-win-$arch.zip"
    $nodeBase = "https://nodejs.org/dist/v$NodeVersion"
    Invoke-Download "$nodeBase/$nodeFile" $nodeZip
    $checksums = (Invoke-WebRequest -Uri "$nodeBase/SHASUMS256.txt" -UseBasicParsing).Content
    $expectedLine = ($checksums -split "`n" | Where-Object { $_.Trim() -match ([regex]::Escape($nodeFile) + '$') } | Select-Object -First 1)
    if (-not $expectedLine) { throw "Node.js checksum not found for $nodeFile" }
    $expectedHash = ($expectedLine.Trim() -split '\s+')[0].ToLowerInvariant()
    $actualHash = (Get-FileHash -Algorithm SHA256 $nodeZip).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw 'Node.js archive checksum verification failed.' }

    Expand-Archive -Path $nodeZip -DestinationPath (Join-Path $workDir 'node-extract')
    $nodeDir = Join-Path $workDir "node-extract\node-v$NodeVersion-win-$arch"
    if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) { throw 'Portable Node.js extraction failed.' }

    Write-Step "Downloading Philont ($Ref)"
    $escapedRef = [Uri]::EscapeDataString($Ref).Replace('%2F', '/')
    Invoke-Download "https://github.com/$Repository/archive/$escapedRef.zip" $sourceZip
    Expand-Archive -Path $sourceZip -DestinationPath (Join-Path $workDir 'source-extract')
    $sourceDir = Get-ChildItem (Join-Path $workDir 'source-extract') -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'scripts\build-all.ps1') } |
        Select-Object -First 1
    if (-not $sourceDir) { throw 'Philont source archive did not contain scripts\build-all.ps1.' }
    Move-Item $sourceDir.FullName $stageDir

    $runtimeDir = Join-Path $stageDir 'runtime\node'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimeDir) | Out-Null
    Move-Item $nodeDir $runtimeDir

    # npm uses directory junctions for local file: dependencies on Windows.
    # Build at the final path so those junctions never point back into a deleted
    # staging directory. Keep the prior install until the full build succeeds.
    Write-Step "Installing files to $InstallDir"
    if (Test-Path $backupDir) { Remove-Item -LiteralPath $backupDir -Recurse -Force }
    if (Test-Path $InstallDir) {
        Move-Item -LiteralPath $InstallDir -Destination $backupDir
        $oldInstallMoved = $true
    }
    Move-Item -LiteralPath $stageDir -Destination $InstallDir
    $newInstallPlaced = $true

    $runtimeDir = Join-Path $InstallDir 'runtime\node'
    $env:PATH = "$runtimeDir;$env:PATH"

    Write-Step 'Building Philont'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'scripts\build-all.ps1')
    if ($LASTEXITCODE -ne 0) { throw "Philont build failed with exit code $LASTEXITCODE." }

    $launcher = Join-Path $InstallDir 'launcher\dist\index.js'
    $webUi = Join-Path $InstallDir 'web-ui\dist\index.html'
    if (-not (Test-Path $launcher) -or -not (Test-Path $webUi)) {
        throw 'Build completed without the launcher or Web UI output.'
    }

    $cmd = @'
@echo off
setlocal
set "PATH=%~dp0runtime\node;%PATH%"
cd /d "%~dp0"
"%~dp0runtime\node\node.exe" "%~dp0launcher\dist\index.js"
'@
    Set-Content -Path (Join-Path $InstallDir 'Philont.cmd') -Value $cmd -Encoding Ascii

    if (-not $NoShortcut) {
        Write-Step 'Creating Start menu shortcut'
        try {
            $programs = [Environment]::GetFolderPath('Programs')
            $shortcutDir = Join-Path $programs 'Philont'
            New-Item -ItemType Directory -Force -Path $shortcutDir | Out-Null
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut((Join-Path $shortcutDir 'Philont.lnk'))
            $shortcut.TargetPath = Join-Path $InstallDir 'Philont.cmd'
            $shortcut.WorkingDirectory = $InstallDir
            $shortcut.Description = 'Start Philont'
            $shortcut.Save()
        } catch {
            Write-Host "WARN: Start menu shortcut was not created: $_" -ForegroundColor Yellow
        }
    }

    if (Test-Path $backupDir) { Remove-Item -LiteralPath $backupDir -Recurse -Force }

    Write-Host "`nPhilont is installed." -ForegroundColor Green
    Write-Host "Program: $InstallDir"
    Write-Host "Data:    $(Join-Path $env:USERPROFILE '.philont')"
    Write-Host 'The setup page will ask for your model endpoint and API key.'

    if (-not $NoLaunch) {
        Start-Process -FilePath (Join-Path $InstallDir 'Philont.cmd') -WorkingDirectory $InstallDir
    }
} catch {
    if ($newInstallPlaced -and (Test-Path $InstallDir)) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($oldInstallMoved -and (Test-Path $backupDir) -and -not (Test-Path $InstallDir)) {
        Move-Item -LiteralPath $backupDir -Destination $InstallDir
    }
    Write-Host "`nInstallation failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'The previous installation, if any, has been restored.' -ForegroundColor Yellow
    throw
} finally {
    if (Test-Path $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue }
}
