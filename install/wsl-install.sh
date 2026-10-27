#!/usr/bin/env bash
# Installs the prerequisites of HolyAgent on a clean WSL Ubuntu install: git, Bun, Node LTS, gh and
# mise. HolyAgent itself installs as a Claude Code plugin; the script ends by printing those commands.
#
# Usage: bash install/wsl-install.sh
#
# Every step checks its own result first, so a re-run changes nothing that is already right. The
# script touches only $HOME (mise and the tools it manages, ~/.bashrc) and runs sudo only to install
# missing apt packages. Run it as your own user, not through sudo.
#
# What you are opting into:
# - ~/.bashrc gains two lines (a one-time copy is kept as ~/.bashrc.pre-holyagent): Bun's global bin
#   directory on PATH, where `holyagent setup` puts Billion Context and ctx7, and mise's activation.
# - Bun, Node LTS and gh are installed globally through mise. Bun stays a stable build; developing
#   this repository needs a canary build, which `mise install` in the checkout upgrades to.
set -Eeuo pipefail

if [[ $# -gt 0 ]]; then
  echo "usage: bash ${0##*/}   (takes no arguments)" >&2
  exit 2
fi

if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" ]]; then
  echo "error: run this as ${SUDO_USER}, not through sudo; it installs into the home directory and calls sudo itself when apt needs it" >&2
  exit 1
fi

TOTAL_STEPS=6
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

# Puts the tools mise has selected globally (node, bun, gh) and Bun's global bin directory ahead of
# the rest of PATH for the remaining steps.
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

# Selects a tool globally through mise unless mise already has a version of it.
ensure_mise_tool() {
  local tool=$1 spec=$2
  if "$MISE" where "$tool" >/dev/null 2>&1; then
    note "${tool} already selected globally"
  else
    "$MISE" use -g "$spec"
  fi
}

# ---------------------------------------------------------------------------------------------
step "Prerequisites (platform, apt packages, git)"

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
  for pkg in curl git ca-certificates unzip; do
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
  for cmd in curl git unzip; do
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

ensure_mise_tool node node@lts
refresh_path
note "node $(node --version)"
# ctx7 requires Node >= 22.13; an older global node chosen earlier would fail later and obscurely.
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
  echo "error: node $(node --version) is older than 22.13 (needed by ctx7); run: ${MISE} use -g node@lts" >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
step "Bun (the plugin's hooks run it)"

# A stable Bun is enough to run the plugin. Developing this repository needs a canary build for
# `bun check`, `bun lint` and `bun fmt`; `mise install` in the checkout upgrades it.
ensure_mise_tool bun bun
refresh_path
note "bun $(bun --revision)"

# ---------------------------------------------------------------------------------------------
step "GitHub CLI (gh)"

ensure_mise_tool gh gh
refresh_path
note "gh $(gh --version | head -n 1)"

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
verify git git --version
verify gh gh --version

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "error: verification failed for: ${failed[*]}" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  warn "gh is not authenticated; run: gh auth login (or export GH_TOKEN)"
fi
if ! have claude; then
  warn "Claude Code is not installed; see https://code.claude.com/docs/en/setup"
fi

cat <<'EOF'

Done. Open a new shell (or run: source ~/.bashrc) so PATH picks up mise and Bun, then install
HolyAgent with these three commands:

  claude plugin marketplace add davidbasilefilho/holyagent
  claude plugin marketplace add ranxianglei/billion-context
  claude plugin install holyagent@holyagent

On the first launch, run /holyagent:setup to install Billion Context and ctx7 and to configure
Claude Code.
EOF
