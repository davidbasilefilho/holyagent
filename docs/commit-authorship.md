# Commit authorship

Commits and PR text read as the user wrote them: commits use the configured Git identity, the author is never an agent, and nothing in the text names an agent. The one exception is the committer of a claude.ai cloud session, which stays Claude so that branch commits are Verified (see [Cloud sessions](#cloud-sessions)). The history describes the change, not the process that made it, and the owner is accountable for it. An audit of the predecessor plugin found nearly all of about 397 commits and every observed PR body carrying `Co-Authored-By`, `Claude-Session` and "Generated with" lines, because the harness injects the trailer rule and nothing in the project overrode it. `holyagent vcs commit`, `holyagent vcs pr` and the `commit-msg` hook below are the fix; the root never writes `git commit -m` by hand.

## The `vcs` commands

`holyagent vcs` has three commands: `commit`, `pr` and `identity` (for cloud sessions). Everything else a change needs is plain Git and `gh`: branches, pushes, merges, CI (`gh pr checks <n> --watch`).

An earlier design also detected how to commit and then committed through GitHub's API as the credential owner, read the first commit back, and wrapped pushing, branching and CI watching in commands of their own. All of that is gone: it needed a GraphQL endpoint that is blocked in some hosted sessions, signed or unsigned commits depending on the session, and a cache to explain it. Commits are now plain `git commit` with the repository's own identity and hooks, while Intent state is committed by the holyagent commands on its own state branch.

## What `vcs commit` does

```text
holyagent vcs commit -m <headline> [-m <body>] -- <paths…>
```

- Refuses an identity that looks like an agent's (`noreply@anthropic.com`, or a name starting with `Claude`) with `AgentIdentity`: set the user's own with `git config user.name <name>` and `git config user.email <email>` in the repository. In a claude.ai cloud session it checks the author instead (below).
- Stages exactly the named paths and refuses any path under `.holyagent/`: Intent state is committed on the state branch by the holyagent commands, never on a work branch. If something else is already staged the command refuses (`StagedOutsideScope`), and with nothing changed it refuses (`NothingToCommit`).
- Cleans and checks the message (below), then runs `git commit`, so the repository's own hooks run, a `commit-msg` hook included.

`holyagent vcs pr --base <b> --title <t> [--body-file <f>] [--update <n>]` opens a ready-for-review PR from the current branch, or updates one with `--update <n>`, through the REST API of `gh`; the body comes from a file inside the project that git does not ignore (at most 256 KiB, never under `.git`).

## Cloud sessions

A claude.ai cloud session (`CLAUDE_CODE_REMOTE=true`) configures git with `user.name` Claude, `user.email` `noreply@anthropic.com` and an SSH signature that GitHub verifies for that committer. Probed in October 2026: a commit with the user as author and Claude as committer showed as Verified, while the user as both author and committer was `unknown_key`. So the committer stays Claude, and only the author is set to the user:

1. The session-start hook adds the steps to the context, in a cloud session only. Locally nothing about them is in the context or the root rules.
2. The root calls the GitHub connector's `get_me` (`mcp__github__get_me`) and runs `holyagent vcs identity --name <name> --email <id>+<login>@users.noreply.github.com`, with the name from `get_me` (the login when it has none) and the noreply address built from its id and login, since `get_me` returns no email.
3. `vcs identity` writes `author.name` and `author.email` to the clone's local git config (`.git/config`, shared by its worktrees), which git uses for the author without touching the committer. No value goes into a file of the repository, so the user's name and address are never committed or tracked. It refuses an identity that looks like an agent's, an email that is not an address, and a name with angle brackets or control characters.
4. `vcs commit` in a cloud session requires an author that git resolves (`GIT_AUTHOR_*`, else `author.*`, else `user.*`) and that does not look like an agent's, and leaves the committer alone. A missing or agent-looking author is refused with `CloudAuthor` (exit 3), whose hint names the `get_me` and `vcs identity` steps. Outside a cloud session the check on `user.name` and `user.email` above is unchanged.

The no-attribution rule covers the author and the commit text; the Claude committer of a cloud session is its documented exception. The `commit-msg` hook, the message cleaning and the committer's signature are unaffected.

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

`holyagent hook commit-msg <message-file>` runs the same cleaning and check on the message file git passes to a `commit-msg` hook. It rewrites the file without the attribution lines and exits 3 on a refused message, which stops the commit, so a commit made with plain `git commit` (by the user, or by an agent that ran it anyway) gets the same text rule. Git's own comment lines (`core.commentString` or `core.commentChar`, `#` by default) are left alone and not checked for phrases, and so is everything after the exact scissors line (`<comment> ------------------------ >8 ------------------------`) that `git commit -v` adds before the staged diff. Attribution lines are removed from there too, since a message made by hand keeps everything below such a line. A comment string that comes only from a `-c` on the command line is ignored; the repository's files decide.

Install it in any repository as `.git/hooks/commit-msg`:

```sh
#!/bin/sh
exec bun --no-env-file "--config=/path/to/holyagent/scripts/empty-bunfig.toml" "/path/to/holyagent/scripts/holyagent.js" hook commit-msg "$1"
```

(`chmod +x` it; `/path/to/holyagent/scripts` is the plugin's `scripts` folder, `${CLAUDE_PLUGIN_ROOT}/scripts` inside a Claude Code session. Git for Windows runs this `sh` file too.) With lefthook, a job under `commit-msg:` does the same, and needs no shell syntax, so it runs the same on Windows:

```yaml
commit-msg:
  jobs:
    - name: attribution
      run: >-
        bun --no-env-file --config=/path/to/holyagent/scripts/empty-bunfig.toml
        /path/to/holyagent/scripts/holyagent.js hook commit-msg {1}
```

This repository wires it that way in `lefthook.yml`, through the built bundle in `packages/integrations/claude/dist/scripts/holyagent.js`.

## Raw git commits

The rule that commits go through `holyagent vcs commit` is instruction text, not a guard: the root's and the specialists' texts state it, a `SubagentStart` hook restates it to every specialist at its start, and a `PreToolUse` hook on the Bash tool adds a one-line reminder to a command that mentions `git` and then `commit` or `push`. No hook denies or rewrites a command, so a raw `git commit` still runs; its message gets the `commit-msg` hook above where that is installed. [hooks.md](hooks.md) has the details and the reason is in [decisions.md](decisions.md).

## Settings that `holyagent setup` writes

`attribution.commit` and `attribution.pr` as empty strings, `attribution.sessionUrl` as `false` and `includeGitInstructions` as `false`, in your user settings (see [usage.md](usage.md#user-settings)). They stop Claude Code adding its trailer, its PR line and the session link, and remove its built-in commit and PR instructions from the context. They apply to commits made by Claude Code itself; `vcs commit` and the hook clean the text either way.

## What the plugin cannot remove

Observed in Claude Code on the web sessions (October 2026): `PATCH /pulls` works, but the session's proxy re-appends `_Generated by [Claude Code](https://claude.ai/code)_` to PR bodies, and the same appears to apply to comment writes. The proxy runs outside the project, so neither the settings above nor the message cleaning reach it.
