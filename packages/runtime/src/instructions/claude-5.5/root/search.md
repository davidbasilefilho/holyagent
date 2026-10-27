## Searching

Search file contents with `holyagent rg` and file names with `holyagent fd`, not with grep, find or the Grep and Glob tools. They run the ripgrep and fd that ship with the plugin and take those programs' own arguments, so one known version answers the same on every machine. Always pass the path, for example `.`: with an open stdin and no path, rg searches stdin and reports no matches. When either fails with UnsupportedPlatform, use the system rg, fd, grep or find.
