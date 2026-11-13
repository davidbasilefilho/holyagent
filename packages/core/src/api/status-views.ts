import type { Assignment } from "../domain/assignment.ts"
import type { HostWords } from "../domain/host.ts"
import type { Snapshot } from "../state/store.ts"

const present = (record: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0),
    ),
  )
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
const byId = <T extends { readonly id: string }>(rows: ReadonlyArray<T>) =>
  rows.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const assignmentRow = (row: Assignment) => ({
  id: row.id,
  role: row.roleTask,
  rev: row.intentRevision,
  agent: row.specialist?.agentId ?? null,
  objective: oneLine(row.objective),
})

/** Renders a core state snapshot as the CLI status view. */
export const statusFrom = (snapshot: Snapshot) => {
  const open = byId(snapshot.project.intents.filter((intent) => intent.state === "Open"))
  const openIds = new Set(open.map((intent) => intent.id))
  const live = byId(snapshot.project.assignments.filter((row) => openIds.has(row.intentId)))
  const waiting = (id: string) => live.filter((row) => row.intentId === id)
  const isRunning = (row: (typeof live)[number]) => row.state === "Running"
  const isUnaccepted = (row: (typeof live)[number]) =>
    row.state === "Succeeded" && row.acceptance === undefined
  const active =
    open.find((row) => row.id === snapshot.activeIntent) ??
    (open.length === 1 ? open[0] : undefined)
  const inUse = active?.id
  // The Assignments are listed for the Intent in use only; each other open Intent gets counts, so
  // the root sees that work waits there without reading it.
  const mine = live.filter((row) => row.intentId === inUse)
  return {
    intents: open.map(({ id, revision, objective }) => ({
      id,
      revision,
      objective: oneLine(objective),
      ...(id === inUse
        ? {}
        : {
            running: waiting(id).filter(isRunning).length,
            unaccepted: waiting(id).filter(isUnaccepted).length,
          }),
    })),
    ...present({
      inUse,
      running: mine
        .filter(isRunning)
        .map(assignmentRow)
        .map(({ id, role, agent, objective }) => ({ id, role, agent, objective })),
      unaccepted: mine
        .filter(isUnaccepted)
        .map(assignmentRow)
        .map(({ id, role, rev, objective }) => ({ id, role, rev, objective })),
    }),
  }
}

/** Renders Running assignments for reconciliation. */
export const reconcileRows = (rows: Snapshot["project"]["assignments"], words: HostWords) => {
  const running = byId(rows.filter((row) => row.state === "Running"))
  return {
    running: running.map((row) => ({
      id: row.id,
      role: row.roleTask,
      agent: row.specialist?.agentId ?? null,
      startedAt: row.specialist?.startedAt ?? null,
    })),
    ...present({
      next:
        running.length === 0
          ? undefined
          : `close as interrupted only an agent confirmed gone (${words.confirmGone}; an exited parent session proves nothing): holyagent assignment close <id> --outcome interrupted`,
    }),
  }
}
