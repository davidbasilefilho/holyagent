import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { adaptAgentInput, agentInputHelp } from "../src/cli/agent-input.ts"

const input = (path: string, ...args: string[]) =>
  Effect.runSync(adaptAgentInput(path.split(" "), args))
const invalid = (path: string, ...args: string[]) =>
  Effect.runSync(Effect.flip(adaptAgentInput(path.split(" "), args)))

describe("agent typed flags", () => {
  test("creates and updates an Intent without reading a JSON payload", () => {
    expect(
      input(
        "intent create",
        "--objective",
        "Ship",
        "--requirement",
        "first",
        "--requirement=second",
      ),
    ).toEqual({ argv: [], input: { objective: "Ship", requirements: ["first", "second"] } })
    expect(input("intent update", "--material", "--clear-requirements")).toEqual({
      argv: ["--material"],
      input: { requirements: [] },
    })
    expect(input("intent update", "--objective=Clarify")).toEqual({
      argv: [],
      input: { objective: "Clarify" },
    })
  })

  test("refuses omitted, repeated, unknown, empty and conflicting Intent flags", () => {
    expect(invalid("intent create").message).toContain("Missing --objective")
    expect(invalid("intent create", "--objective=a", "--objective=b").message).toContain("twice")
    expect(invalid("intent create", "--objective", "--requirement=b").message).toContain("value")
    expect(invalid("intent create", "--objective= ")._tag).toBe("Usage")
    expect(invalid("intent create", "--input", '{"objective":"x"}').message).toContain(
      "Unknown flag",
    )
    expect(invalid("intent create", '{"objective":"x"}').message).toContain("positional")
    expect(invalid("intent update")._tag).toBe("Usage")
    expect(invalid("intent update", "--clear-requirements", "--requirement=a").message).toContain(
      "either",
    )
  })

  test("maps every assignment draft flag to canonical typed fields", () => {
    const draft = input(
      "assignment create",
      "--role-task=Worker.implementation",
      "--objective=Implement the release gate",
      "--scope=the CLI",
      "--scope=its tests",
      "--constraint=Preserve state",
      "--criterion=blocking:behavior:Structured output: TOON only",
      "--criterion",
      "advisory:style:Use existing helpers\nPreserve readability",
      "--evidence=checks",
      "--ownership-path=src/cli.ts",
      "--operational-path=/tmp/holyagent scratch",
      "--dependency=assignment-base",
      "--independent-from=assignment-writer",
      "--follow-up-of=assignment-first",
      "--intent-id=intent-release",
      "--intent-revision=2",
      "--screen",
    )
    expect(draft).toEqual({
      argv: [],
      input: {
        roleTask: "Worker.implementation",
        objective: "Implement the release gate",
        scope: ["the CLI", "its tests"],
        constraints: ["Preserve state"],
        criteria: [
          { blocking: true, dimension: "behavior", text: "Structured output: TOON only" },
          {
            blocking: false,
            dimension: "style",
            text: "Use existing helpers\nPreserve readability",
          },
        ],
        evidence: ["checks"],
        ownershipPaths: ["src/cli.ts"],
        operationalResources: [{ kind: "local-path", target: "/tmp/holyagent scratch" }],
        dependencies: ["assignment-base"],
        independentFrom: ["assignment-writer"],
        followUpOf: "assignment-first",
        intentId: "intent-release",
        intentRevision: 2,
        screen: true,
      },
    })
  })

  test("dispatches a previously planned Assignment with only its validated id", () => {
    expect(input("assignment dispatch", "--id=assignment-ready")).toEqual({
      argv: [],
      input: { id: "assignment-ready" },
    })
    expect(invalid("assignment dispatch", "--id=assignment-ready", "--screen").message).toContain(
      "on its own",
    )
    expect(invalid("assignment dispatch", "--id=../../project")._tag).toBe("Usage")
    expect(invalid("assignment create", "--id=assignment-ready").message).toContain("Unknown flag")
    expect(
      input(
        "assignment dispatch",
        "--role-task=Reviewer.code",
        "--objective=Review",
        "--criterion=blocking:tests:Check the test",
      ).input,
    ).toMatchObject({ roleTask: "Reviewer.code", criteria: [{ dimension: "tests" }] })
  })

  test("validates draft fields with the same constraints as persisted records", () => {
    expect(
      invalid("assignment create", "--role-task=Reviewer.code", "--objective=Review").message,
    ).toContain("Missing --criterion")
    const draft = ["--role-task=Reviewer.code", "--objective=Review"]
    for (const criterion of [
      "true:behavior:Text",
      "blocking:unknown:Text",
      "advisory:tests: ",
      "unstructured",
    ])
      expect(invalid("assignment create", ...draft, `--criterion=${criterion}`)._tag).toBe("Usage")
    for (const revision of ["0", "-1", "0x10", "1.2", "1e5", "9007199254740992"])
      expect(
        invalid(
          "assignment create",
          ...draft,
          "--criterion=blocking:scope:Review it",
          `--intent-revision=${revision}`,
        ).message,
      ).toContain("positive safe integer")
  })

  test("uses only explicit report files for close and accept", () => {
    expect(
      input(
        "assignment close",
        "assignment-run",
        "--outcome=success",
        "--report-file",
        "logs/report me.md",
      ),
    ).toEqual({
      argv: ["assignment-run", "--outcome=success"],
      reportFile: "logs/report me.md",
    })
    expect(input("assignment close", "assignment-run", "--outcome=interrupted")).toEqual({
      argv: ["assignment-run", "--outcome=interrupted"],
    })
    expect(
      input(
        "assignment accept",
        "assignment-run",
        "--rationale=Evidence holds",
        "--report-file=report.md",
      ),
    ).toEqual({
      argv: ["assignment-run", "--rationale=Evidence holds", "--report"],
      reportFile: "report.md",
    })
    expect(invalid("assignment close", "assignment-run", "--outcome=success").message).toContain(
      "--report-file",
    )
    expect(invalid("assignment close", "assignment-run", "--outcome=failed")._tag).toBe("Usage")
    expect(
      invalid("assignment close", "assignment-run", "--outcome=stopped", "--report-json").message,
    ).toContain("--report-file")
    expect(
      invalid("assignment accept", "assignment-run", "--rationale=Proof", "--report-file=-")
        .message,
    ).toContain("local file")
    expect(
      invalid("assignment accept", "assignment-run", "--rationale=Proof", "--report").message,
    ).toContain("Unknown flag")
  })

  test("leaves existing flag-native commands and help discovery intact", () => {
    expect(input("intent close", "--reason=Done")).toEqual({ argv: ["--reason=Done"] })
    expect(agentInputHelp(["intent", "close"])).toBeUndefined()
    expect(agentInputHelp(["__proto__"])).toBeUndefined()
    expect(agentInputHelp(["assignment", "dispatch"])?.usage).toContain("--role-task")
    expect(agentInputHelp(["assignment", "close"])?.usage).toContain("--report-file")
  })
})
