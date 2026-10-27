# Sets up the HolyAgent development environment on native Windows (no WSL, no Git Bash needed to run
# the plugin). It mirrors install/wsl-install.sh step for step.
#
# Usage: powershell -ExecutionPolicy Bypass -File install\windows-install.ps1
#        (takes no arguments; works in Windows PowerShell 5.1 and PowerShell 7)
#
# Every step checks its own result first, so a re-run changes nothing that is already right. The
# script touches only your user profile (mise, Bun globals, Claude Code settings, your PowerShell
# profile and your user PATH) and installs missing programs with winget. Run it as your own user, in
# a normal (not elevated) window.
#
# What you are opting into:
# - Billion Context routes all Claude Code traffic through a local proxy (127.0.0.1:18787), turns
#   off Claude Code's auto-compact, and auto-updates itself from npm by default.
# - `ctx7 setup` downloads a skill and a rule from Context7's servers into ~\.claude.
# - Bun runs a canary build (`bun upgrade --canary`), because the toolchain needs `bun lint`,
#   `bun fmt` and `bun check`.
# - Your PowerShell profile gains two lines (a one-time copy is kept next to it as
#   <profile>.pre-holyagent), and your user PATH gains Bun's global bin directory.
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

$script:TotalSteps = 8
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
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') exited $LASTEXITCODE" }
}

# The first line a command prints, or $null when it fails; used for versions.
function Get-FirstLine {
  param([Parameter(Mandatory)][string]$File, [Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
  try {
    $lines = & $File @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($lines | Select-Object -First 1).ToString().Trim()
  } catch { return $null }
}

# Work from the profile folder so a repository mise.toml never changes what the global installs below
# resolve.
Set-Location $HOME

$BunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME '.bun' }
$env:BUN_INSTALL = $BunInstall
$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$ClaudeJson = Join-Path $(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { $HOME }) '.claude.json'
$Mise = $null

# Puts the tools mise has selected globally (node, bun) and Bun's global bin directory (claude, bili,
# ctx7) ahead of the rest of PATH for the remaining steps.
function Update-SessionPath {
  $paths = @()
  if ($script:Mise) {
    $listed = & $script:Mise bin-paths 2>$null
    if ($LASTEXITCODE -eq 0 -and $listed) { $paths += @($listed | Where-Object { $_ }) }
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

# Installs a Bun global package unless its command is already on PATH, then prints the version.
function Install-BunGlobal([string]$CommandName, [string]$Package) {
  if (Have $CommandName) {
    Note "$CommandName already installed"
  } else {
    Invoke-Native bun add -g $Package
    Update-SessionPath
  }
  Note "$CommandName $(Get-FirstLine $CommandName --version)"
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

function Test-Canary { $revision = Get-FirstLine bun --revision; return ($revision -and $revision -match 'canary') }

try {
  # ---------------------------------------------------------------------------------------------
  Step 'Prerequisites (platform, winget, git)'

  Note "Windows $([Environment]::OSVersion.Version), PowerShell $($PSVersionTable.PSVersion)"
  if (-not (Have winget)) {
    Warn 'winget was not found; programs this script needs (git, mise) must then be installed by hand'
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

  # Bun's global bin comes first so mise's activation, appended after it, still wins for node and bun.
  Add-UserPath (Join-Path $BunInstall 'bin')
  Add-ProfileLine '^\s*\$env:BUN_INSTALL\s*=' "`$env:BUN_INSTALL = '$BunInstall'; `$env:Path = `"`$env:BUN_INSTALL\bin;`$env:Path`""
  Add-ProfileLine '^\s*.*mise.*\bactivate\b.*pwsh' "(& '$Mise' activate pwsh) | Out-String | Invoke-Expression"

  # ---------------------------------------------------------------------------------------------
  Step 'Node.js LTS (Billion Context and ctx7 run on Node)'

  & $Mise where node *> $null
  if ($LASTEXITCODE -eq 0) { Note 'node already selected globally' } else { Invoke-Native $Mise use -g node@lts }
  Update-SessionPath
  $nodeVersion = Get-FirstLine node --version
  Note "node $nodeVersion"
  # ctx7 requires Node >= 22.13; an older global node chosen earlier would fail later and obscurely.
  if ([version]($nodeVersion.TrimStart('v')) -lt [version]'22.13') {
    throw "node $nodeVersion is older than 22.13 (needed by ctx7); run: mise use -g node@lts"
  }

  # ---------------------------------------------------------------------------------------------
  Step 'Bun (canary)'

  # The toolchain needs `bun lint`, `bun fmt` and `bun check`, which exist only in canary builds. mise
  # cannot install bun@canary, so it installs a stable Bun and `bun upgrade --canary` replaces the
  # binary in place. A later `mise upgrade bun` that installs a new stable brings stable back, so the
  # canary check below runs on every invocation, like the repo's `toolchain` task.
  & $Mise where bun *> $null
  if ($LASTEXITCODE -ne 0) { Invoke-Native $Mise use -g bun }
  Update-SessionPath
  if (Test-Canary) {
    Note "bun is already canary: $(Get-FirstLine bun --revision)"
  } else {
    # A `--smol` in BUN_OPTIONS makes `bun upgrade` fail ("does not take package names").
    $savedOptions = $env:BUN_OPTIONS
    Remove-Item Env:BUN_OPTIONS -ErrorAction SilentlyContinue
    try { Invoke-Native bun upgrade --canary } finally { if ($savedOptions) { $env:BUN_OPTIONS = $savedOptions } }
  }
  if (-not (Test-Canary)) { throw 'bun is not a canary build after upgrade' }
  Note "bun $(Get-FirstLine bun --revision)"

  # ---------------------------------------------------------------------------------------------
  Step 'Claude Code (via Bun)'

  # Anthropic's setup page (https://code.claude.com/docs/en/setup) documents the native installer,
  # WinGet, Homebrew and `npm install -g @anthropic-ai/claude-code`; it does not mention Bun.
  # Installing the same npm package with Bun works but is not an officially documented method, and
  # its auto-update behavior is undocumented. `claude doctor` reports the install type.
  Install-BunGlobal claude '@anthropic-ai/claude-code'

  # ---------------------------------------------------------------------------------------------
  Step 'Billion Context (via Bun) with Claude Code native mode'

  # Billion Context (https://github.com/ranxianglei/billion-context) documents npm only; Bun works
  # and the bins run on Node.
  Install-BunGlobal bili billion-context

  # Native mode merges a proxy base URL, a SessionStart hook and an MCP server into the Claude Code
  # settings and sets DISABLE_AUTO_COMPACT=1: bili owns compression, so Claude Code's auto-compact
  # stays off (manual /compact still works). Every re-run of the command writes another settings
  # backup, so it runs only when one of its artifacts is missing.
  function Test-BiliNativeReady {
    $settings = Join-Path $ClaudeDir 'settings.json'
    return (Test-Path $settings) -and
      (Select-String -Path $settings -Pattern 'claude-native-bootstrap' -SimpleMatch -Quiet) -and
      (Test-Path (Join-Path $ClaudeDir 'commands\acp-cache.md')) -and
      (Test-Path $ClaudeJson) -and
      (Select-String -Path $ClaudeJson -Pattern '"bili"' -SimpleMatch -Quiet)
  }
  if (Test-BiliNativeReady) {
    Note 'Claude Code native mode already configured'
  } else {
    Invoke-Native bili plugin install claude
  }

  # compress.rules protects persistent reminders (rules text) from being folded. It is set only when
  # the key is absent, so a value the user chose and every other key stay untouched. The Node script
  # goes through a file because PowerShell 5.1 mangles double quotes in native command arguments.
  $xdg = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME '.config' }
  $env:BILI_CONFIG = if ($env:BILI_CONFIG_FILE) { $env:BILI_CONFIG_FILE } else { Join-Path $xdg 'billion-context\billion-context.json' }
  $configScript = Join-Path ([IO.Path]::GetTempPath()) "holyagent-bili-config-$PID.js"
  @'
const fs = require("node:fs")
const path = require("node:path")
const file = process.env.BILI_CONFIG
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const refuse = (message) => {
  console.error("    error: " + message)
  process.exit(1)
}
let config = {}
if (fs.existsSync(file)) {
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    refuse(file + " is not valid JSON (" + error.message + "); fix or remove it, then re-run")
  }
  if (!isObject(config)) refuse(file + " must contain a JSON object; fix it, then re-run")
}
const compress = config.compress ?? {}
if (!isObject(compress)) refuse("compress in " + file + " is not an object; fix it, then re-run")
if (compress.rules !== undefined) {
  console.log("    compress.rules already set (" + compress.rules + ") in " + file)
  process.exit(0)
}
config.compress = { ...compress, rules: true }
const directory = path.dirname(file)
fs.mkdirSync(directory, { recursive: true })
const temporary = path.join(directory, "." + path.basename(file) + "." + process.pid + ".tmp")
fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
fs.renameSync(temporary, file)
console.log("    set compress.rules=true in " + file)
'@ | Set-Content -Path $configScript -Encoding ASCII
  try { Invoke-Native node $configScript } finally { Remove-Item $configScript -ErrorAction SilentlyContinue }

  # ---------------------------------------------------------------------------------------------
  Step 'ctx7 (Context7 CLI via Bun) and its Claude Code skill'

  # ctx7 needs Node >= 22.13, checked in the Node step.
  Install-BunGlobal ctx7 ctx7

  # `ctx7 setup --cli --claude` downloads the find-docs skill and a rule file for Claude Code. The
  # hosted setup needs a login or an API key; without either, --yes starts a browser device flow
  # that blocks a script, so the step is skipped with a hint instead. ctx7 reads CONTEXT7_API_KEY
  # during setup only for --base-url deployments, so the key goes on the command line, visible in
  # the process list for the seconds the command runs.
  $ctx7Ready = (Test-Path (Join-Path $ClaudeDir 'skills\find-docs\SKILL.md')) -and (Test-Path (Join-Path $ClaudeDir 'rules\context7.md'))
  if ($ctx7Ready) {
    Note 'Context7 skill and rule already installed'
  } elseif ($env:CONTEXT7_API_KEY) {
    Invoke-Native ctx7 setup --cli --claude --yes --api-key $env:CONTEXT7_API_KEY
  } elseif (Test-Path (Join-Path $HOME '.config\context7\credentials.json')) {
    Invoke-Native ctx7 setup --cli --claude --yes
  } else {
    Warn 'Context7 skill not installed: no login or API key found.'
    Warn "run 'ctx7 login', or set CONTEXT7_API_KEY (for example: `$env:CONTEXT7_API_KEY = Read-Host 'key'), then re-run this script"
  }

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
  Test-Tool 'claude' 'claude' @('--version')
  Test-Tool 'bili' 'bili' @('--version')
  Test-Tool 'ctx7' 'ctx7' @('--version')
  if ((Have bun) -and -not (Test-Canary)) {
    [Console]::Error.WriteLine('    bun is not a canary build')
    $failed += 'bun-canary'
  }
  if ($failed.Count -gt 0) { throw "verification failed for: $($failed -join ' ')" }

  Write-Host 'Done. Open a new PowerShell window so PATH picks up mise and Bun.'
} catch {
  [Console]::Error.WriteLine("error: step failed: $($script:CurrentStep) ($($_.Exception.Message)). Fix the cause and re-run; finished steps are skipped.")
  exit 1
}
