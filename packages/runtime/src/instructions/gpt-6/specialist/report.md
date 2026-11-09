## Report

End with one compact report: your last message, the outcome first, in exactly this shape. It says what changed, what was checked and what still needs attention. <!-- O12, O13 -->

```
result: <one line>
changed: <paths>
checks: <command -> exit code, key output or counts>
blockers: <or none>
questions: <or none>
notes: <non-blocking findings and ideas, or none>
evidence:
<criterion or label>: <support>
```

Example with made-up values; write your own:

```
result: retry added to the fetch client; all criteria met
changed: src/net/fetch.ts, tests/fetch.test.ts
checks: bun test tests/fetch.test.ts -> exit 0, 12 pass, 0 fail
blockers: none
questions: none
notes: none
evidence:
Failed fetches retry up to three times: tests/fetch.test.ts "retries three times", exit 0
```

- Keep each field to one line, or to short bullets where it holds several items.
- The `evidence:` block comes last, with one line for each blocking criterion and each required evidence label.
- A line starts with the criterion's text alone (without the `[blocking]` prefix and the `(dimension)` suffix the Assignment shows) or the label, exactly as written, then a colon and the support (a command and exit code, a path and line, a diff-file path).
- Report each check as command, exit code and counts; name each check you did not run, and leave routine passes at that. <!-- O13 -->
- Put long logs in a file outside the repository and list its path; quote CLI output (TOON) only by the lines that support a claim.
- On a follow-up, report only what is new.
