# Commit authorship

Commits and PR text read as the user wrote them: the author and committer are the user's own configured Git identity, and nothing in the text names an agent. The history describes the change, not the process that made it, and the owner is accountable for it. An audit of the predecessor plugin found nearly all of about 397 commits and every observed PR body carrying `Co-Authored-By`, `Claude-Session` and "Generated with" lines, because the harness injects the trailer rule and nothing in the project overrode it. `holyagent vcs commit`, `holyagent vcs pr` and the `commit-msg` hook below are the fix; the root never writes `git commit -m` by hand.

## The `vcs` commands

`holyagent vcs` has two commands. Everything else a change needs is plain Git and `gh`: branches, pushes, merges, force-push protection (a hook, below) and CI (`gh pr checks <n> --watch`).

An earlier design also detected how to commit and then committed through GitHub's API as the credential owner, read the first commit back, and wrapped pushing, branching and CI watching in commands of their own. All of that is gone: it needed a GraphQL endpoint that is blocked in some hosted sessions, signed or unsigned commits depending on the session, and a cache to explain it. Commits are now plain `git commit` with the repository's own identity and hooks, which also keeps Intent state versioned in Git like any other file.

## What `vcs commit` does

```text
holyagent vcs commit -m <headline> [-m <body>] -- <paths…>
```

- Refuses an identity that looks like an agent's (`noreply@anthropic.com`, or a name starting with `Claude`) with `AgentIdentity`: set the user's own with `git config user.name <name>` and `git config user.email <email>` in the repository.
- Stages exactly the named paths plus the changed Intent state of the worktree it runs in, so state rides the work commit and never gets a commit of its own. The state is the folder of the Intent in use; in a linked worktree, where no Intent is in use yet, it is the whole `.holyagent/intents` folder of that worktree. If something else is already staged the command refuses (`StagedOutsideScope`), and with nothing changed it refuses (`NothingToCommit`).
- Cleans and checks the message (below), then runs `git commit`, so the repository's own hooks run, a `commit-msg` hook included.

`holyagent vcs pr --base <b> --title <t> [--body-file <f>] [--update <n>]` opens a ready-for-review PR from the current branch, or updates one with `--update <n>`, through the REST API of `gh`; the body comes from a file inside the project that git does not ignore (at most 256 KiB, never under `.git`).

## Message cleaning and refusal

`vcs commit`, the title and body of `vcs pr`, and the `commit-msg` hook first remove:

- `Claude-Session:` trailers and claude.ai links,
- the "Generated with … Claude Code" footer line,
- `Co-authored-by:` trailers that name the agent (`Claude…` or an `anthropic.com` address); human co-authors stay.

If the cleaned text still contains one of these phrases as whole words, case-insensitively, the command refuses with `MessageRefused` (exit 3): `the user`, `user asked`, `as requested`, `the assistant`, `this session`, `subagent`, `Claude Code`, `Claude Opus`, `Claude Sonnet`, `Claude Haiku`, `Claude Fable`. A project whose domain uses a phrase legitimately lists it in `.holyagent/config.json`:

```json
{ "vcs": { "allowWords": ["subagent"] } }
```

An unknown key inside `vcs` is an error that names the file (an old `api` key is still read and ignored). Reword rather than allow when the phrase talks about the process; the rule exists so the history says what changed and why.

## The `commit-msg` hook

`holyagent hook commit-msg <message-file>` runs the same cleaning and check on the message file git passes to a `commit-msg` hook. It rewrites the file without the attribution lines and exits 3 on a refused message, which stops the commit, so a commit made with plain `git commit` (by the user, or by an agent that slipped past the redirect) gets the same text rule. Git's own comment lines (`core.commentString` or `core.commentChar`, `#` by default) are left alone and not checked for phrases, and so is everything after the exact scissors line (`<comment> ------------------------ >8 ------------------------`) that `git commit -v` adds before the staged diff. Attribution lines are removed from there too, since a message made by hand keeps everything below such a line. A comment string that comes only from a `-c` on the command line is ignored; the repository's files decide.

Install it in any repository as `.git/hooks/commit-msg`:

```sh
#!/bin/sh
exec "/path/to/holyagent/scripts/holyagent" hook commit-msg "$1"
```

(`chmod +x` it; the path is the plugin's `scripts/holyagent` wrapper, `${CLAUDE_PLUGIN_ROOT}/scripts/holyagent` inside a Claude Code session). With lefthook, a job under `commit-msg:` does the same:

```yaml
commit-msg:
  jobs:
    - name: attribution
      run: /path/to/holyagent/scripts/holyagent hook commit-msg {1}
```

This repository wires it that way in `lefthook.yml`, through the built wrapper in `packages/integrations/claude/dist/scripts/holyagent`.

## Redirecting raw git

A `PreToolUse` hook on the Bash tool denies a `git commit` command and names `holyagent vcs commit`, and denies a force push or a push that deletes or mirrors remote refs (`--force`, `-f`, `--force-with-lease`, `--force-if-includes`, `--mirror`, `--delete`, `-d`, `--prune`, any unambiguous abbreviation of those, a `+` or `:` refspec) and a push argument it cannot read with certainty (a variable, substitution, brace, glob or escape it does not decode); a plain `git push` with literal arguments passes. [hooks.md](hooks.md) has the details and its limits.

## Settings that `holyagent setup claude` writes

`attribution.commit` and `attribution.pr` as empty strings, `attribution.sessionUrl` as `false` and `includeGitInstructions` as `false` (see [usage.md](usage.md)). They stop Claude Code adding its trailer, its PR line and the session link, and remove its built-in commit and PR instructions from the context. They apply to commits made by Claude Code itself; `vcs commit` and the hook clean the text either way.

## What the plugin cannot remove

Observed in Claude Code on the web sessions (October 2026): `PATCH /pulls` works, but the session's proxy re-appends `_Generated by [Claude Code](https://claude.ai/code)_` to PR bodies, and the same appears to apply to comment writes. The proxy runs outside the project, so neither the settings above nor the message cleaning reach it.
