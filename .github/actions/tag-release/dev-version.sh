#!/usr/bin/env bash
set -euo pipefail

[[ "${GITHUB_REF:-}" == refs/heads/dev ]] || { echo 'Development releases require dev' >&2; exit 1; }
[[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
version="$(jq -r .version package.json)"
[[ "$version" =~ ^(0\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))(-[1-9][0-9]*)?$ ]] || { echo 'Invalid version' >&2; exit 1; }
version="${BASH_REMATCH[1]}"
timestamp="$(git show -s --format=%ct "$GITHUB_SHA")"
[[ "$timestamp" =~ ^[0-9]+$ ]] || { echo 'Invalid commit timestamp' >&2; exit 1; }
printf '%s-dev.%s.g%s\n' "$version" "$(date -u -d "@$timestamp" +%Y-%m-%d.%H-%M-%S)" "${GITHUB_SHA:0:7}"
