# Owned guidance

HolyAgent packages situational guidance under `guidance/<family>/<name>/SKILL.md`. Generated root and specialist prompts contain the relevant paths and triggers; read a file when its situation arises. The root delegates library-documentation lookup. The guidance is role-appropriate routing, not an access-control boundary. User and third-party skills remain available under the host's normal discovery and permissions.

The former HolyAgent skill entries, including `/holyagent:visual-judging`, are no longer advertised as plugin skills. Read the path in the generated router instead; for visual work the root includes the chosen platform file's absolute path in the specialist's criteria. Pi selects the installed provider's family. This change does not remove or modify separately installed user or third-party resources.

Setup no longer runs `ctx7 setup --cli --claude`; it installs the CLI as before. Existing Context7 skills, rules and credentials are left alone. Manage older external installations yourself. `doctor` checks whether the CLI is available, not whether authentication or the remote service is ready. The owned documentation-lookup guidance also permits primary documentation and user-selected providers.

Context7 command syntax was checked against the [ctx7 0.11.1 package README](https://registry.npmjs.org/ctx7/-/ctx7-0.11.1.tgz), examples under “Search for a library” and “Fetch documentation”; use `ctx7 --help` for the installed version.

Pi's SDK resource loader fixture exercises generated package paths with an unrelated user skill. It is not a live Pi child session. Claude's documented default plugin skill folder is `skills/`; the generator emits no such folder or manifest advertisement. The [plugin reference](https://code.claude.com/docs/en/plugins-reference#environment-variables) documents plugin-root substitution in agent content. No live Claude or model session is exercised, and host-native per-role discovery filtering is not claimed.
