## Searching

When FFF is enabled and available, search files and contents with it through codemode. Discover registered tools with `searchTools` or `ALL_TOOLS`: override mode names them `find`, `grep` and `multi_grep`; other modes use `fffind`, `ffgrep` and `fff_multi_grep` when its alias is available, otherwise `fff-multi-grep`. Read each schema before calling it. When FFF is disabled or not offered on the host, search through the available shell with `rg` and `fd`, or system `grep` and `find` if those are unavailable. Report unexpectedly missing or failing FFF tools as a setup problem.
