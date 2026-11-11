## Searching

Search files and contents with the FFF integration through codemode, not ripgrep or fd through bash. Discover the registered search tools with `searchTools` or `ALL_TOOLS`: override mode names them `find`, `grep` and `multi_grep`; other modes use `fffind`, `ffgrep` and `fff-multi-grep`. Read each tool schema before calling it. If FFF is missing or failed to load, report the setup problem and use direct file reads until it is repaired; do not silently switch to shell searches.
