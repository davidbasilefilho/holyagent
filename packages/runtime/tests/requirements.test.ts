import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { Effect } from "effect"

import { REQUIREMENT_COVERAGE } from "../src/instructions/coverage.ts"
import {
  FAMILIES,
  folderOf,
  GUIDE_FILE,
  INSTRUCTIONS_ROOT,
  isMirrored,
  REQUIREMENTS_FOLDER,
} from "../src/instructions/families.ts"
import { listTree, parseRequirements, REQUIREMENT_ID } from "../src/instructions/requirements.ts"

const REPOSITORY = join(import.meta.dir, "../../..")

const mirroredFiles = (name: string) =>
  Effect.runPromise(listTree(folderOf(name))).then(({ files }) => files.filter(isMirrored))
const text = (path: string) => Bun.file(path).text()

/** Every requirements file with the ids it defines and the ones it refers to. */
const requirementFiles = async () =>
  Promise.all(
    (await mirroredFiles(REQUIREMENTS_FOLDER)).map(async (file) => ({
      file,
      ...parseRequirements(await text(join(folderOf(REQUIREMENTS_FOLDER), file))),
    })),
  )

describe("requirements parser", () => {
  test("reads definitions and references and ignores every other line", () => {
    expect(
      parseRequirements(
        [
          "Prose before.",
          "- R-ONE: first",
          "- R-TWO-PART: second",
          "- R-EMPTY:",
          "- not a requirement: text",
          "- See: R-ONE, R-OTHER",
          "  - R-NESTED: indented",
        ].join("\n"),
      ),
    ).toEqual({ ids: ["R-ONE", "R-TWO-PART"], references: ["R-ONE", "R-OTHER"] })
  })

  test("mirrors Markdown files only, and not the guide", () => {
    expect(isMirrored("root/identity.md")).toBe(true)
    expect(isMirrored("skills/x/SKILL.md")).toBe(true)
    expect(isMirrored("root-core.ts")).toBe(false)
    expect(isMirrored(GUIDE_FILE)).toBe(false)
  })
})

describe("requirements tree", () => {
  test("defines each requirement id once, in the shape of an id", async () => {
    const files = await requirementFiles()
    const ids = files.flatMap((entry) => entry.ids)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids)
      expect({ id, valid: REQUIREMENT_ID.test(id) }).toEqual({ id, valid: true })
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
  })

  test("refers only to ids that another file defines", async () => {
    const files = await requirementFiles()
    for (const { file, references } of files)
      for (const id of references) {
        const owners = files.filter((entry) => entry.ids.includes(id))
        expect({ file, id, defined: owners.length === 1 && owners[0]?.file !== file }).toEqual({
          file,
          id,
          defined: true,
        })
      }
  })

  test("holds a guide in every family folder, listed or not, and nothing else in an unlisted one", async () => {
    const { directories } = await Effect.runPromise(listTree(INSTRUCTIONS_ROOT))
    const families = directories.filter(
      (path) => !path.includes("/") && path !== REQUIREMENTS_FOLDER,
    )
    expect(families.length).toBeGreaterThanOrEqual(FAMILIES.length)
    for (const family of families) {
      const { files } = await Effect.runPromise(listTree(folderOf(family)))
      expect({ family, guide: files.includes(GUIDE_FILE) }).toEqual({ family, guide: true })
      if (!(FAMILIES as ReadonlyArray<string>).includes(family))
        expect({ family, files }).toEqual({ family, files: [GUIDE_FILE] })
    }
    for (const family of FAMILIES) expect(families).toContain(family)
  })
})

describe.each(FAMILIES)("family %s", (family) => {
  test("has a requirements file for each of its Markdown files and no other file", async () => {
    const own = await mirroredFiles(family)
    const required = await mirroredFiles(REQUIREMENTS_FOLDER)
    expect({
      withoutRequirements: own.filter((file) => !required.includes(file)),
      withoutFile: required.filter((file) => !own.includes(file)),
    }).toEqual({ withoutRequirements: [], withoutFile: [] })
  })

  test("covers every requirement id and no id that no requirement defines", async () => {
    const ids = (await requirementFiles()).flatMap((entry) => entry.ids)
    const covered = Object.keys(REQUIREMENT_COVERAGE[family])
    expect({
      uncovered: ids.filter((id) => !covered.includes(id)).toSorted(),
      unknown: covered.filter((id) => !ids.includes(id)).toSorted(),
    }).toEqual({ uncovered: [], unknown: [] })
  })

  test("holds the phrase of each covering entry in the file the entry names", async () => {
    for (const [id, entry] of Object.entries(REQUIREMENT_COVERAGE[family])) {
      const path =
        "section" in entry
          ? join(folderOf(family), entry.section)
          : join(REPOSITORY, entry.carriedBy)
      if ("section" in entry)
        expect({ id, mirrored: isMirrored(entry.section) }).toEqual({ id, mirrored: true })
      const file = Bun.file(path)
      expect({ id, path, exists: await file.exists() }).toEqual({ id, path, exists: true })
      expect({ id, path, holds: (await file.text()).includes(entry.phrase) }).toEqual({
        id,
        path,
        holds: true,
      })
    }
  })
})
