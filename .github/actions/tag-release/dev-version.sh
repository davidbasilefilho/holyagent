#!/usr/bin/env bash
set -euo pipefail

[[ "${GITHUB_REF:-}" == refs/heads/dev ]] || { echo 'Development releases require dev' >&2; exit 1; }
[[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
version="$(jq -r .version package.json)"
[[ "$version" =~ ^(0\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))(-[1-9][0-9]*)?$ ]] || { echo 'Invalid version' >&2; exit 1; }
version="${BASH_REMATCH[1]}"
timestamp="$(TZ=UTC0 git show -s --format=%cd --date=format-local:%Y-%m-%d.%H-%M-%S "$GITHUB_SHA")"
[[ "$timestamp" =~ ^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])\.([01][0-9]|2[0-3])-[0-5][0-9]-[0-5][0-9]$ ]] || { echo 'Invalid commit timestamp' >&2; exit 1; }
printf '%s-dev.%s.g%s\n' "$version" "$timestamp" "${GITHUB_SHA:0:7}"
