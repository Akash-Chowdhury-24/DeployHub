# DeployHub install script for Windows
# Author: Akash Chowdhury - canonical source: src/utils/author.js
# Repository: https://github.com/Akash-Chowdhury-24/DeployHub
#
# IMPORTANT: PowerShell variable names are CASE-INSENSITIVE.
# Never use $BinaryName / $binaryName as two different values - the second write
# overwrites the first (that bug previously saved deployhub-win.exe instead of deployhub.exe).

$ErrorActionPreference = "Stop"

$GitHubRepo = "Akash-Chowdhury-24/DeployHub"
# Filename on disk after install (what PATH resolves as `deployhub`)
$InstalledExeName = "deployhub.exe"
# GitHub Release asset name for Windows x64
$ReleaseAssetName = "deployhub-win.exe"
$NpmPackage = "@akash-chowdhury-24/deployhub"

function Get-LatestVersion {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GitHubRepo/releases/latest"
    return $release.tag_name
}

function Get-InstallDir {
    $localBin = Join-Path $env:LOCALAPPDATA "Programs\DeployHub"
    if (-not (Test-Path $localBin)) {
        New-Item -ItemType Directory -Path $localBin -Force | Out-Null
    }
    return $localBin
}

function Refresh-SessionPathFromPersistent {
    # Rebuild PATH the way a NEW PowerShell window would see it after our User PATH edit.
    # Do NOT prepend the install dir here - that would hide npm-global collisions
    # (user PATH appends DeployHub at the end; npm often wins earlier in PATH).
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($machinePath -and $userPath) {
        $env:Path = "$machinePath;$userPath"
    } elseif ($userPath) {
        $env:Path = $userPath
    } elseif ($machinePath) {
        $env:Path = $machinePath
    }
}

function Add-ToPath {
    param([string]$Dir)
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$Dir*") {
        if ([string]::IsNullOrWhiteSpace($userPath)) {
            [Environment]::SetEnvironmentVariable("Path", $Dir, "User")
        } else {
            [Environment]::SetEnvironmentVariable("Path", "$userPath;$Dir", "User")
        }
        Write-Host "Added $Dir to user PATH"
    }
    Refresh-SessionPathFromPersistent
}

function Get-VersionFromOutput {
    param([string]$Output)
    if ([string]::IsNullOrWhiteSpace($Output)) { return $null }
    $line = ($Output -split "`r?`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
    if (-not $line) { return $null }
    if ($line -match '(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)') {
        return $Matches[1]
    }
    return $line.Trim()
}

function Warn-PathCollision {
    param(
        [string]$InstallDir,
        [string]$InstalledExe,
        [string]$ExpectedTag
    )

    $expectedVersion = $ExpectedTag.TrimStart('v')
    $directOut = & $InstalledExe --version 2>&1 | Out-String
    $directVersion = Get-VersionFromOutput $directOut

    Write-Host ""
    Write-Host "Installed binary reports: $(if ($directVersion) { $directVersion } else { '(unknown)' }) ($InstalledExe)"

    # Re-sync PATH from Machine+User so this check matches a freshly opened shell.
    Refresh-SessionPathFromPersistent

    $resolved = $null
    try {
        $resolved = Get-Command deployhub -ErrorAction Stop
    } catch {
        Write-Host "Note: 'deployhub' is not yet visible on PATH in this session." -ForegroundColor Yellow
        Write-Host "Open a NEW PowerShell window, then run: deployhub --version" -ForegroundColor Yellow
        return
    }

    $resolvedPath = $resolved.Source
    # Prefer .exe over .cmd/.ps1 shims when comparing versions of what PATH runs
    $pathOut = & deployhub --version 2>&1 | Out-String
    $pathVersion = Get-VersionFromOutput $pathOut

    $installedFull = [System.IO.Path]::GetFullPath($InstalledExe)
    $resolvedFull = [System.IO.Path]::GetFullPath($resolvedPath)

    # npm global on Windows resolves to deployhub.cmd / deployhub.ps1, not our .exe
    $sameFile = ($installedFull -ieq $resolvedFull)
    $versionMatch = $pathVersion -and $expectedVersion -and ($pathVersion -eq $expectedVersion)

    if ($sameFile -and $versionMatch) {
        Write-Host "PATH resolves to the newly installed binary ($pathVersion). OK."
        Write-Host "Still open a NEW PowerShell window before day-to-day use so user PATH updates apply cleanly."
        return
    }

    if ((-not $sameFile) -or (-not $versionMatch)) {
        Write-Host ""
        Write-Host "WARNING: Installed DeployHub $expectedVersion to $InstallDir," -ForegroundColor Yellow
        Write-Host "  but running 'deployhub --version' currently resolves to a DIFFERENT" -ForegroundColor Yellow
        Write-Host "  installation reporting a different version (or path)." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  Expected:  $installedFull  ($expectedVersion)"
        Write-Host "  Resolved:  $resolvedFull  ($(if ($pathVersion) { $pathVersion } else { 'unknown version' }))"
        Write-Host ""
        Write-Host "  This usually means an older install (e.g. via 'npm install -g') is earlier in your PATH."
        Write-Host ""
        Write-Host "  To see every 'deployhub' on your PATH, run:"
        Write-Host "    Get-Command deployhub -All"
        Write-Host ""
        Write-Host "  To remove a conflicting npm install:"
        Write-Host "    npm uninstall -g $NpmPackage"
        Write-Host ""
        Write-Host "  Or reorder your PATH so $InstallDir comes first."
        Write-Host ""
        Write-Host "  This check rebuilds PATH from your saved Machine+User environment" -ForegroundColor Yellow
        Write-Host "  (same order a NEW PowerShell window would use). After fixing PATH," -ForegroundColor Yellow
        Write-Host "  open a NEW window and run: deployhub --version" -ForegroundColor Yellow
    }
}

try {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq "ARM64") {
        Write-Host "Windows ARM64 detected - no native binary available yet. Installing via npm instead..."
        npm install -g "$NpmPackage@latest"
        exit 0
    }

    $version = Get-LatestVersion
    $url = "https://github.com/$GitHubRepo/releases/download/$version/$ReleaseAssetName"
    $installDir = Get-InstallDir
    $dest = Join-Path $installDir $InstalledExeName

    Write-Host "Downloading DeployHub $version for Windows ($ReleaseAssetName -> $InstalledExeName)..."
    # Download to a temp name first, then rename - avoids leaving a half-written deployhub.exe
    $tmpDest = Join-Path $installDir ("deployhub-download-" + [guid]::NewGuid().ToString("n") + ".exe")
    try {
        Invoke-WebRequest -Uri $url -OutFile $tmpDest -UseBasicParsing
        if (-not (Test-Path $tmpDest) -or (Get-Item $tmpDest).Length -eq 0) {
            throw "Binary download failed"
        }
        # Remove any legacy misnamed asset from older install.ps1 (PowerShell case-bug).
        $legacy = Join-Path $installDir $ReleaseAssetName
        if (Test-Path $legacy) {
            Remove-Item -Force $legacy -ErrorAction SilentlyContinue
        }
        Move-Item -Force -Path $tmpDest -Destination $dest
    } finally {
        if (Test-Path $tmpDest) {
            Remove-Item -Force $tmpDest -ErrorAction SilentlyContinue
        }
    }

    if (-not (Test-Path $dest) -or (Get-Item $dest).Length -eq 0) {
        throw "Binary install failed - $InstalledExeName missing after download"
    }

    if ((Split-Path -Leaf $dest) -ne $InstalledExeName) {
        throw "Internal error: installed file is not named $InstalledExeName"
    }

    Add-ToPath $installDir
    Write-Host "DeployHub $version installed to $dest"
    Write-Host "On-disk filename: $(Split-Path -Leaf $dest)"
    Warn-PathCollision -InstallDir $installDir -InstalledExe $dest -ExpectedTag $version
}
catch {
    Write-Host "Binary install failed ($($_.Exception.Message)). Falling back to npm..." -ForegroundColor Yellow
    npm install -g "$NpmPackage@latest"
    Write-Host "DeployHub installed via npm."
}
