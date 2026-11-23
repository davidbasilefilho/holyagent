# Ecosystems

Research dated 2026-11-04, from each tool's own docs. **Verify** marks a command or range syntax that was not confirmed in research or comes from general knowledge: check it with web search or fetch before running or writing it.

Mode 1 is the lockfile-only upgrade within declared ranges. Mode 2 bumps declared ranges to latest, then relocks.

## Commands

| Ecosystem | Mode 1: lockfile only | Mode 2: bump declared ranges, then relock |
|---|---|---|
| bun | `bun update` also rewrites `package.json` to the newest in-range version and keeps the operator (`^1.1.0` becomes `^1.2.0`). Restore the previous ranges, then run `bun install`: it keeps the updated versions in `bun.lock` and the restored ranges in `package.json` (tested with Bun 1.4.4 on one registry dependency; `bun install --frozen-lockfile` then passes). `--no-save` touches neither file. `bun outdated` shows Current, Update (in range) and Latest. | `bun update --latest`, which keeps the operator but moves a peer-range dependency such as `~1.7.16` to the newest version (tested with Bun 1.4.4: `~18.0.0` became `~19.3.1`): restore it afterwards, then `bun install` |
| npm | `npm update` (does not edit `package.json` unless `--save` is added) | `npx npm-check-updates -u` (edits `package.json` only, keeps the operator), then `npm install` |
| pnpm | `pnpm up --no-save`; plain `pnpm up` also rewrites the in-range specifier. **Verify** that `--no-save` still updates the lockfile. | `pnpm up --latest`. **Verify** `-r` for workspaces. |
| yarn (berry) | `yarn up -R <pkg>` re-resolves into the lockfile without touching manifests | `yarn up <pkg>` goes to latest project-wide and ignores listed ranges; `-C`, `-E`, `-T` set the modifier |
| cargo | `cargo update`; `cargo update <spec>` is conservative; `--precise`, `--dry-run` | `cargo upgrade` (from cargo-edit). **Verify** `--incompatible` for major bumps. `cargo update --breaking` is nightly-only (`-Z unstable-options`, tracking issue rust-lang/cargo#12425); **verify** whether it has stabilised. |
| uv | `uv lock --upgrade`, or `uv lock --upgrade-package <pkg>` (also `<pkg>==<ver>`) | No dedicated command found. `uv add "pkg>X" --upgrade-package pkg` rewrites one constraint. **Verify** whether `uv add --upgrade` exists; otherwise edit `pyproject.toml`, then `uv lock --upgrade`. |
| poetry | `poetry update` (`--lock` for lockfile only; never edits `pyproject.toml`); `poetry show --outdated` | `poetry add pkg@latest` per package. `poetry up --latest` belongs to the third-party `poetry-plugin-up`. |
| pip-tools | `pip-compile --upgrade`, or `--upgrade-package pkg`. **Verify** flags (sourced from third-party posts). | Edit `requirements.in`, then `pip-compile`. No bump command found. |
| go | `go get -u ./...` (minor and patch of all dependencies, excludes test dependencies; `-t` adds them; `-u=patch` for patch only), then `go mod tidy`; `go list -m -u all` lists updates | `go get pkg@latest` per module. Major bumps change the import path (`/v5`), so they are manual. |
| composer | `composer update [pkg]` (`-w` or `-W` with dependencies; never edits `composer.json`); `composer outdated` | `composer require vendor/pkg:^N`. `composer bump` raises lower bounds to the installed version (not for libraries, except `--dev-only`). |
| bundler | `bundle update --all` (`--patch`, `--minor`, `--major`; default major) | No built-in bump. Edit the Gemfile, then `bundle update --all`. |
| mix | `mix deps.update --all` (or `<dep>`) | Edit the `mix.exs` requirement, then `mix deps.update --all`. |
| dotnet | `dotnet package list --outdated` lists (.NET 10 verb form; `dotnet list package` before it) | `dotnet package update [pkg[@ver]]` goes to the highest version (.NET 10 form). Central Package Management keeps versions in `Directory.Packages.props`. |
| gradle | `./gradlew dependencies --write-locks`, or `--update-locks group:name[,...]` | No built-in bump. The third-party `littlerobots/version-catalog-update-plugin` adds `./gradlew versionCatalogUpdate`. **Verify** before use. |
| maven | No lockfile. | `mvn versions:display-dependency-updates`, `versions:use-latest-releases`, `versions:update-properties` (versions-maven-plugin; options `allowMajorUpdates`, `allowMinorUpdates`) |
| swift pm | `swift package update` rewrites `Package.resolved` to the latest eligible versions | Edit the `from:` requirement by hand. No command found. |
| dart / flutter | `dart pub upgrade` | `dart pub upgrade --major-versions` rewrites `pubspec.yaml`; preview with `--dry-run`; `--tighten` raises lower bounds; `dart pub outdated`. **Verify** that `flutter pub upgrade` has the same flags. |

Where the table says to edit by hand, edit the manifest (a script is fine) and relock with the Mode 1 command.

## Writing the range format

The target is the interval of the caret with zeroed lower parts: `^A.0.0` for `A >= 1`, `^0.B.0` for `0.B`, `^0.0.C` for `0.0.C`.

| Ecosystem | How to write it |
|---|---|
| bun, npm, pnpm, yarn | `^A.0.0`, `^0.B.0`, `^0.0.C`. Bun, pnpm and npm-check-updates preserve the operator when they rewrite a range, so fix the zeroed parts afterwards, except a dependency kept on its peer range (for example `~1.7.16`), which you restore if the tool rewrote it. Never write a bare major for a 0.x dependency: `^0.y` allows only patch updates. |
| cargo | `^` is the default operator, so `"A.0.0"` and `"^A.0.0"` both mean the caret. Only changes to the left-most non-zero component count as breaking. |
| composer | `^A.0` for `A >= 1` (allows `>=A.0.0 <A+1`). For 0.x versions **verify** how `^0.B` is read, and write all three parts, as in `^0.B.0`. |
| dart, poetry | Caret syntax: `^A.0.0`, `^0.B.0`, `^0.0.C`. Both follow Cargo-like caret rules (**verify**). |
| nuget | No caret. Interval notation: `[A.0.0, A+1.0.0)`, `[0.B.0, 0.B+1.0)`, `[0.0.C]`. |
| swift pm | No caret. `from: "A.0.0"` means up to the next major. For 0.x **verify** `.upToNextMinor(from:)`. |
| uv, pip-tools | No caret in version specifiers. Write the interval, for example `>=A.0.0,<A+1`, `>=0.B.0,<0.B+1`, `==0.0.C` (**verify** compatible-release `~=` equivalents). |
| bundler, mix | `~>` is the pessimistic operator, not a caret (**verify** its reading for 0.x and 0.0.x versions). Write the closest equivalent interval and tell the user it is an approximation. |
| maven, gradle | No caret. Use the version-range interval syntax (**verify**) or state that the build file pins one version. |
| go | No ranges: `go.mod` holds a minimum version, and the major lives in the import path. The format cannot be expressed; tell the user and keep the minimum at the latest version `go get` sets. |

Where an equivalent is only an approximation, or the format cannot be expressed, say so in the report. Do not leave the declaration at a wider or looser range without telling the user.
