#!/usr/bin/env bash
# Installs the prerequisites of HolyAgent on a clean WSL Ubuntu install: git, Node LTS, Bun and gh.
# With --dev it also installs mise, which developing this repository needs. HolyAgent itself installs
# as a Claude Code plugin; the script ends by printing those commands.
#
# Usage: bash install/wsl-install.sh [--dev]
#
# Every step checks its own result first, so a re-run changes nothing that is already right. The
# script touches $HOME (Bun, ~/.bashrc, and mise with --dev) and runs sudo only to install apt
# packages. Run it as your own user, not through sudo.
#
# What you are opting into:
# - git, curl, ca-certificates and unzip come from Ubuntu's apt; Node LTS comes from NodeSource's apt
#   repository (https://github.com/nodesource/distributions); gh comes from GitHub's apt repository
#   (https://github.com/cli/cli/blob/trunk/docs/install_linux.md). The last two add a repository to apt.
# - Bun comes from its official install script (https://bun.com/install) into ~/.bun.
# - ~/.bashrc gains a line that puts Bun's global bin directory on PATH, where `holyagent setup` puts
#   Billion Context and ctx7 (a one-time copy is kept as ~/.bashrc.pre-holyagent).
# - --dev adds mise (https://mise.run) and a line in ~/.bashrc that activates it. Bun stays a stable
#   build; developing this repository needs a canary build, which `mise install` in the checkout
#   upgrades to.
set -Eeuo pipefail

USAGE="usage: bash ${0##*/} [--dev]   (--dev also installs mise, for developing HolyAgent)"
DEV=0
if [[ $# -gt 1 ]]; then
  echo "$USAGE" >&2
  exit 2
fi
case "${1:-}" in
  "") ;;
  --dev) DEV=1 ;;
  *)
    echo "$USAGE" >&2
    exit 2
    ;;
esac

if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" ]]; then
  echo "error: run this as ${SUDO_USER}, not through sudo; it installs into the home directory and calls sudo itself when apt needs it" >&2
  exit 1
fi

TOTAL_STEPS=$((5 + DEV))
CURRENT_STEP="startup"
STEP_NUMBER=0
TMP_FILES=()
trap 'rm -f "${TMP_FILES[@]:-}"' EXIT

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

# Downloads a URL to a temporary file that is removed on exit, so a failed download runs nothing.
# The path is left in REPLY (a command substitution would lose the cleanup list).
download() {
  local file
  file=$(mktemp)
  TMP_FILES+=("$file")
  curl -fsSL "$1" -o "$file"
  REPLY=$file
}

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
MISE="${MISE_INSTALL_PATH:-$HOME/.local/bin/mise}"
BASHRC="$HOME/.bashrc"

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

# Runs a command as root: directly when this is root already, through sudo otherwise.
as_root() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    echo "error: need root to run '$*', but sudo is not available" >&2
    exit 1
  fi
}

# Whether node is installed at a version ctx7 supports (22.13 or later).
node_is_current() {
  have node && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' 2>/dev/null
}

# Bun's global bin directory comes first for the rest of this run.
export PATH="${BUN_INSTALL}/bin:${HOME}/.local/bin:${PATH}"

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

if ! have apt-get || ! have dpkg-query; then
  echo "error: this installer needs apt-get and dpkg-query (Ubuntu or Debian)" >&2
  exit 1
fi

missing=()
for pkg in curl git ca-certificates unzip; do
  if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then
    missing+=("$pkg")
  fi
done
if [[ ${#missing[@]} -eq 0 ]]; then
  note "apt packages already installed"
else
  note "missing apt packages: ${missing[*]} (using sudo; you may be asked for your password)"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
fi
note "$(git --version)"

# ---------------------------------------------------------------------------------------------
step "Node.js LTS (Billion Context and ctx7 run on Node)"

if node_is_current; then
  note "node $(node --version) already installed"
else
  if have node; then
    note "node $(node --version) is older than 22.13 (needed by ctx7); installing the LTS release"
  fi
  # NodeSource's setup script adds its apt repository for the current LTS line.
  download https://deb.nodesource.com/setup_lts.x
  as_root env DEBIAN_FRONTEND=noninteractive bash "$REPLY"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
  hash -r
fi
if ! node_is_current; then
  echo "error: node is missing or older than 22.13 after the install; check: command -v node" >&2
  exit 1
fi
note "node $(node --version)"

# ---------------------------------------------------------------------------------------------
step "Bun (the plugin's hooks run it)"

if have bun; then
  note "bun $(bun --revision) already installed"
else
  # Official installer: https://bun.com/docs/installation (installs to $BUN_INSTALL, default ~/.bun).
  download https://bun.com/install
  bash "$REPLY"
  hash -r
fi
if ! have bun; then
  echo "error: bun not found after install; check ${BUN_INSTALL}/bin" >&2
  exit 1
fi
note "bun $(bun --revision)"
# The Bun installer edits ~/.bashrc itself; this keeps the line present, and unchanged when it is.
# shellcheck disable=SC2016
printf -v bun_line 'export BUN_INSTALL=%q; export PATH="$BUN_INSTALL/bin:$PATH"' "$BUN_INSTALL"
ensure_bashrc_line '^[[:space:]]*(export[[:space:]]+)?BUN_INSTALL=' "$bun_line"

# ---------------------------------------------------------------------------------------------
step "GitHub CLI (gh)"

if have gh; then
  note "gh already installed: $(gh --version | head -n 1)"
else
  # Official apt repository: https://github.com/cli/cli/blob/trunk/docs/install_linux.md
  download https://cli.github.com/packages/githubcli-archive-keyring.gpg
  as_root mkdir -p -m 755 /etc/apt/keyrings
  as_root install -m 644 "$REPLY" /etc/apt/keyrings/githubcli-archive-keyring.gpg
  as_root mkdir -p -m 755 /etc/apt/sources.list.d
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" |
    as_root tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh
  hash -r
  note "gh $(gh --version | head -n 1)"
fi

# ---------------------------------------------------------------------------------------------
if [[ $DEV -eq 1 ]]; then
  step "mise (development: tool versions and the repository's commands)"

  if [[ -x "$MISE" ]]; then
    note "mise already installed: $("$MISE" --version)"
  else
    # Official installer: https://mise.jdx.dev/getting-started.html (installs to ~/.local/bin/mise,
    # or to MISE_INSTALL_PATH).
    download https://mise.run
    sh "$REPLY"
  fi
  if [[ ! -x "$MISE" ]]; then
    echo "error: mise not found at ${MISE} after install" >&2
    exit 1
  fi
  # shellcheck disable=SC2016
  printf -v mise_line 'eval "$(%q activate bash)"' "$MISE"
  ensure_bashrc_line '^[[:space:]]*eval .*mise.* activate bash' "$mise_line"
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

verify node node --version
verify bun bun --revision
verify git git --version
verify gh gh --version
if [[ $DEV -eq 1 ]]; then
  verify mise "$MISE" --version
fi

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

Done. Open a new shell (or run: source ~/.bashrc) so PATH picks up Bun, then install HolyAgent with
these three commands:

  claude plugin marketplace add davidbasilefilho/holyagent
  claude plugin marketplace add ranxianglei/billion-context
  claude plugin install holyagent@holyagent

On the first launch, run /holyagent:setup to install Billion Context and ctx7 and to configure
Claude Code.
EOF
