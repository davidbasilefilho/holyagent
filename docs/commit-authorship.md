# Commit authorship

Commits and PR text read as the account owner wrote them: the author and committer are the owner of the `gh` credential, and nothing in the text names an agent. The history describes the change, not the process that made it, and the owner is accountable for it. An audit of the predecessor plugin found nearly all of about 397 commits and every observed PR body carrying `Co-Authored-By`, `Claude-Session` and "Generated with" lines, because the harness injects the trailer rule and nothing in the project overrode it. `holyagent vcs` is the fix; the root never writes `git commit -m` by hand.

## `vcs detect`

`holyagent vcs detect [--refresh]` chooses how commits are made. It prints `path`, `signed`, `owner`, `identity` (the git identity), `repo`, `reason` and `cached`. The owner, identity, remote and settings are read live on every run.

| Path        | Chosen when                                                                                                            | Commits are                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `git`       | The git identity's email is the owner's (public or noreply), or no credential works and the identity is the user's own | Plain git; signed only if `commit.gpgsign` is on, so `signed` follows it                             |
| `api`       | The identity is not the owner's, `vcs.api` is not `false`, `origin` is a github.com remote and the GraphQL probe works | Made by GitHub's `createCommitOnBranch`: authored by the owner and signed by GitHub (`signed: true`) |
| `git-owner` | The identity is not the owner's and any of the `api` conditions fails                                                  | Plain git with author and committer set to the owner, `--no-gpg-sign` (`signed: false`)              |

With no working credential and a git identity that looks like an agent (`noreply@anthropic.com`, or a name starting with `Claude`), detection refuses with `NoCredential`: no commit would be the user's. Fix it with `gh auth login` or `GH_TOKEN`, or set `git config user.name` and `user.email`, then `vcs detect --refresh`.

The owner's name and email come from `GET /user`; when the email is private the noreply address `<id>+<login>@users.noreply.github.com` is used. `.holyagent/local/vcs.json` caches only the GraphQL probe and the read-back state, keyed by the inputs; any change recomputes it, and a detection made while GitHub was unreachable is never cached.

## When commits are unsigned, and why

A commit that is authored as the owner and signed without a key of yours exists on one route: GitHub's `createCommitOnBranch` mutation, which "does not support specifying the author" and signs automatically. The REST Git Database route (`POST /git/commits`) does not sign unless you send a signature, and plain git signs only with a key you configured.

Observed in Claude Code on the web sessions (October 2026), not documented behavior: `gh api graphql` returns HTTP 403 ("GitHub GraphQL is not available from Claude Code sessions") for any query, including the detection probe, and REST contents writes return 403 from the session's proxy. Detection therefore ends on `git-owner`: git commits authored and committed as the credential owner, unsigned, with `signed: false` in the output. They show no verified badge on GitHub. This is deliberate, not an error. The same happens anywhere the `api` conditions fail. `"vcs": {"api": false}` in `.holyagent/config.json` forces it when the git identity is not the owner's; when it is, the path stays `git`.

## Read-back of the first commit

The first commit of a detection is read back from GitHub (`GET /repos/{repo}/commits/{sha}`) and must show the owner as author and a signature state equal to `signed`. A match is remembered, so later commits are not read back. A mismatch fails with `VerificationMismatch`: the commit stays on GitHub, and nothing switches path on its own, so fix the credential or identity and run `vcs detect --refresh`. On the `api` path the check runs right after the commit; on the git paths the commit is recorded as pending and read after `vcs push`, once it is reachable from a pushed branch. A read that fails (no access, network) is only a note in the output and is retried next time.

## What `vcs commit` does

```text
holyagent vcs commit -m <headline> [-m <body>] -- <paths…>
```

- Stages exactly the named paths plus the folder of the Intent in use when its state changed, so state rides the work commit and never gets a commit of its own. If something else is already staged it refuses (`StagedOutsideScope`), and with nothing changed it refuses (`NothingToCommit`).
- On the `git` and `git-owner` paths it runs `git commit`, so the repository's own hooks run.
- On the `api` path it runs the repository's `pre-commit` hook, stages the paths again, requires local and remote heads to match, and appends commits with the mutation (an empty repository's first file goes through the contents endpoint; a missing remote branch is created). The API writes regular files only: a symlink, an executable file, a submodule or a mode change refuses with `UnsupportedChange`, and the fix is `"vcs": {"api": false}`. A change set over 8 MiB of request is split into several commits titled `(1/n)`, while a single file over 8 MiB is refused with `UnsupportedChange`. Afterwards the local branch is moved to the last commit.
- `vcs push` never forces and is a no-op on the `api` path (the commits are already on GitHub). `vcs branch` also creates the branch on GitHub on the `api` path. `vcs pr` opens a ready-for-review PR, or updates one with `--update <n>`, through the REST API; the body comes from a file inside the project that git does not ignore (at most 256 KiB, never under `.git`).

## Message cleaning and refusal

`vcs commit`, and the title and body of `vcs pr`, first remove:

- `Claude-Session:` trailers and claude.ai links,
- the "Generated with … Claude Code" footer line,
- `Co-authored-by:` trailers that name the agent (`Claude…` or an `anthropic.com` address); human co-authors stay.

If the cleaned text still contains one of these phrases as whole words, case-insensitively, the command refuses with `MessageRefused` (exit 3): `the user`, `user asked`, `as requested`, `the assistant`, `this session`, `subagent`, `Claude Code`, `Claude Opus`, `Claude Sonnet`, `Claude Haiku`, `Claude Fable`. A project whose domain uses a phrase legitimately lists it in `.holyagent/config.json`:

```json
{ "vcs": { "allowWords": ["subagent"] } }
```

An unknown key inside `vcs` is an error that names the file. Reword rather than allow when the phrase talks about the process; the rule exists so the history says what changed and why.

## Redirecting raw git

A `PreToolUse` hook on the Bash tool denies a `git commit` or `git push` command and names the `holyagent vcs` replacement; [hooks.md](hooks.md) has the details and its limits.

## Settings that `holyagent setup claude` writes

`attribution.commit` and `attribution.pr` as empty strings, `attribution.sessionUrl` as `false` and `includeGitInstructions` as `false` (see [usage.md](usage.md)). They stop Claude Code adding its trailer, its PR line and the session link, and remove its built-in commit and PR instructions from the context. They apply to commits made by Claude Code itself; `vcs commit` cleans the text either way.

## What the plugin cannot remove

Observed in Claude Code on the web sessions (October 2026): `PATCH /pulls` works, but the session's proxy re-appends `_Generated by [Claude Code](https://claude.ai/code)_` to PR bodies, and the same appears to apply to comment writes. The proxy runs outside the project, so neither the settings above nor the message cleaning reach it.
