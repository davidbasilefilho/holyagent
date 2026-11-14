import * as sync from "node:fs"
import * as promises from "node:fs/promises"

import { Context, Effect, Option } from "effect"

/** Filesystem methods used by host operations, including descriptor-based reads. */
export const nodeFileSystem = {
  get chmod() {
    return promises.chmod
  },
  get lstat() {
    return promises.lstat
  },
  get mkdir() {
    return promises.mkdir
  },
  get open() {
    return promises.open
  },
  get readFile() {
    return promises.readFile
  },
  get realpath() {
    return promises.realpath
  },
  get rename() {
    return promises.rename
  },
  get rm() {
    return promises.rm
  },
  get stat() {
    return promises.stat
  },
  get writeFile() {
    return promises.writeFile
  },
  get accessSync() {
    return sync.accessSync
  },
  get existsSync() {
    return sync.existsSync
  },
  get readdirSync() {
    return sync.readdirSync
  },
  get statSync() {
    return sync.statSync
  },
}

/** An injectable filesystem; without an override operations use the Node host filesystem. */
export class FileSystem extends Context.Service<FileSystem, typeof nodeFileSystem>()(
  "holyagent/host/FileSystem",
) {}

/** Selects the injected host filesystem or the Node default. */
export const fileSystem = Effect.serviceOption(FileSystem).pipe(
  Effect.map(Option.getOrElse(() => nodeFileSystem)),
)
