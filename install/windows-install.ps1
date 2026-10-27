# Installs the prerequisites of HolyAgent on native Windows (no WSL, no Git Bash needed to run the
# plugin): git, Bun, Node LTS, gh and mise. HolyAgent itself installs as a Claude Code plugin; the
# script ends by printing those commands. It mirrors install/wsl-install.sh step for step.
#
# Usage: powershell -ExecutionPolicy Bypass -File install\windows-install.ps1
#        (takes no arguments; works in Windows PowerShell 5.1 and PowerShell 7)
#
# Every step checks its own result first, so a re-run changes nothing that is already right. The
# script touches only your user profile (mise and the tools it manages, your PowerShell profile and
# your user PATH) and installs missing programs with winget. Run it as your own user, in a normal
# (not elevated) window.
#
# What you are opting into:
# - Your PowerShell profile gains two lines (a one-time copy is kept next to it as
#   <profile>.pre-holyagent), and your user PATH gains Bun's global bin directory, where
#   `holyagent setup` puts Billion Context and ctx7.
# - Bun and Node LTS are installed globally through mise. Bun stays a stable build; developing this
#   repository needs a canary build, which `mise install` in the checkout upgrades to.
#
# Not covered, because it is not tested on a real Windows machine: see docs/requirements.md.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($args.Count -gt 0) {
  [Console]::Error.WriteLine('usage: powershell -ExecutionPolicy Bypass -File install\windows-install.ps1   (takes no arguments)')
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

$script:TotalSteps = 6
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

# Work from the profile folder so a repository mise.toml never changes what the global installs below
# resolve.
Set-Location $HOME

$BunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME '.bun' }
$env:BUN_INSTALL = $BunInstall
$Mise = $null

# Puts the tools mise has selected globally (node, bun) and Bun's global bin directory ahead of the
# rest of PATH for the remaining steps.
function Update-SessionPath {
  $paths = @()
  if ($script:Mise) {
    $listed = Invoke-Probe $script:Mise @('bin-paths')
    if ($listed.ExitCode -eq 0) { $paths += @($listed.Lines | Where-Object { $_ }) }
  }
  $paths += (Join-Path $BunInstall 'bin')
  $env:Path = (($paths + @($env:Path)) -join [IO.Path]::PathSeparator)
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
  # winget updates PATH for new windows only; reread it so this run sees the program.
  $env:Path = ([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path) -join ';'
}

try {
  # ---------------------------------------------------------------------------------------------
  Step 'Prerequisites (platform, winget, git)'

  Note "Windows $([Environment]::OSVersion.Version), PowerShell $($PSVersionTable.PSVersion)"
  if (-not (Have winget)) {
    Warn 'winget was not found; programs this script needs (git, mise, gh) must then be installed by hand'
  }
  Install-WithWinget git 'Git.Git'

  # ---------------------------------------------------------------------------------------------
  Step 'mise (version manager)'

  $Mise = Find-Mise
  if ($Mise) {
    Note "mise already installed: $(Get-FirstLine $Mise --version)"
  } else {
    # Official route on Windows: https://mise.jdx.dev/installing-mise.html (winget package jdx.mise).
    Install-WithWinget mise 'jdx.mise'
    $Mise = Find-Mise
  }
  if (-not $Mise) { throw 'mise was not found after the install; open a new window and re-run' }

  # Bun's global bin is appended to your user PATH, behind the system folders. In PowerShell the profile
  # line puts it first, and the mise line added after it puts mise's tools (node, bun) ahead again, so
  # mise still wins for those two.
  Add-UserPath (Join-Path $BunInstall 'bin')
  $quotedBun = ConvertTo-SingleQuoted $BunInstall
  $quotedMise = ConvertTo-SingleQuoted $Mise
  Add-ProfileLine '^\s*\$env:BUN_INSTALL\s*=' "`$env:BUN_INSTALL = $quotedBun; `$env:Path = `"`$env:BUN_INSTALL\bin;`$env:Path`""
  Add-ProfileLine '^\s*[^#\s].*mise.*\bactivate\b.*pwsh' "(& $quotedMise activate pwsh) | Out-String | Invoke-Expression"

  # ---------------------------------------------------------------------------------------------
  Step 'Node.js LTS (Billion Context and ctx7 run on Node)'

  if ((Invoke-Probe $Mise @('where', 'node')).ExitCode -eq 0) { Note 'node already selected globally' } else { Invoke-Native $Mise use -g node@lts }
  Update-SessionPath
  $nodeVersion = Get-FirstLine node --version
  if (-not $nodeVersion) { throw 'node did not report a version after mise selected it; open a new window and re-run' }
  Note "node $nodeVersion"
  # ctx7 requires Node >= 22.13; an older global node chosen earlier would fail later and obscurely.
  if ([version]($nodeVersion.TrimStart('v')) -lt [version]'22.13') {
    throw "node $nodeVersion is older than 22.13 (needed by ctx7); run: mise use -g node@lts"
  }

  # ---------------------------------------------------------------------------------------------
  Step "Bun (the plugin's hooks run it)"

  # A stable Bun is enough to run the plugin. Developing this repository needs a canary build for
  # `bun check`, `bun lint` and `bun fmt`; `mise install` in the checkout upgrades it.
  if ((Invoke-Probe $Mise @('where', 'bun')).ExitCode -eq 0) { Note 'bun already selected globally' } else { Invoke-Native $Mise use -g bun }
  Update-SessionPath
  Note "bun $(Get-FirstLine bun --revision)"

  # ---------------------------------------------------------------------------------------------
  Step 'GitHub CLI (gh)'

  Install-WithWinget gh 'GitHub.cli'

  # ---------------------------------------------------------------------------------------------
  Step 'Verification'

  $failed = @()
  function Test-Tool([string]$Name, [string]$File, [string[]]$Arguments) {
    $version = if (Have $File) { Get-FirstLine $File @Arguments } else { $null }
    if ($version) { '    {0,-8} {1}' -f $Name, $version | Write-Host } else { '    {0,-8} MISSING' -f $Name | Write-Host; $script:failed += $Name }
  }
  Test-Tool 'mise' $Mise @('--version')
  Test-Tool 'node' 'node' @('--version')
  Test-Tool 'bun' 'bun' @('--revision')
  Test-Tool 'git' 'git' @('--version')
  Test-Tool 'gh' 'gh' @('--version')
  if ($failed.Count -gt 0) { throw "verification failed for: $($failed -join ' ')" }

  if ((Invoke-Probe 'gh' @('auth', 'status')).ExitCode -ne 0) {
    Warn 'gh is not authenticated; run: gh auth login (or set GH_TOKEN)'
  }
  if (-not (Have claude)) {
    Warn 'Claude Code is not installed; see https://code.claude.com/docs/en/setup'
  }

  Write-Host ''
  Write-Host 'Done. Open a new PowerShell window so PATH picks up mise and Bun, then install HolyAgent with'
  Write-Host 'these three commands:'
  Write-Host ''
  Write-Host '  claude plugin marketplace add davidbasilefilho/holyagent'
  Write-Host '  claude plugin marketplace add ranxianglei/billion-context'
  Write-Host '  claude plugin install holyagent@holyagent'
  Write-Host ''
  Write-Host 'On the first launch, run /holyagent:setup to install Billion Context and ctx7 and to configure'
  Write-Host 'Claude Code.'
} catch {
  [Console]::Error.WriteLine("error: step failed: $($script:CurrentStep) ($($_.Exception.Message)). Fix the cause and re-run; finished steps are skipped.")
  exit 1
}
