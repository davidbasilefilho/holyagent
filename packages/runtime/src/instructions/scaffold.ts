import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Console, Effect } from "effect"

import { toPosix } from "../domain/paths.ts"
import {
  FAMILIES,
  folderOf,
  INSTRUCTIONS_ROOT,
  isMirrored,
  REQUIREMENTS_FOLDER,
} from "./families.ts"
import { InstructionsError, listTree } from "./requirements.ts"

const failAt = (path: string) => (cause: unknown) => new InstructionsError({ path, cause })

/**
 * Creates `path` empty unless a file is there. The exclusive flag makes the check and the creation
 * one step, so a file with content is never overwritten, not even by a concurrent run. What stands
 * in the way and is not a file, such as a folder or a file where a folder belongs, is an error.
 * Returns whether the file was created.
 */
const createEmpty = (path: string): Effect.Effect<boolean, InstructionsError> =>
  Effect.tryPromise({
    try: () => writeFile(path, "", { flag: "wx" }),
    catch: (cause) => cause,
  }).pipe(
    Effect.as(true),
    Effect.catch((cause) =>
      (cause as NodeJS.ErrnoException | undefined)?.code === "EEXIST"
        ? Effect.tryPromise({ try: () => Bun.file(path).exists(), catch: failAt(path) }).pipe(
            Effect.flatMap((isFile) =>
              isFile ? Effect.succeed(false) : Effect.fail(failAt(path)(cause)),
            ),
          )
        : Effect.fail(failAt(path)(cause)),
    ),
  )

/**
 * Copies the folder tree of `requirements/` under `root` into each folder of `families` as empty
 * files: every folder, and every mirrored Markdown file (see `isMirrored`) with the same path. It
 * adds the paths that are missing and touches nothing that exists, so running it again creates
 * nothing and a translated file keeps its content. Returns the files it created, as paths from
 * `root` in the order of the families and then of the requirements files.
 */
export const scaffold = (
  root: string = INSTRUCTIONS_ROOT,
  families: ReadonlyArray<string> = FAMILIES,
): Effect.Effect<ReadonlyArray<string>, InstructionsError> =>
  Effect.gen(function* () {
    const { directories, files } = yield* listTree(folderOf(REQUIREMENTS_FOLDER, root))
    const mirrored = files.filter(isMirrored)
    const created: Array<string> = []
    for (const family of families) {
      const target = folderOf(family, root)
      const folders = ["", ...directories]
      for (const folder of folders) {
        const path = join(target, folder)
        yield* Effect.tryPromise({
          try: () => mkdir(path, { recursive: true }),
          catch: failAt(path),
        })
      }
      for (const file of mirrored) {
        if (yield* createEmpty(join(target, file))) created.push(toPosix(join(family, file)))
      }
    }
    return created
  })

/**
 * Runs the scaffold on the instructions folder and prints each file it created, then a count. A
 * failure is printed and sets a failing exit code.
 */
export const main = Effect.gen(function* () {
  const created = yield* scaffold()
  for (const path of created) yield* Console.log(`created ${path}`)
  yield* Console.log(`${created.length} file${created.length === 1 ? "" : "s"} created`)
}).pipe(
  Effect.catch((error) =>
    Console.error(`error: ${error._tag}: ${error.message}`).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
    ),
  ),
)
