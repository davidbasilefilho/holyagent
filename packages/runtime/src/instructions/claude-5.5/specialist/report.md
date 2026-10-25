## Report

End with one compact report, answer first, with no narration:

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

The `evidence:` block comes last and has one line for each blocking criterion and each required evidence label. A line starts with the criterion's text alone (without the `[blocking]` prefix and the `(dimension)` suffix the Assignment shows) or the label, exactly as written, then a colon and the support (a command and exit code, a path and line, a diff-file path). Name each check you did not run. Put long logs in a file outside the repository and list its path. On a follow-up, report only what is new.
