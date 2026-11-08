This session runs in a cloud container. Its git committer is the platform's, and any signature that makes branch commits Verified belongs to that committer, so leave the committer alone. Commits still need the user as author, set once per clone from the GitHub account the session is connected to:

1. Read the account's name, numeric id and login with the session's GitHub tool or `gh api user`.
2. Run `${HOLYAGENT_PI_ROOT}/scripts/holyagent vcs identity --name '<name>' --email "<id>+<login>@users.noreply.github.com"` with them (the login when the name is empty). Single-quote the name and write each single quote inside it as `'\''`: a name with `$`, a backtick or a double quote breaks double quotes.

The command writes `author.name` and `author.email` to the clone's local git config, never to a file of the repository. `holyagent vcs commit` refuses a commit whose author is missing or is the agent's. The no-attribution rule covers the author and the commit text; the platform's committer is the one exception.
