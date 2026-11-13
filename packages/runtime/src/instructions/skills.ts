import { join } from "node:path"

import { Effect } from "effect"

import { type Family, folderOf, INSTRUCTIONS_ROOT } from "./families.ts"
import { InstructionsError, listTree } from "./requirements.ts"

/** The instruction sources of every family, relative to the repository root. */
export const INSTRUCTIONS_PATH = "packages/runtime/src/instructions"

/** A family's instruction sources, relative to the repository root. */
export const instructionsDirectory = (family: Family): string => `${INSTRUCTIONS_PATH}/${family}`

/**
 * The one source of the materiality definition (which visual discrepancies are repaired and which
 * stay preference), relative to a family folder. A generator embeds its text wherever a source
 * holds {@link MATERIALITY_MARKER}, so the definition has a single source and each generated file
 * still carries it whole.
 */
export const MATERIALITY_PATH = "shared/materiality.md"

/** The line of an instruction source that a generator replaces with the materiality definition. */
export const MATERIALITY_MARKER = "<!-- materiality -->"

/**
 * The one source of the shared design core, relative to a family folder. A generator embeds its
 * text into each of the {@link DESIGN_SKILLS}, so every one of them is self-contained and the core
 * still has a single source. The core itself embeds the materiality definition first.
 */
export const DESIGN_CORE_PATH = "design-core/core.md"

/** The line of a design skill's source that a generator replaces with the shared design core. */
export const DESIGN_CORE_MARKER = "<!-- design-core -->"

/**
 * The instruction comments a generator keeps: the lines that mark where a generator embeds shared
 * text. Every other HTML comment is a maintainer's note.
 */
/** A placeholder in root skill sections replaced with the root router at assembly. */
export const GUIDANCE_MARKER = "<!-- owned-guidance -->"

const MARKERS: ReadonlySet<string> = new Set([
  MATERIALITY_MARKER,
  DESIGN_CORE_MARKER,
  GUIDANCE_MARKER,
])

// Code stays as written, so a `<!--` in a code span, a fenced block or an indented block never pairs
// with a later `-->`. The alternatives are an indented code block (lines of four or more spaces or a
// tab that start the text or follow a blank line, with the blank lines between them; a fence marker
// in it is just code), a backtick fence and a tilde fence (each at most three spaces deep, closed by a
// fence of its own character at least as long, or by the end of the text), an inline code span (a
// backtick run closed by a run of the same length within one paragraph, so not across a blank line or
// a line that starts a list item) and a comment; the first match wins. The groups are numbered 1 to 3
// for the backreferences and the comment is group 4; the others do not capture.
const LIST_ITEM_START = String.raw`\n[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|\r?(?:\n|$))`
const CODE_OR_COMMENT = new RegExp(
  [
    String.raw`(?:(?<![\s\S])|(?<=\n[ \t]*\r?\n))(?: {4}|\t)[ \t]*[^\s][^\n]*(?:\n(?:[ \t]*\r?\n)*(?: {4}|\t)[ \t]*[^\s][^\n]*)*`,
    String.raw`^ {0,3}(\x60{3,})[^\x60\n]*(?:\n[\s\S]*?)?(?:\n {0,3}\1\x60*[ \t]*\r?(?=\n|$)|(?![\s\S]))`,
    String.raw`^ {0,3}(~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n {0,3}\2~*[ \t]*\r?(?=\n|$)|(?![\s\S]))`,
    String.raw`(?<!\x60)(\x60+)(?!\x60)(?:(?!\n[ \t]*\r?\n)(?!${LIST_ITEM_START})[\s\S])*?(?<!\x60)\3(?!\x60)`,
    String.raw`([ \t]*<!--[\s\S]*?-->)`,
  ].join("|"),
  "gm",
)

// Stands for a comment that held its lines alone, until the lines are removed.
const REMOVED_LINE = "\u0000"

const isBlank = (line: string | undefined) => line !== undefined && /^[ \t]*\r?$/.test(line)

const isRemoved = (line: string | undefined) =>
  line !== undefined && line.startsWith(REMOVED_LINE) && isBlank(line.slice(REMOVED_LINE.length))

/**
 * The text with its maintainers' notes removed: every HTML comment in prose except the marker lines
 * of {@link MATERIALITY_MARKER} and {@link DESIGN_CORE_MARKER}. A source cites the guide point a
 * rule follows in such a comment, for the people who edit it; the comment says nothing to the model
 * that reads the generated text, so every family's generator strips it. Code is not prose, so a
 * comment inside an inline code span, a fenced code block or an indented code block stays. A
 * comment on a line of its own is removed with the line, and the blank line after the removed lines
 * goes too when the lines before them are blank or start the text, so the removal never leaves a
 * run of blank lines that was not there. A comment after text takes the spaces before it. Lines end
 * in LF or CRLF. Text without a comment is returned as it is.
 */
export const stripCitations = (text: string): string => {
  const marked = text.replace(
    CODE_OR_COMMENT,
    (match, _fence, _tilde, _span, comment: string | undefined, offset: number): string => {
      if (comment === undefined || MARKERS.has(match.trim())) return match
      const alone =
        (offset === 0 || text[offset - 1] === "\n") &&
        /^[ \t]*\r?(?:\n|$)/.test(text.slice(offset + match.length))
      return alone ? REMOVED_LINE : ""
    },
  )
  if (!marked.includes(REMOVED_LINE)) return marked
  const lines = marked.split("\n")
  const kept = lines.filter((line, index) => {
    if (isRemoved(line)) return false
    if (!isBlank(line) || !isRemoved(lines[index - 1])) return true
    // A blank line after removed lines: drop it when a blank line or the start is above them.
    let above = index - 1
    while (isRemoved(lines[above - 1])) above--
    return !(above === 0 || isBlank(lines[above - 1]))
  })
  // A removed last line had no line ending of its own, so the one before it stays.
  if (isRemoved(lines[lines.length - 1])) kept.push("")
  return kept.join("\n")
}

/** The platform design skills, which carry the shared design core. */
export const DESIGN_SKILLS: ReadonlyArray<string> = [
  "web-design",
  "mobile-design",
  "desktop-design",
  "tui-design",
]

/** The folder of a family that holds its skills, relative to the family folder. */
export const SKILLS_PATH = "skills"

const sourceProblem = (source: string, problem: string) =>
  Effect.fail(new InstructionsError({ path: source, cause: problem }))

/**
 * A source with its {@link MATERIALITY_MARKER} line replaced by the definition. The marker line is
 * matched after trimming. A source without the marker is returned as it is; one with the marker
 * twice fails, because the definition would ship twice in one file.
 */
export const embedMateriality = (
  text: string,
  materiality: string,
  source: string,
): Effect.Effect<string, InstructionsError> => {
  const lines = text.split("\n")
  const isMarker = (line: string) => line.trim() === MATERIALITY_MARKER
  const at = lines.findIndex(isMarker)
  if (at === -1) return Effect.succeed(text)
  if (lines.findIndex((line, index) => index > at && isMarker(line)) !== -1)
    return sourceProblem(source, `must hold the line ${MATERIALITY_MARKER} at most once`)
  return Effect.succeed(
    [...lines.slice(0, at), materiality.trim(), ...lines.slice(at + 1)].join("\n"),
  )
}

/**
 * A design skill's source with the marker line replaced by the shared design core. A source without
 * exactly one marker line fails, because the skill would ship without its core.
 */
const withDesignCore = (text: string, core: string, source: string) => {
  const lines = text.split("\n")
  const at = lines.indexOf(DESIGN_CORE_MARKER)
  if (at === -1 || lines.indexOf(DESIGN_CORE_MARKER, at + 1) !== -1)
    return sourceProblem(source, `must hold the line ${DESIGN_CORE_MARKER} exactly once`)
  return Effect.succeed([...lines.slice(0, at), core.trim(), ...lines.slice(at + 1)].join("\n"))
}

/**
 * A skill's generated body, from its path below the skills folder. A design skill gets the shared
 * core; any other skill holding the marker line fails, because the marker would ship as literal
 * text with no core.
 */
export const skillBody = (
  path: string,
  text: string,
  core: string,
  source: string,
): Effect.Effect<string, InstructionsError> => {
  if (DESIGN_SKILLS.includes(path.split("/")[0] ?? "")) return withDesignCore(text, core, source)
  if (text.split("\n").includes(DESIGN_CORE_MARKER))
    return sourceProblem(source, `holds ${DESIGN_CORE_MARKER} but is not listed in DESIGN_SKILLS`)
  return Effect.succeed(text)
}

/**
 * Puts a note into Markdown that starts with frontmatter as a YAML comment on the line after the
 * opening `---`, so the body, which is the prompt, stays as it was.
 */
export const noteInFrontmatter = (text: string, note: string): string => {
  const [opening = "", ...rest] = text.split("\n")
  return [opening, `# ${note}`, ...rest].join("\n")
}

/** One file of a family's skills: its path below the skills folder and its generated content. */
export interface SkillFile {
  readonly path: string
  readonly content: string
}

/**
 * The files below a family's `skills/` folder, in path order, ready to write below a harness's
 * private guidance folder. Each `SKILL.md` gets the materiality definition and, for a design skill,
 * the shared design core, then `note(source)` as a frontmatter comment, where `source` is the
 * file's path from the repository root, and the maintainers' notes of {@link stripCitations}
 * removed. Every other file is carried as it is, except dotfiles and symbolic links, which stay out
 * as they did when the skills were globbed. `root` is the folder of the family folders. Failing to
 * read a source, or a marker used wrongly, is an `InstructionsError`.
 */
export const skillFiles = (
  family: Family,
  note: (source: string) => string,
  root: string = INSTRUCTIONS_ROOT,
): Effect.Effect<ReadonlyArray<SkillFile>, InstructionsError> =>
  Effect.gen(function* () {
    const folder = folderOf(family, root)
    const directory = instructionsDirectory(family)
    const read = (path: string) =>
      Effect.tryPromise({
        try: () => Bun.file(join(folder, path)).text(),
        catch: (cause) => new InstructionsError({ path: `${directory}/${path}`, cause }),
      })
    const materiality = yield* read(MATERIALITY_PATH)
    const core = yield* embedMateriality(
      yield* read(DESIGN_CORE_PATH),
      materiality,
      `${directory}/${DESIGN_CORE_PATH}`,
    )
    const { files } = yield* listTree(join(folder, SKILLS_PATH), { plain: true })
    return yield* Effect.forEach(files, (path) =>
      Effect.gen(function* () {
        const source = `${directory}/${SKILLS_PATH}/${path}`
        const text = yield* read(`${SKILLS_PATH}/${path}`)
        if (!path.endsWith("SKILL.md")) return { path, content: text }
        const body = yield* skillBody(
          path,
          yield* embedMateriality(text, materiality, source),
          core,
          source,
        )
        return { path, content: noteInFrontmatter(stripCitations(body), note(source)) }
      }),
    )
  })

/** Situations and roles for each owned guidance body. Root is the main thread. */
export const OWNED_GUIDANCE: ReadonlyArray<{
  readonly name: string
  readonly when: string
  readonly roles: ReadonlyArray<string>
}> = [
  { name: "ci-watch", when: "a pushed PR or commit needs CI judged", roles: ["root"] },
  {
    name: "dev-server",
    when: "a web app or served static build, a terminal UI, a desktop or mobile app needs a shared render target",
    roles: ["root", "Worker.operations"],
  },
  {
    name: "documentation-lookup",
    when: "library documentation is needed",
    roles: [
      "Librarian.lookup",
      "Librarian.research",
      "Worker.implementation",
      "Worker.integration",
      "Worker.debugging",
    ],
  },
  {
    name: "evidence-judging",
    when: "a specialist verdict needs acceptance or rejection",
    roles: ["root"],
  },
  {
    name: "instruction-writing",
    when: "writing or reviewing model-facing instructions",
    roles: ["root", "Worker.implementation", "Reviewer.artifact"],
  },
  { name: "state-mode", when: "a clone has no Intent yet", roles: ["root"] },
  { name: "user-busy", when: "the user is away or says not to ask", roles: ["root"] },
  {
    name: "visual-judging",
    when: "before any visual-task writer, source edit or visual specialist dispatch, and when judging visual work",
    roles: ["root"],
  },
  {
    name: "web-design",
    when: "the selected platform is web",
    roles: ["root", "Worker.visual", "Reviewer.visual"],
  },
  {
    name: "mobile-design",
    when: "the selected platform is mobile",
    roles: ["root", "Worker.visual", "Reviewer.visual"],
  },
  {
    name: "desktop-design",
    when: "the selected platform is desktop",
    roles: ["root", "Worker.visual", "Reviewer.visual"],
  },
  {
    name: "tui-design",
    when: "the selected platform is terminal UI",
    roles: ["root", "Worker.visual", "Reviewer.visual"],
  },
]

/** The non-discovered package folder carrying generated owned bodies. */
export const GUIDANCE_FOLDER = "guidance"

/** Render only the paths and triggers relevant to one role, leaving bodies to the reader. */
export const guidanceRouter = (role: string, family: Family, root: string): string => {
  const entries = OWNED_GUIDANCE.filter((entry) => entry.roles.includes(role))
  if (entries.length === 0) return ""
  const lines = entries.map(
    ({ name, when }) => `- ${when}: \`${root}/${GUIDANCE_FOLDER}/${family}/${name}/SKILL.md\``,
  )
  return [
    "User and third-party skills remain available.",
    ...(role === "root" ? [] : ["Read the relevant guidance when its situation applies."]),
    ...lines,
    ...(role === "root"
      ? ["Delegate library documentation lookup to a librarian or implementation specialist."]
      : []),
  ].join("\n")
}

/** Fail generation when an owned skill is missing from the map or its source is absent. */
export const validateOwnedGuidance = (files: ReadonlyArray<SkillFile>): void => {
  const known = new Set(OWNED_GUIDANCE.map(({ name }) => name))
  const actual = new Set(
    files.filter(({ path }) => path.endsWith("/SKILL.md")).map(({ path }) => path.split("/")[0]),
  )
  for (const name of actual)
    if (name !== undefined && !known.has(name))
      throw new Error(`owned skill ${name} has no routing map entry`)
  for (const name of known)
    if (!actual.has(name)) throw new Error(`mapped owned skill ${name} is missing`)
}
