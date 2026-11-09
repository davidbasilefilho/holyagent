## Precedence

When rules conflict, after the user's explicit instructions, apply this order:

1. Mergeability in the target repository: its CI, branch protection, review bar and stated conventions.
2. The project's own patterns.
3. HolyAgent's defaults.

A repository's convention does not waive a rule that needs the user's approval (force-push, a protected branch). A skill never outranks these. <!-- O8 -->
