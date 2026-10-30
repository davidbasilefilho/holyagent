# Installs the prerequisites of HolyAgent on native Windows (no WSL, no Git Bash needed to run the
# plugin): git, Node LTS, Bun and gh. With -Dev it also installs mise, which developing this repository
# needs. HolyAgent itself installs as a Claude Code plugin; the script ends by printing those commands.
# It mirrors install/wsl-install.sh step for step.
#
# Usage: powershell -ExecutionPolicy Bypass -File install\windows-install.ps1 [-Dev]
#        (works in Windows PowerShell 5.1 and PowerShell 7)
#
# Every step checks its own result first, so a re-run changes nothing that is already right. The
# script touches only your user profile and installs missing programs. Run it as your own user, in a
# normal (not elevated) window.
#
# What you are opting into:
# - git (Git.Git), Node LTS (OpenJS.NodeJS.LTS) and gh (GitHub.cli) are installed with winget, which
#   asks for elevation itself when a package needs it.
# - Bun comes from its official install script (https://bun.sh/install.ps1) into ~\.bun, and your user
#   PATH gains Bun's global bin directory, where `holyagent setup` puts ctx7.
# - -Dev adds mise (winget package jdx.mise) and a line in your PowerShell profile that activates it (a
#   one-time copy of the profile is kept next to it as <profile>.pre-holyagent). Bun stays a stable
#   build; developing this repository needs a canary build, which `mise install` in the checkout
#   upgrades to.
#
# Tested by the maintainer on a Windows machine; see docs/requirements.md.
param([switch]$Dev)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($args.Count -gt 0) {
  [Console]::Error.WriteLine('usage: powershell -ExecutionPolicy Bypass -File install\windows-install.ps1 [-Dev]   (-Dev also installs mise, for developing HolyAgent)')
  exit 2
}

if ($env:OS -ne 'Windows_NT') {
  [Console]::Error.WriteLine('error: this installer is for native Windows; on WSL or Linux run: bash install/wsl-install.sh')
  exit 1
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  [Console]::Error.WriteLine('error: run this in a normal (not elevated) window; it installs into your user profile and winget asks for elevation itself when a package needs it')
  exit 1
}

$script:TotalSteps = 5 + [int]$Dev.IsPresent
$script:StepNumber = 0
$script:CurrentStep = 'startup'

function Step([string]$Title) {
  $script:StepNumber++
  $script:CurrentStep = $Title
  Write-Host "==> [$($script:StepNumber)/$($script:TotalSteps)] $Title"
}

function Note([string]$Text) { Write-Host "    $Text" }
function Warn([string]$Text) { Write-Warning $Text }
function Have([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Runs a native command and fails the step when it exits non-zero, so no error is silent.
function Invoke-Native {
  param([Parameter(Mandatory)][string]$File, [Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
  $Arguments = @($Arguments)
  $ErrorActionPreference = 'Continue'
  & $File @Arguments
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "$File $($Arguments -join ' ') exited $code" }
}

# Runs a native command whose failure is an answer, not an error, and returns its exit code and output
# lines. Windows PowerShell 5.1 turns a native command's stderr into a terminating error when
# $ErrorActionPreference is 'Stop', even when the stream is redirected; the local 'Continue' (a function
# scope, restored on return) keeps the probe from ending the script. A missing program gives exit code 127.
function Invoke-Probe([string]$File, [string[]]$Arguments = @()) {
  $ErrorActionPreference = 'Continue'
  $lines = @()
  $code = 127
  try {
    $lines = @(& $File @Arguments 2>$null)
    $code = $LASTEXITCODE
  } catch { $code = 127 }
  return [pscustomobject]@{ ExitCode = $code; Lines = $lines }
}

# The first line a command prints, or $null when it fails or prints nothing; used for versions.
function Get-FirstLine {
  param([Parameter(Mandatory)][string]$File, [Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
  $result = Invoke-Probe $File @($Arguments)
  if ($result.ExitCode -ne 0 -or $result.Lines.Count -eq 0 -or $null -eq $result.Lines[0]) { return $null }
  return $result.Lines[0].ToString().Trim()
}

# A string as a PowerShell single-quoted literal, for lines written into your profile. PowerShell also reads
# U+2018 to U+201B as single quotes, so each of those is doubled along with the straight quote.
function ConvertTo-SingleQuoted([string]$Text) {
  $curly = '[' + [char]0x2018 + [char]0x2019 + [char]0x201A + [char]0x201B + ']'
  return "'" + [regex]::Replace($Text.Replace("'", "''"), $curly, '$0$0') + "'"
}

# Work from the profile folder so a repository mise.toml never changes what the checks below resolve.
Set-Location $HOME

$BunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME '.bun' }
$env:BUN_INSTALL = $BunInstall

# Rereads the machine and user PATH (winget and installers update PATH for new windows only) and puts
# Bun's global bin directory ahead, so this run sees what it just installed.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = ((Join-Path $BunInstall 'bin'), $machine, $user, $env:Path | Where-Object { $_ }) -join [IO.Path]::PathSeparator
}

# Finds mise: on PATH, in the winget links folder, or where the standalone installer puts it.
function Find-Mise {
  $command = Get-Command mise -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in @(
      (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\mise.exe'),
      (Join-Path $env:LOCALAPPDATA 'mise\bin\mise.exe'),
      (Join-Path $HOME '.local\bin\mise.exe'))) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

# Appends a line to your PowerShell profile unless an uncommented line matching the regex is already
# there. Keeps a one-time backup.
function Add-ProfileLine([string]$Pattern, [string]$Line) {
  $profilePath = $PROFILE.CurrentUserAllHosts
  if ((Test-Path $profilePath) -and (Select-String -Path $profilePath -Pattern $Pattern -Quiet)) {
    Note "$profilePath already has a line matching $Pattern"
    return
  }
  $folder = Split-Path -Parent $profilePath
  if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
  if (Test-Path $profilePath) {
    $backup = "$profilePath.pre-holyagent"
    if (-not (Test-Path $backup)) { Copy-Item $profilePath $backup }
    $text = Get-Content -Raw $profilePath
    if ($text -and -not $text.EndsWith("`n")) { Add-Content -Path $profilePath -Value '' }
  }
  Add-Content -Path $profilePath -Value $Line
  Note "added to ${profilePath}: $Line"
}

# Adds a folder to the user's persistent PATH unless it is there already (compared without case).
function Add-UserPath([string]$Folder) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($current -split ';' | Where-Object { $_ })
  if ($entries | Where-Object { $_.TrimEnd('\') -ieq $Folder.TrimEnd('\') }) {
    Note "$Folder is already on your user PATH"
    return
  }
  [Environment]::SetEnvironmentVariable('Path', (($entries + $Folder) -join ';'), 'User')
  Note "added to your user PATH: $Folder"
}

# Installs a program with winget unless the command is already available.
function Install-WithWinget([string]$CommandName, [string]$Id) {
  if (Have $CommandName) { Note "$CommandName already installed: $(Get-FirstLine $CommandName --version)"; return }
  if (-not (Have winget)) {
    throw "winget is not available, and $CommandName is required. Install '$Id' by hand (https://learn.microsoft.com/windows/package-manager/winget/), then re-run."
  }
  Invoke-Native winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements
  Update-SessionPath
}

try {
  # ---------------------------------------------------------------------------------------------
  Step 'Prerequisites (platform, winget, git)'

  Note "Windows $([Environment]::OSVersion.Version), PowerShell $($PSVersionTable.PSVersion)"
  if (-not (Have winget)) {
    Warn 'winget was not found; programs this script needs (git, node, gh) must then be installed by hand'
  }
  Install-WithWinget git 'Git.Git'

  # ---------------------------------------------------------------------------------------------
  Step 'Node.js LTS (ctx7 runs on Node)'

  Install-WithWinget node 'OpenJS.NodeJS.LTS'
  $nodeVersion = Get-FirstLine node --version
  if (-not $nodeVersion) { throw 'node did not report a version after the install; open a new window and re-run' }
  Note "node $nodeVersion"
  # ctx7 requires Node >= 22.13; an older node found on PATH would fail later and obscurely.
  if ([version]($nodeVersion.TrimStart('v')) -lt [version]'22.13') {
    throw "node $nodeVersion is older than 22.13 (needed by ctx7); run: winget upgrade --id OpenJS.NodeJS.LTS"
  }

  # ---------------------------------------------------------------------------------------------
  Step "Bun (the plugin's hooks run it)"

  Update-SessionPath
  if (Have bun) {
    Note "bun $(Get-FirstLine bun --revision) already installed"
  } else {
    # Official installer: https://bun.sh/docs/installation (installs to $env:BUN_INSTALL, default ~\.bun,
    # and adds its bin folder to your user PATH). Downloaded to a file first so a failed download runs
    # nothing, and run in a child process so its exit cannot end this script.
    $bunInstaller = Join-Path ([IO.Path]::GetTempPath()) "bun-install-$PID.ps1"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri 'https://bun.sh/install.ps1' -OutFile $bunInstaller
      Invoke-Native powershell -NoProfile -ExecutionPolicy Bypass -File $bunInstaller
    } finally {
      Remove-Item -Force -ErrorAction SilentlyContinue $bunInstaller
    }
    Update-SessionPath
  }
  if (-not (Have bun)) { throw "bun was not found after the install; check $(Join-Path $BunInstall 'bin')" }
  Add-UserPath (Join-Path $BunInstall 'bin')
  Note "bun $(Get-FirstLine bun --revision)"

  # ---------------------------------------------------------------------------------------------
  Step 'GitHub CLI (gh)'

  Install-WithWinget gh 'GitHub.cli'

  # ---------------------------------------------------------------------------------------------
  $Mise = $null
  if ($Dev) {
    Step "mise (development: tool versions and the repository's commands)"

    $Mise = Find-Mise
    if ($Mise) {
      Note "mise already installed: $(Get-FirstLine $Mise --version)"
    } else {
      # Official route on Windows: https://mise.jdx.dev/installing-mise.html (winget package jdx.mise).
      Install-WithWinget mise 'jdx.mise'
      $Mise = Find-Mise
    }
    if (-not $Mise) { throw 'mise was not found after the install; open a new window and re-run' }
    $quotedMise = ConvertTo-SingleQuoted $Mise
    Add-ProfileLine '^\s*[^#\s].*mise.*\bactivate\b.*pwsh' "(& $quotedMise activate pwsh) | Out-String | Invoke-Expression"
  }

  # ---------------------------------------------------------------------------------------------
  Step 'Verification'

  $failed = @()
  function Test-Tool([string]$Name, [string]$File, [string[]]$Arguments) {
    $version = if (Have $File) { Get-FirstLine $File @Arguments } else { $null }
    if ($version) { '    {0,-8} {1}' -f $Name, $version | Write-Host } else { '    {0,-8} MISSING' -f $Name | Write-Host; $script:failed += $Name }
  }
  Test-Tool 'node' 'node' @('--version')
  Test-Tool 'bun' 'bun' @('--revision')
  Test-Tool 'git' 'git' @('--version')
  Test-Tool 'gh' 'gh' @('--version')
  if ($Dev) { Test-Tool 'mise' $Mise @('--version') }
  if ($failed.Count -gt 0) { throw "verification failed for: $($failed -join ' ')" }

  if ((Invoke-Probe 'gh' @('auth', 'status')).ExitCode -ne 0) {
    Warn 'gh is not authenticated; run: gh auth login (or set GH_TOKEN)'
  }
  if (-not (Have claude)) {
    Warn 'Claude Code is not installed; see https://code.claude.com/docs/en/setup'
  }

  Write-Host ''
  Write-Host 'Done. Open a new PowerShell window so PATH picks up Bun, then install HolyAgent with these'
  Write-Host 'two commands:'
  Write-Host ''
  Write-Host '  claude plugin marketplace add davidbasilefilho/holyagent'
  Write-Host '  claude plugin install holyagent@holyagent'
  Write-Host ''
  Write-Host 'On the first launch, run /holyagent:setup to install ctx7 and to configure Claude Code.'
} catch {
  [Console]::Error.WriteLine("error: step failed: $($script:CurrentStep) ($($_.Exception.Message)). Fix the cause and re-run; finished steps are skipped.")
  exit 1
}
