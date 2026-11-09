#Requires -Version 5.1
<#
.SYNOPSIS
    Run a Consilium audit and write a timestamped log.

.DESCRIPTION
    Windows Task Scheduler wrapper for:
        consilium audit --since origin/main --fail-on high --deadline 900000

    The script fetches origin, runs the audit from the repository root, logs
    stdout/stderr under .consilium\logs, and exits with the CLI exit code
    (0 = pass, 1 = run failed, 2 = usage/setup error, 3 = policy gate failed).

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\consilium-audit.ps1
#>
[CmdletBinding()]
param(
    [string]$RepoDir = '',
    [string]$Since = 'origin/main',
    [ValidateSet('critical', 'high', 'medium', 'low', 'info', 'none')]
    [string]$FailOn = 'high',
    [int]$DeadlineMs = 900000,
    # Soft USD cap. Pass -MaxCost '' to disable it.
    [string]$MaxCost = '2.00',
    # Absolute path to consilium.cmd if it is not on the task's PATH.
    [string]$Consilium = 'consilium'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoDir)) {
    # This file lives in examples/, so the repository root is its parent.
    $RepoDir = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path -LiteralPath $RepoDir -PathType Container)) {
    throw "Repository directory not found: $RepoDir"
}
$RepoDir = (Resolve-Path -LiteralPath $RepoDir).Path

$logDir = Join-Path $RepoDir '.consilium\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$logPath = Join-Path $logDir "consilium-audit-$stamp.log"
$reportPath = Join-Path $RepoDir 'consilium-audit.md'
New-Item -ItemType File -Force -Path $logPath | Out-Null

# Tee-Object writes UTF-16 on Windows PowerShell 5.1. Append explicitly as
# UTF-8 (no BOM) so the log is readable by every editor and log collector.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Add-LogText {
    param([string]$Text)
    [System.IO.File]::AppendAllText($logPath, $Text + [Environment]::NewLine, $utf8NoBom)
}
function Write-StreamLine {
    param([object]$Item)
    if ($Item -is [System.Management.Automation.ErrorRecord]) {
        # Windows PowerShell wraps native stderr in a verbose ErrorRecord.
        $line = $Item.Exception.Message
    } else {
        $line = ($Item | Out-String).TrimEnd("`r", "`n")
    }
    Write-Host $line
    Add-LogText $line
}

if (-not (Get-Command $Consilium -ErrorAction SilentlyContinue) -and
    -not (Test-Path -LiteralPath $Consilium)) {
    Add-LogText "Consilium CLI not found: $Consilium"
    exit 2
}

$nativeErrorPreference = $ErrorActionPreference
Push-Location -LiteralPath $RepoDir
try {
    # Native stderr is log data, not a terminating PowerShell error.
    $ErrorActionPreference = 'Continue'

    & git fetch --prune --quiet origin 2>&1 | ForEach-Object { Write-StreamLine $_ }
    $fetchCode = $LASTEXITCODE
    if ($fetchCode -ne 0) {
        Add-LogText "git fetch failed with exit code $fetchCode"
        exit $fetchCode
    }

    $cliArgs = @(
        'audit',
        '--since', $Since,
        '--fail-on', $FailOn,
        '--deadline', "$DeadlineMs",
        '--report', 'pr',
        '--report-file', $reportPath
    )
    if (-not [string]::IsNullOrWhiteSpace($MaxCost)) {
        $cliArgs += @('--max-cost', $MaxCost)
    }

    Add-LogText "Running: $Consilium $($cliArgs -join ' ')"
    & $Consilium @cliArgs 2>&1 | ForEach-Object { Write-StreamLine $_ }
    $code = $LASTEXITCODE
    Add-LogText "exit=$code report=$reportPath log=$logPath"
    exit $code
}
catch {
    Add-LogText ($_ | Out-String)
    exit 1
}
finally {
    $ErrorActionPreference = $nativeErrorPreference
    Pop-Location
}
