## Searching

Search file contents with `holyagent rg` and file names with `holyagent fd`, never with grep, find or the host's own search tools. They run the ripgrep and fd installed on the machine (fd is `fdfind` on Debian and Ubuntu) and take those programs' own arguments. Always pass the path, for example `.`: with no path and a piped or redirected stdin, rg reads stdin and reports no matches. When either fails with ToolMissing, the program is not installed: search with the system grep or find, and report the missing program so the user can install it. <!-- O19 -->
