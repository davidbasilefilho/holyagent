import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"

import { Data, Effect, Schema } from "effect"

import { pathProblem, pathsOverlap } from "../domain/paths.ts"

/** Recovery data is private to one migration and is never included in error messages. */
export const MigrationJournalFile = Schema.Struct({
  path: Schema.String,
  before: Schema.NullOr(Schema.String),
  after: Schema.String,
  content: Schema.String,
  mode: Schema.Int,
})
/** A recorded target file. */
export type MigrationJournalFile = typeof MigrationJournalFile.Type

/** Schema for a recorded source preimage. */
export const MigrationJournalSource = Schema.Struct({
  path: Schema.String,
  digest: Schema.String,
  tracked: Schema.Boolean,
})
/** A recorded source preimage. */
export type MigrationJournalSource = typeof MigrationJournalSource.Type

/** Schema for the durable transaction phase. */
export const MigrationJournalPhase = Schema.Literals([
  "prepared",
  "ref-published",
  "target-published",
  "source-cleaned",
])
/** A durable transaction phase. */
export type MigrationJournalPhase = typeof MigrationJournalPhase.Type

/** All paths are relative to their respective root, except the two canonical bound roots. */
export const MigrationJournal = Schema.Struct({
  version: Schema.Literal(1),
  transaction: Schema.String,
  sourceRoot: Schema.String,
  targetRoot: Schema.String,
  branch: Schema.String,
  parent: Schema.String,
  commit: Schema.String,
  tree: Schema.String,
  indexBefore: Schema.String,
  indexAfter: Schema.String,
  files: Schema.Array(MigrationJournalFile),
  source: Schema.Array(MigrationJournalSource),
  phase: MigrationJournalPhase,
})
/** A validated durable transaction record. */
export type MigrationJournal = typeof MigrationJournal.Type

/** Journal failures never print journal data, which can include state contents. */
export class MigrationJournalError extends Data.TaggedError("MigrationJournalError")<{
  readonly path: string
  readonly reason: string
}> {
  /** A diagnostic that excludes record contents. */
  override get message() {
    return `Migration recovery journal at ${this.path}: ${this.reason}`
  }
}

/** The caller derives `path` from trusted repository metadata, not from journal content. */
export interface MigrationJournalLocation {
  readonly path: string
  readonly sourceRoot: string
  readonly targetRoot: string
}

const MAX_BYTES = 16 * 1024 * 1024
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const PHASES: ReadonlyArray<MigrationJournalPhase> = [
  "prepared",
  "ref-published",
  "target-published",
  "source-cleaned",
]
const decode = Schema.decodeUnknownSync(MigrationJournal, { onExcessProperty: "error" })

const invalid = (location: MigrationJournalLocation, reason: string) =>
  new MigrationJournalError({ path: location.path, reason })

const canonicalAbsolute = (path: string) => isAbsolute(path) && resolve(path) === path
const isMissing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

/** Check the complete record, including invariants not expressible by its structural schema. */
const validate = (location: MigrationJournalLocation, value: unknown): MigrationJournal => {
  let record: MigrationJournal
  try {
    record = decode(value)
  } catch {
    throw invalid(location, "invalid or unsupported journal; inspect it before retrying")
  }
  const validBranch =
    record.branch.length > 0 &&
    !record.branch.startsWith("-") &&
    !record.branch.startsWith("/") &&
    !record.branch.endsWith("/") &&
    !record.branch.endsWith(".") &&
    !record.branch.includes("..") &&
    !record.branch.includes("@{") &&
    !Array.from(record.branch).some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    ) &&
    !["~", "^", ":", "?", "*", "[", "\\"].some((char) => record.branch.includes(char)) &&
    record.branch
      .split("/")
      .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  const validContent = (content: string) =>
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content) &&
    Buffer.from(content, "base64").toString("base64") === content
  const matchesBlob = (file: MigrationJournalFile) => {
    const bytes = Buffer.from(file.content, "base64")
    return (
      createHash(file.after.length === 40 ? "sha1" : "sha256")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex") === file.after
    )
  }
  const filePaths = record.files.map((file) => file.path)
  const sourcePaths = record.source.map((file) => file.path)
  const unique = (paths: ReadonlyArray<string>) =>
    paths.every(
      (path, i) =>
        pathProblem(path) === undefined &&
        !paths.slice(0, i).some((prior) => pathsOverlap(prior, path)),
    )
  if (
    !canonicalAbsolute(record.sourceRoot) ||
    !canonicalAbsolute(record.targetRoot) ||
    record.sourceRoot !== location.sourceRoot ||
    record.targetRoot !== location.targetRoot ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(record.transaction) ||
    !validBranch ||
    ![record.parent, record.commit, record.tree].every((oid) => OID.test(oid)) ||
    ![record.indexBefore, record.indexAfter].every((hash) => FINGERPRINT.test(hash)) ||
    !unique(filePaths) ||
    !unique(sourcePaths) ||
    !record.files.every(
      (file) =>
        (file.before === null || OID.test(file.before)) &&
        OID.test(file.after) &&
        (file.mode === 0o100644 || file.mode === 0o100755) &&
        validContent(file.content) &&
        matchesBlob(file),
    ) ||
    !record.source.every((file) => OID.test(file.digest))
  )
    throw invalid(location, "invalid journal fields or root binding; inspect it before retrying")
  return record
}

const owner = (info: { uid: number; mode: number }) =>
  (typeof process.getuid !== "function" || info.uid === process.getuid()) &&
  (info.mode & 0o022) === 0

const runWindowsAcl = promisify(execFile)
const windowsAclCheck = `
$ErrorActionPreference = 'Stop'
$step = 'identify'
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $allowed = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')
  $parent = $env:HOLYAGENT_JOURNAL_ACL_PARENT
  if ($env:HOLYAGENT_JOURNAL_ACL_CREATE -eq '1') {
    # Only the final, new private directory may be created here; leave existing ACLs alone.
    if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($parent))) {
      'missing-ancestor'; exit 0
    }
    $step = 'build-directory-dacl'
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($identity)
    foreach ($sid in $allowed) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($sid),
        [Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
         [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
      $security.AddAccessRule($rule)
    }
    $step = 'create-directory'
    [void][IO.Directory]::CreateDirectory($parent, $security)
    'ok'; exit 0
  }
  $sidType = [Security.Principal.SecurityIdentifier]
  $paths = @($parent, $env:HOLYAGENT_JOURNAL_ACL_FILE)
  foreach ($path in $paths) {
    if ([string]::IsNullOrEmpty($path)) { continue }
    if ([IO.Directory]::Exists($path)) {
      $step = 'get-directory-acl'
      $acl = [IO.Directory]::GetAccessControl($path)
    } else {
      $step = 'get-file-acl'
      $acl = [IO.File]::GetAccessControl($path)
    }
    $step = 'get-owner'
    $owner = $acl.GetOwner($sidType)
    if ($null -eq $owner -or $allowed -notcontains $owner.Value) { 'untrusted-owner'; exit 0 }
    # A NULL DACL permits everyone; only an explicit discretionary ACL qualifies.
    $step = 'encode-descriptor'
    $bytes = $acl.GetSecurityDescriptorBinaryForm()
    $step = 'decode-descriptor'
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new([byte[]]$bytes, 0)
    if ($null -eq $raw.DiscretionaryAcl) { 'missing-dacl'; exit 0 }
    $dacl = $raw.DiscretionaryAcl
    $step = 'count-aces'
    $count = $dacl.Count
    for ($index = 0; $index -lt $count; $index++) {
      # Use the typed indexer; avoid Windows PowerShell's non-generic collection adapter.
      $step = 'index-ace'
      $ace = $dacl.get_Item($index)
      if ($ace -isnot [Security.AccessControl.CommonAce]) { 'unsupported-ace'; exit 0 }
      $step = 'inspect-ace-flags'
      $qualifier = [int]$ace.AceQualifier
      $flags = [int]$ace.AceFlags
      $allow = [int][Security.AccessControl.AceQualifier]::AccessAllowed
      $inheritOnly = [int][Security.AccessControl.AceFlags]::InheritOnly
      if ($qualifier -eq $allow -and ($flags -band $inheritOnly) -eq 0) {
        $step = 'inspect-ace-sid'
        if ($allowed -notcontains $ace.SecurityIdentifier.Value) { 'untrusted-grant'; exit 0 }
      }
    }
  }
  'ok'
} catch {
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  'acl-operation-failed:{0}:{1}:{2:X8}' -f $step, $exception.GetType().Name, $exception.HResult
}
exit 0
`

// Windows stat permission bits are synthesized. Check the native DACL rather than
// treating writable NTFS entries as world-writable or trusting them without checking.
const windowsAclProblem = async (
  parent: string,
  options: { file?: string; create?: true } = {},
) => {
  const system = process.env["SystemRoot"] ?? process.env["SYSTEMROOT"] ?? process.env["windir"]
  if (system === undefined || !isAbsolute(system)) return "missing Windows system directory"
  try {
    const { stdout } = await runWindowsAcl(
      join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsAclCheck, "utf16le").toString("base64"),
      ],
      {
        env: {
          SystemRoot: system,
          HOLYAGENT_JOURNAL_ACL_PARENT: parent,
          ...(options.file === undefined ? {} : { HOLYAGENT_JOURNAL_ACL_FILE: options.file }),
          ...(options.create === undefined ? {} : { HOLYAGENT_JOURNAL_ACL_CREATE: "1" }),
        },
        windowsHide: true,
        timeout: 5_000,
      },
    )
    const result = stdout.trim()
    if (result === "ok") return undefined
    if (/^acl-operation-failed:[a-z-]+:[a-zA-Z]{1,60}:[0-9A-F]{8}$/.test(result)) return result
    return [
      "untrusted-owner",
      "missing-dacl",
      "unsupported-ace",
      "untrusted-grant",
      "missing-ancestor",
    ].includes(result)
      ? result
      : "invalid ACL check response"
  } catch {
    return "cannot run Windows ACL check"
  }
}

/** Create only the journal's new private directory; do not alter existing permissions. */
export const ensureMigrationJournalDirectory = async (directory: string) => {
  if (process.platform !== "win32") {
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (cause) {
      if (
        !(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")
      )
        throw cause
    }
    return
  }
  const ancestor = dirname(directory)
  if (!canonicalAbsolute(directory) || (await realpath(ancestor)) !== ancestor)
    throw new Error("journal directory ancestor is not a canonical directory")
  const problem = await windowsAclProblem(directory, { create: true })
  if (problem !== undefined) throw new Error(`cannot create private journal directory: ${problem}`)
}

/** A crash after the exclusive link may leave our synced temporary name as a second link. */
const temporaryAlias = async (
  location: MigrationJournalLocation,
  info: { dev: number; ino: number },
) => {
  const prefix = `${basename(location.path)}.`
  const names = await readdir(dirname(location.path))
  const candidates = names.filter(
    (name) => name.startsWith(prefix) && /^[0-9a-f-]{36}\.tmp$/.test(name.slice(prefix.length)),
  )
  const aliases: Array<string> = []
  for (const name of candidates) {
    const path = join(dirname(location.path), name)
    try {
      const entry = await lstat(path)
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.dev === info.dev &&
        entry.ino === info.ino
      )
        aliases.push(path)
    } catch (cause) {
      if (!isMissing(cause)) throw cause
    }
  }
  return aliases
}

const removeTemporaryAlias = async (location: MigrationJournalLocation) => {
  const info = await lstat(location.path)
  if (info.nlink === 2) {
    const aliases = await temporaryAlias(location, info)
    if (aliases.length !== 1) throw invalid(location, "journal has an unexpected hard link")
    await rm(aliases[0]!)
  }
}

/** Require trusted canonical existing roots and a private, non-link journal parent. */
const checkLocation = async (location: MigrationJournalLocation) => {
  if (![location.path, location.sourceRoot, location.targetRoot].every(canonicalAbsolute))
    throw invalid(location, "journal path and trusted roots must be canonical absolute paths")
  try {
    const parent = dirname(location.path)
    const [directory, actualParent, source, target, sourceInfo, targetInfo] = await Promise.all([
      lstat(parent),
      realpath(parent),
      realpath(location.sourceRoot),
      realpath(location.targetRoot),
      lstat(location.sourceRoot),
      lstat(location.targetRoot),
    ])
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      actualParent !== parent ||
      !sourceInfo.isDirectory() ||
      !targetInfo.isDirectory() ||
      source !== location.sourceRoot ||
      target !== location.targetRoot ||
      (process.platform !== "win32" && !owner(directory))
    )
      throw invalid(
        location,
        "journal parent or trusted roots are not private canonical directories",
      )
  } catch (cause) {
    if (cause instanceof MigrationJournalError) throw cause
    throw invalid(location, "cannot verify journal parent and trusted roots")
  }
}

const read = async (location: MigrationJournalLocation): Promise<MigrationJournal | undefined> => {
  await checkLocation(location)
  let handle
  try {
    handle = await open(location.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (cause) {
    if (isMissing(cause)) return undefined
    throw invalid(location, "cannot safely open journal; inspect it before retrying")
  }
  try {
    const [info, pathInfo] = await Promise.all([handle.stat(), lstat(location.path)])
    if (
      !info.isFile() ||
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      (process.platform !== "win32" && (!owner(info) || (info.mode & 0o077) !== 0)) ||
      info.dev !== pathInfo.dev ||
      info.ino !== pathInfo.ino ||
      info.size > MAX_BYTES
    )
      throw invalid(location, "journal is not an owned private regular file")
    if (
      info.nlink !== 1 &&
      !(info.nlink === 2 && (await temporaryAlias(location, info)).length === 1)
    )
      throw invalid(location, "journal has an unexpected hard link")
    if (process.platform === "win32") {
      const problem = await windowsAclProblem(dirname(location.path), { file: location.path })
      if (problem !== undefined)
        throw invalid(
          location,
          `journal or its parent does not have a private access list: ${problem}`,
        )
      const checkedPath = await lstat(location.path)
      if (
        checkedPath.isSymbolicLink() ||
        checkedPath.dev !== info.dev ||
        checkedPath.ino !== info.ino
      )
        throw invalid(location, "journal changed while verifying its access list")
    }
    const text = await handle.readFile("utf8")
    if (Buffer.byteLength(text) > MAX_BYTES) throw invalid(location, "journal exceeds size limit")
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw invalid(location, "journal is corrupt; inspect it before retrying")
    }
    return validate(location, value)
  } finally {
    await handle.close()
  }
}

const syncDirectory = async (location: MigrationJournalLocation) => {
  // Windows does not support opening directories for fsync. File replacement remains atomic there.
  if (process.platform === "win32") return
  const directory = await open(dirname(location.path), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

const encoded = (location: MigrationJournalLocation, record: MigrationJournal) => {
  validate(location, record)
  const contents = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(contents) > MAX_BYTES) throw invalid(location, "journal exceeds size limit")
  return contents
}

const write = async (
  location: MigrationJournalLocation,
  record: MigrationJournal,
  create: boolean,
) => {
  const contents = encoded(location, record)
  const temporary = `${location.path}.${crypto.randomUUID()}.tmp`
  let handle
  try {
    if (process.platform === "win32") await checkLocation(location)
    handle = await open(temporary, "wx", 0o600)
    if (process.platform === "win32") {
      const problem = await windowsAclProblem(dirname(location.path), { file: temporary })
      if (problem !== undefined)
        throw invalid(location, `cannot create a private journal in this directory: ${problem}`)
      const [info, checkedPath] = await Promise.all([handle.stat(), lstat(temporary)])
      if (
        checkedPath.isSymbolicLink() ||
        checkedPath.dev !== info.dev ||
        checkedPath.ino !== info.ino
      )
        throw invalid(location, "temporary journal changed while verifying its access list")
    }
    await handle.writeFile(contents, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    // Link is create-exclusive; it cannot replace a foreign or corrupt journal.
    if (create) {
      await link(temporary, location.path)
      await rm(temporary)
    } else await rename(temporary, location.path)
    await syncDirectory(location)
  } finally {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

const operation = <A>(location: MigrationJournalLocation, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof MigrationJournalError
        ? cause
        : invalid(location, "journal I/O failed; inspect it before retrying"),
  })

/** Read only. Callers must block ordinary readers if any pending journal exists. */
export const readMigrationJournal = (location: MigrationJournalLocation) =>
  operation(location, () => read(location))

/**
 * Caller holds the initialization/state lock. An authorized small atomic write is allowed to finish
 * on interruption. A foreign existing file is never replaced.
 */
export const beginMigrationJournal = <E>(
  location: MigrationJournalLocation,
  record: MigrationJournal,
  authorize: Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    if (record.phase !== "prepared")
      return yield* invalid(location, "a new journal must be prepared")
    yield* operation(location, async () => {
      encoded(location, record)
      if ((await read(location)) !== undefined)
        throw invalid(location, "a journal already exists; recover it first")
    })
    yield* authorize
    yield* Effect.uninterruptible(operation(location, () => write(location, record, true)))
  })

/** Compare transaction and phase, then advance exactly one step; immutable data is retained. */
export const advanceMigrationJournal = <E>(
  location: MigrationJournalLocation,
  transaction: string,
  expected: MigrationJournalPhase,
  next: MigrationJournalPhase,
  authorize: Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    if (PHASES.indexOf(next) !== PHASES.indexOf(expected) + 1)
      return yield* invalid(location, "invalid journal phase transition")
    const current = yield* operation(location, () => read(location))
    if (current === undefined || current.transaction !== transaction || current.phase !== expected)
      return yield* invalid(location, "journal changed or is missing; reload recovery state")
    yield* authorize
    return yield* Effect.uninterruptible(
      operation(location, async () => {
        const latest = await read(location)
        if (latest === undefined || JSON.stringify(latest) !== JSON.stringify(current))
          throw invalid(location, "journal changed during authorization; reload recovery state")
        await removeTemporaryAlias(location)
        const updated: MigrationJournal = { ...current, phase: next }
        await write(location, updated, false)
        return updated
      }),
    )
  })

/** Remove only the exact completed transaction, after the caller verifies coherent publication. */
export const finishMigrationJournal = <E>(
  location: MigrationJournalLocation,
  transaction: string,
  authorize: Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    const current = yield* operation(location, () => read(location))
    if (
      current === undefined ||
      current.transaction !== transaction ||
      current.phase !== "source-cleaned"
    )
      return yield* invalid(location, "journal is missing, changed, or not complete")
    yield* authorize
    yield* Effect.uninterruptible(
      operation(location, async () => {
        const latest = await read(location)
        if (latest === undefined || JSON.stringify(latest) !== JSON.stringify(current))
          throw invalid(location, "journal changed during authorization; reload recovery state")
        await removeTemporaryAlias(location)
        await rm(location.path)
        await syncDirectory(location)
      }),
    )
  })
