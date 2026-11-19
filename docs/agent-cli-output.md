# Agent CLI output

The internal CLI uses plain text, even when a terminal requests color. Structured records use TOON and escape terminal control characters without changing the decoded values. Hooks keep their JSON format. Errors retain their tag, exit code and recovery steps when available.

The `rg` and `fd` wrappers stream output, pass arguments unchanged, preserve the underlying program's exit code and turn off automatic color. They display terminal control bytes as visible `\u` escapes, including when an explicit color flag produces them. Read the original file when you need exact bytes. Browser server stdio carries MCP messages, not CLI reports.
