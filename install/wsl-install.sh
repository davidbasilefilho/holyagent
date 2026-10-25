#!/usr/bin/env bash
# Sets up the HolyAgent development environment on a clean WSL Ubuntu install.
#
# Usage: bash install/wsl-install.sh
#
# Every step checks its own result first, so a re-run changes nothing that is already right. The
# script touches only $HOME (mise, Bun globals, Claude Code settings, ~/.bashrc) and runs sudo
# only to install missing apt packages. Run it as your own user, not through sudo.
#
# What you are opting into:
# - Billion Context routes all Claude Code traffic through a local proxy (127.0.0.1:18787), turns
#   off Claude Code's auto-compact, and auto-updates itself from npm by default.
# - `ctx7 setup` downloads a skill and a rule from Context7's servers into ~/.claude.
# - Bun runs a canary build (`bun upgrade --canary`), because the toolchain needs `bun lint`,
#   `bun fmt` and `bun check`.
# - ~/.bashrc gains two lines (a one-time copy is kept as ~/.bashrc.pre-holyagent).
set -Eeuo pipefail

if [[ $# -gt 0 ]]; then
  echo "usage: bash ${0##*/}   (takes no arguments)" >&2
  exit 2
fi

if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" ]]; then
  echo "error: run this as ${SUDO_USER}, not through sudo; it installs into the home directory and calls sudo itself when apt needs it" >&2
  exit 1
fi

TOTAL_STEPS=8
CURRENT_STEP="startup"
STEP_NUMBER=0
MISE_INSTALLER=""
trap 'rm -f "$MISE_INSTALLER"' EXIT

on_error() {
  local status=$? line=$1
  echo "error: step failed: ${CURRENT_STEP} (line ${line}, exit ${status}). Fix the cause and re-run; finished steps are skipped." >&2
}
trap 'on_error $LINENO' ERR

step() {
  STEP_NUMBER=$((STEP_NUMBER + 1))
  CURRENT_STEP="$1"
  echo "==> [${STEP_NUMBER}/${TOTAL_STEPS}] $1"
}

note() { echo "    $*"; }
warn() { echo "    warning: $*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# Work from $HOME so a repository mise.toml never changes what the global installs below resolve.
cd "$HOME"

MISE="${MISE_INSTALL_PATH:-$HOME/.local/bin/mise}"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
BASHRC="$HOME/.bashrc"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CLAUDE_JSON="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"

# Puts the tools mise has selected globally (node, bun) and Bun's global bin directory (claude,
# bili, ctx7) ahead of the rest of PATH for the remaining steps.
refresh_path() {
  local dir mise_paths=""
  while IFS= read -r dir; do
    [[ -n "$dir" ]] && mise_paths+="${dir}:"
  done < <("$MISE" bin-paths 2>/dev/null || true)
  PATH="${mise_paths}${BUN_INSTALL}/bin:${PATH}"
  export PATH
}

# Appends a line to ~/.bashrc unless an uncommented line matching the extended regex $1 is already
# there. Keeps a one-time backup and starts on a fresh line when the file lacks a final newline.
ensure_bashrc_line() {
  local pattern=$1 line=$2
  if grep -qE -- "$pattern" "$BASHRC" 2>/dev/null; then
    note "${BASHRC} already has a line matching ${pattern}"
    return
  fi
  if [[ -e "$BASHRC" ]]; then
    [[ -e "${BASHRC}.pre-holyagent" ]] || cp "$BASHRC" "${BASHRC}.pre-holyagent"
    # Command substitution drops a trailing newline, so output means the last byte is not one.
    [[ -z "$(tail -c1 "$BASHRC")" ]] || printf '\n' >>"$BASHRC"
  fi
  printf '%s\n' "$line" >>"$BASHRC"
  note "added to ${BASHRC}: ${line}"
}

# Installs a Bun global package unless its command is already on PATH, then prints the version.
install_bun_global() {
  local command_name=$1 package=$2
  if have "$command_name"; then
    note "${command_name} already installed"
  else
    bun add -g "$package"
    refresh_path
  fi
  note "${command_name} $("$command_name" --version 2>&1 | head -n 1)"
}

# ---------------------------------------------------------------------------------------------
step "Prerequisites (platform, apt packages)"

if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null || [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  note "WSL detected (${WSL_DISTRO_NAME:-unnamed distro})"
else
  warn "this does not look like WSL; continuing because the steps below work on any Ubuntu"
fi

distro_id=""
if [[ -r /etc/os-release ]]; then
  distro_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
fi
if [[ "$distro_id" != "ubuntu" ]]; then
  warn "distribution is '${distro_id:-unknown}', not Ubuntu; apt packages may differ"
fi

if have apt-get && have dpkg-query; then
  missing=()
  for pkg in curl git ca-certificates unzip build-essential; do
    if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then
      missing+=("$pkg")
    fi
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    note "apt packages already installed"
  else
    note "missing apt packages: ${missing[*]}"
    if [[ $EUID -eq 0 ]]; then
      sudo_cmd=()
    elif have sudo; then
      note "using sudo to install them (you may be asked for your password)"
      sudo_cmd=(sudo)
    else
      echo "error: need root to install ${missing[*]}, but sudo is not available" >&2
      exit 1
    fi
    "${sudo_cmd[@]}" env DEBIAN_FRONTEND=noninteractive apt-get update -qq
    "${sudo_cmd[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
  fi
else
  warn "apt-get not found; checking for the commands only"
  for cmd in curl git unzip make gcc; do
    have "$cmd" || { echo "error: '${cmd}' is required and apt-get is unavailable to install it" >&2; exit 1; }
  done
fi

# ---------------------------------------------------------------------------------------------
step "mise (version manager)"

if [[ -x "$MISE" ]]; then
  note "mise already installed: $("$MISE" --version)"
else
  # Official installer: https://mise.jdx.dev/getting-started.html (installs to ~/.local/bin/mise,
  # or to MISE_INSTALL_PATH). Downloaded to a file first so a failed download runs nothing.
  MISE_INSTALLER=$(mktemp)
  curl -fsSL https://mise.run -o "$MISE_INSTALLER"
  sh "$MISE_INSTALLER"
fi
[[ -x "$MISE" ]] || { echo "error: mise not found at ${MISE} after install" >&2; exit 1; }

# Bun's global bin comes first so mise's activation, appended after it, still wins for node and bun.
# The patterns skip commented-out lines; the lines carry the paths this run actually uses.
# shellcheck disable=SC2016
printf -v bun_line 'export BUN_INSTALL=%q; export PATH="$BUN_INSTALL/bin:$PATH"' "$BUN_INSTALL"
ensure_bashrc_line '^[[:space:]]*(export[[:space:]]+)?BUN_INSTALL=' "$bun_line"
# shellcheck disable=SC2016
printf -v mise_line 'eval "$(%q activate bash)"' "$MISE"
ensure_bashrc_line '^[[:space:]]*eval .*mise.* activate bash' "$mise_line"

# ---------------------------------------------------------------------------------------------
step "Node.js LTS (Billion Context and ctx7 run on Node)"

if "$MISE" where node >/dev/null 2>&1; then
  note "node already selected globally"
else
  "$MISE" use -g node@lts
fi
refresh_path
note "node $(node --version)"
# ctx7 requires Node >= 22.13; an older global node chosen earlier would fail later and obscurely.
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
  echo "error: node $(node --version) is older than 22.13 (needed by ctx7); run: ${MISE} use -g node@lts" >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
step "Bun (canary)"

# The toolchain needs `bun lint`, `bun fmt` and `bun check`, which exist only in canary builds.
# mise cannot install bun@canary, so it installs a stable Bun and `bun upgrade --canary` replaces
# the binary in place. A later `mise upgrade bun` that installs a new stable brings stable back,
# so the canary check below runs on every invocation, like the repo's `toolchain` task.
if ! "$MISE" where bun >/dev/null 2>&1; then
  "$MISE" use -g bun
fi
refresh_path
if bun --revision | grep -q canary; then
  note "bun is already canary: $(bun --revision)"
else
  # A `--smol` in BUN_OPTIONS makes `bun upgrade` fail ("does not take package names").
  env -u BUN_OPTIONS bun upgrade --canary
fi
bun --revision | grep -q canary || { echo "error: bun is not a canary build after upgrade" >&2; exit 1; }
note "bun $(bun --revision)"

# ---------------------------------------------------------------------------------------------
step "Claude Code (via Bun)"

# Anthropic's setup page (https://code.claude.com/docs/en/setup) documents the native installer,
# Homebrew, WinGet, apt/dnf/apk and `npm install -g @anthropic-ai/claude-code`; it does not mention
# Bun. Installing the same npm package with Bun works but is not an officially documented method,
# and its auto-update behavior is undocumented. `claude doctor` reports the install type.
install_bun_global claude @anthropic-ai/claude-code

# ---------------------------------------------------------------------------------------------
step "Billion Context (via Bun) with Claude Code native mode"

# Billion Context (https://github.com/ranxianglei/billion-context) documents npm only; Bun works
# and the bins run on Node through their shebang.
install_bun_global bili billion-context

# Native mode merges a proxy base URL, a SessionStart hook and an MCP server into the Claude Code
# settings and sets DISABLE_AUTO_COMPACT=1: bili owns compression, so Claude Code's auto-compact
# stays off (manual /compact still works). Every re-run of the command writes another settings
# backup, so it runs only when one of its artifacts is missing.
bili_native_ready() {
  grep -q 'claude-native-bootstrap' "$CLAUDE_DIR/settings.json" 2>/dev/null &&
    [[ -f "$CLAUDE_DIR/commands/acp-cache.md" ]] &&
    grep -q '"bili"' "$CLAUDE_JSON" 2>/dev/null
}
if bili_native_ready; then
  note "Claude Code native mode already configured"
else
  bili plugin install claude
fi

# compress.rules protects persistent reminders (rules text) from being folded. It is set only when
# the key is absent, so a value the user chose and every other key stay untouched.
bili_config="${BILI_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/billion-context/billion-context.json}"
BILI_CONFIG="$bili_config" node -e '
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
'

# ---------------------------------------------------------------------------------------------
step "ctx7 (Context7 CLI via Bun) and its Claude Code skill"

# ctx7 needs Node >= 22.13, checked in the Node step.
install_bun_global ctx7 ctx7

# `ctx7 setup --cli --claude` downloads the find-docs skill and a rule file for Claude Code. The
# hosted setup needs a login or an API key; without either, --yes starts a browser device flow
# that blocks a script, so the step is skipped with a hint instead. ctx7 0.8.2 reads
# CONTEXT7_API_KEY during setup only for --base-url deployments (tested: with the variable set and
# no login, hosted setup waited for the device flow), so the key has to go on the command line,
# visible in the process list for the seconds the command runs.
ctx7_ready() {
  [[ -f "$CLAUDE_DIR/skills/find-docs/SKILL.md" && -f "$CLAUDE_DIR/rules/context7.md" ]]
}
if ctx7_ready; then
  note "Context7 skill and rule already installed"
elif [[ -n "${CONTEXT7_API_KEY:-}" ]]; then
  ctx7 setup --cli --claude --yes --api-key "$CONTEXT7_API_KEY"
elif [[ -f "$HOME/.config/context7/credentials.json" ]]; then
  ctx7 setup --cli --claude --yes
else
  warn "Context7 skill not installed: no login or API key found."
  warn "run 'ctx7 login', or export CONTEXT7_API_KEY (for example: read -rs CONTEXT7_API_KEY; export CONTEXT7_API_KEY), then re-run this script"
fi

# ---------------------------------------------------------------------------------------------
step "Verification"

failed=()
verify() {
  local name=$1 version
  shift
  if have "$1" && version=$("$@" 2>&1 | head -n 1) && [[ -n "$version" ]]; then
    printf '    %-8s %s\n' "$name" "$version"
  else
    printf '    %-8s MISSING\n' "$name"
    failed+=("$name")
  fi
}

verify mise "$MISE" --version
verify node node --version
verify bun bun --revision
verify claude claude --version
verify bili bili --version
verify ctx7 ctx7 --version

if have bun && ! bun --revision | grep -q canary; then
  echo "    bun is not a canary build" >&2
  failed+=("bun-canary")
fi

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "error: verification failed for: ${failed[*]}" >&2
  exit 1
fi

echo "Done. Open a new shell (or run: source ~/.bashrc) so PATH picks up mise and Bun."
