# DeployHub install script for Windows
# Author: Akash Chowdhury — canonical source: src/utils/author.js
# Repository: https://github.com/Akash-Chowdhury-24/DeployHub

$ErrorActionPreference = "Stop"

$GitHubRepo = "akashchowdhury/deployhub"
$BinaryName = "deployhub.exe"

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

function Add-ToPath {
    param([string]$Dir)
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$Dir*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$Dir", "User")
        $env:Path = "$env:Path;$Dir"
        Write-Host "Added $Dir to user PATH"
    }
}

try {
    $version = Get-LatestVersion
    $assetName = "deployhub-win.exe"
    $url = "https://github.com/$GitHubRepo/releases/download/$version/$assetName"
    $installDir = Get-InstallDir
    $dest = Join-Path $installDir $BinaryName

    Write-Host "Downloading DeployHub $version for Windows..."
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing

    if (-not (Test-Path $dest) -or (Get-Item $dest).Length -eq 0) {
        throw "Binary download failed"
    }

    Add-ToPath $installDir
    Write-Host "DeployHub $version installed to $dest"
    & $dest --version
}
catch {
    Write-Host "Binary install failed ($($_.Exception.Message)). Falling back to npm..." -ForegroundColor Yellow
    npm install -g deployhub@latest
    Write-Host "DeployHub installed via npm."
}
