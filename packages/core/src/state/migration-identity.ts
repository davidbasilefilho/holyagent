/** Native filesystem IDs are 64-bit. Never round-trip them through JavaScript numbers. */
export type MigrationFileIdentity = { readonly dev: bigint; readonly ino: bigint }

/** An unavailable file ID cannot establish ownership of a migration path. */
export const sameMigrationIdentity = (left: MigrationFileIdentity, right: MigrationFileIdentity) =>
  left.ino !== 0n && left.dev === right.dev && left.ino === right.ino
