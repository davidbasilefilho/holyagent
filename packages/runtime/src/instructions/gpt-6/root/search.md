## Searching

Search file contents with `holyagent rg` and file names with `holyagent fd`, never with grep, find or the host's own search tools. They run the ripgrep and fd that ship with HolyAgent and take those programs' own arguments, so every machine gives the same answer. Always pass the path, for example `.`: with no path and a piped or redirected stdin, rg reads stdin and reports no matches. Use the system rg, fd, grep or find only when either fails with UnsupportedPlatform. <!-- O19 -->
