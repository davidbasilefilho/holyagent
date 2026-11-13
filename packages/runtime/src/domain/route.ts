import { Schema } from "effect"

/** The kind of specialist: what it is for. */
export const Role = Schema.Literals(["Explorer", "Librarian", "Worker", "Reviewer"])
/** One role. */
export type Role = typeof Role.Type

/** The task kind within a role. */
export const Task = Schema.Literals([
  "map",
  "lookup",
  "trace",
  "research",
  "mechanical",
  "implementation",
  "integration",
  "operations",
  "validation",
  "debugging",
  "visual",
  "code",
  "testing",
  "audit",
  "security",
  "artifact",
])
/** One task kind. */
export type Task = typeof Task.Type

/** The 18 specialists, each a `Role.task` id. */
export const RoleTask = Schema.Literals([
  "Explorer.map",
  "Explorer.lookup",
  "Explorer.trace",
  "Librarian.lookup",
  "Librarian.research",
  "Worker.mechanical",
  "Worker.implementation",
  "Worker.integration",
  "Worker.operations",
  "Worker.validation",
  "Worker.debugging",
  "Worker.visual",
  "Reviewer.visual",
  "Reviewer.code",
  "Reviewer.testing",
  "Reviewer.audit",
  "Reviewer.security",
  "Reviewer.artifact",
])
/** One `Role.task` id. */
export type RoleTask = typeof RoleTask.Type

/** Model alias a specialist is pinned to. */
export const Model = Schema.Literals(["haiku", "sonnet"])
/** One model alias. */
export type Model = typeof Model.Type

/** Reasoning effort a specialist is pinned to. */
export const Effort = Schema.Literals(["medium", "high", "xhigh"])
/** One effort level. */
export type Effort = typeof Effort.Type

/** A planned profile launch; this records intent, not the model observed by the host. */
export const IntendedLaunch = Schema.Struct({
  host: Schema.Literals(["pi", "claude"]),
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  profile: Schema.Literals(["normal", "fast"]),
  evidenceRevision: Schema.optionalKey(Schema.String),
})
/** The requested identity of a profile-selected launch. */
export type IntendedLaunch = typeof IntendedLaunch.Type

/** What an Assignment of a route may change: nothing, or only its ownership paths. */
export const Mutability = Schema.Literals(["ReadOnly", "ScopedWrite"])
/** One mutability. */
export type Mutability = typeof Mutability.Type

/** The invariant the root follows when it dispatches a route. */
export const Independence = Schema.Literals([
  "DisjointWrites",
  "DependenciesTerminal",
  "IndependentReview",
])
/** One independence invariant. */
export type Independence = typeof Independence.Type

/** What a specialist needs beyond reading. */
export const Capability = Schema.Literals(["Search", "Shell", "VisualInspection", "Write"])
/** One capability. */
export type Capability = typeof Capability.Type

/** Everything the runtime enforces about one specialist. */
export interface Route {
  readonly roleTask: RoleTask
  readonly role: Role
  readonly task: Task
  /** The agent name: the role and task in kebab case, as in `worker-implementation`. */
  readonly agent: string
  readonly model: Model
  readonly effort: Effort
  readonly mutability: Mutability
  readonly independence: Independence
  readonly capabilities: ReadonlyArray<Capability>
}

type Spec = Omit<Route, "roleTask" | "agent">

const spec = (
  role: Role,
  task: Task,
  model: Model,
  effort: Effort,
  mutability: Mutability,
  independence: Independence,
  capabilities: ReadonlyArray<Capability> = [],
): Spec => ({ role, task, model, effort, mutability, independence, capabilities })

const SPECS: Readonly<Record<RoleTask, Spec>> = {
  "Explorer.map": spec("Explorer", "map", "haiku", "medium", "ReadOnly", "DisjointWrites"),
  "Explorer.lookup": spec("Explorer", "lookup", "haiku", "medium", "ReadOnly", "DisjointWrites"),
  "Explorer.trace": spec(
    "Explorer",
    "trace",
    "sonnet",
    "medium",
    "ReadOnly",
    "DependenciesTerminal",
  ),
  "Librarian.lookup": spec("Librarian", "lookup", "haiku", "medium", "ReadOnly", "DisjointWrites", [
    "Search",
  ]),
  "Librarian.research": spec(
    "Librarian",
    "research",
    "sonnet",
    "medium",
    "ReadOnly",
    "DependenciesTerminal",
    ["Search"],
  ),
  "Worker.mechanical": spec(
    "Worker",
    "mechanical",
    "haiku",
    "medium",
    "ScopedWrite",
    "DisjointWrites",
    ["Write"],
  ),
  "Worker.implementation": spec(
    "Worker",
    "implementation",
    "sonnet",
    "high",
    "ScopedWrite",
    "DisjointWrites",
    ["Write"],
  ),
  "Worker.integration": spec(
    "Worker",
    "integration",
    "sonnet",
    "medium",
    "ScopedWrite",
    "DependenciesTerminal",
    ["Write"],
  ),
  "Worker.operations": spec(
    "Worker",
    "operations",
    "haiku",
    "medium",
    "ScopedWrite",
    "DisjointWrites",
    ["Shell"],
  ),
  "Worker.validation": spec(
    "Worker",
    "validation",
    "haiku",
    "medium",
    "ReadOnly",
    "DependenciesTerminal",
    ["Shell"],
  ),
  "Worker.debugging": spec(
    "Worker",
    "debugging",
    "sonnet",
    "high",
    "ScopedWrite",
    "DependenciesTerminal",
    ["Write"],
  ),
  "Worker.visual": spec("Worker", "visual", "sonnet", "high", "ScopedWrite", "DisjointWrites", [
    "Write",
    "VisualInspection",
  ]),
  "Reviewer.visual": spec("Reviewer", "visual", "sonnet", "high", "ReadOnly", "IndependentReview", [
    "VisualInspection",
  ]),
  "Reviewer.code": spec("Reviewer", "code", "sonnet", "high", "ReadOnly", "IndependentReview"),
  "Reviewer.testing": spec(
    "Reviewer",
    "testing",
    "sonnet",
    "medium",
    "ReadOnly",
    "IndependentReview",
    ["Shell"],
  ),
  "Reviewer.audit": spec("Reviewer", "audit", "haiku", "high", "ReadOnly", "IndependentReview"),
  "Reviewer.security": spec(
    "Reviewer",
    "security",
    "sonnet",
    "high",
    "ReadOnly",
    "IndependentReview",
  ),
  "Reviewer.artifact": spec(
    "Reviewer",
    "artifact",
    "sonnet",
    "high",
    "ReadOnly",
    "IndependentReview",
  ),
}

/** The route of a specialist. */
export const routeFor = (roleTask: RoleTask): Route => ({
  roleTask,
  agent: `${SPECS[roleTask].role}-${SPECS[roleTask].task}`.toLowerCase(),
  ...SPECS[roleTask],
})

/**
 * The end of the agent name of a specialist launched for an Assignment that carries the screen
 * capability on a machine with a graphical session: `worker-implementation-screen`. The Pi package
 * ships one such agent file for each specialist, with the screen tools added to its own, since a
 * launcher can grant tools only through the agent file.
 */
export const SCREEN_AGENT_SUFFIX = "-screen"

/**
 * The end of the agent name of a screen specialist on a headless machine (a cloud session, CI, no
 * display): `worker-implementation-headless-screen`. Its file lists the headless browser's tools
 * and no computer-use or browse tools, since the machine has no desktop to drive. It also ends in
 * {@link SCREEN_AGENT_SUFFIX}.
 */
export const HEADLESS_SCREEN_AGENT_SUFFIX = `-headless${SCREEN_AGENT_SUFFIX}`

/**
 * The form of the machine a screen specialist runs on, which picks the agent file it is launched
 * as.
 */
export type ScreenForm = "headless" | "normal"

/**
 * The agent name a specialist is launched as: the route's own, or with {@link SCREEN_AGENT_SUFFIX}
 * (`form` `normal`, the default) or {@link HEADLESS_SCREEN_AGENT_SUFFIX} (`headless`) for an
 * Assignment that carries the screen capability.
 */
export const agentFor = (
  route: Route,
  screen: boolean | undefined,
  form: ScreenForm = "normal",
): string =>
  screen === true
    ? `${route.agent}${form === "headless" ? HEADLESS_SCREEN_AGENT_SUFFIX : SCREEN_AGENT_SUFFIX}`
    : route.agent

/**
 * Every agent name an Assignment may be launched as: the route's own, or, with the screen
 * capability, its name in each form.
 */
export const agentsFor = (route: Route, screen: boolean | undefined): ReadonlyArray<string> =>
  screen === true
    ? [agentFor(route, true, "normal"), agentFor(route, true, "headless")]
    : [route.agent]

/** Whether an agent name is a headless screen specialist's ({@link HEADLESS_SCREEN_AGENT_SUFFIX}). */
export const isHeadlessScreenAgent = (agent: string | undefined): boolean =>
  agent?.endsWith(HEADLESS_SCREEN_AGENT_SUFFIX) === true

/** The 18 routes, in the order of {@link RoleTask}. */
export const ROUTES: ReadonlyArray<Route> = RoleTask.literals.map(routeFor)

/** True when Assignments of the route may change files, so they own paths. */
export const isWriter = (roleTask: RoleTask): boolean =>
  SPECS[roleTask].mutability === "ScopedWrite"

/** True when the route reviews work, so it must be independent from that work. */
export const isReviewer = (roleTask: RoleTask): boolean => SPECS[roleTask].role === "Reviewer"
