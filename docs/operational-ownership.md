# Operational ownership

An Assignment that writes outside the project can declare `operationalResources` as, for example, `[{"kind":"local-path","target":"/absolute/path"}]`. Windows uses an absolute path in its own syntax. A writer must declare at least one operational resource or repository `ownershipPaths` entry; it can declare both. Repository paths remain relative and portable and cannot contain `..`.

The runtime resolves existing symlinks and the closest existing parent, refuses unresolved paths and checks both the supplied and resolved target against locally registered worktrees. A target cannot contain a worktree or be inside one. Validation runs at creation and again at dispatch, since paths can change. A dangling symlink is refused. Comparisons ignore case conservatively, including on case-sensitive filesystems.

An operational writer is serialized against every Running writer sharing the state store, regardless of worktree. Repository-only writers retain their existing overlap and worktree rules. This intentionally sacrifices parallelism for a clear scheduling boundary; it does not make claims about whether two external targets overlap.

These reservations coordinate only through the same state store. They do not identify hosts, establish whether different mounts or machines refer to the same data, prevent path changes after dispatch, enforce filesystem permissions, or authenticate user approval. Other stores and independently operating processes do not participate. Unknown Running workers stay Running until their status is confirmed through the normal reconciliation process.
