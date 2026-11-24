## Searching

Search file contents with `holyagent-cli rg` and file names with `holyagent-cli fd`. They take the installed programs' own arguments. Always pass the path, for example `.`, and read their output from the TOON `stdout` field. On `ToolMissing`, use the system grep or find and report the missing program so the user can install it.
