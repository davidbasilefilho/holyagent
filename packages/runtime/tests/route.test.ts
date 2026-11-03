import { describe, expect, test } from "bun:test"

import { isReviewer, isWriter, RoleTask, routeFor, ROUTES } from "../src/domain/route.ts"

describe("route table", () => {
  test("has the 18 role tasks, each routed under its own id and kebab agent name", () => {
    expect(ROUTES).toHaveLength(18)
    for (const route of ROUTES) {
      expect<string>(route.roleTask).toBe(`${route.role}.${route.task}`)
      expect(route.agent).toBe(`${route.role}-${route.task}`.toLowerCase())
    }
    expect(ROUTES.map((route) => route.roleTask)).toEqual([...RoleTask.literals])
  })

  test("pins model, effort, mutability and independence", () => {
    expect(routeFor("Worker.implementation")).toMatchObject({
      agent: "worker-implementation",
      model: "sonnet",
      effort: "high",
      mutability: "ScopedWrite",
      independence: "DisjointWrites",
    })
    expect(routeFor("Explorer.map")).toMatchObject({ model: "haiku", effort: "medium" })
    expect(routeFor("Reviewer.testing")).toMatchObject({
      model: "sonnet",
      effort: "medium",
      independence: "IndependentReview",
    })
    expect(routeFor("Worker.validation").mutability).toBe("ReadOnly")
  })

  test("the cheap worker routes and integration run at medium effort", () => {
    for (const roleTask of ["Worker.operations", "Worker.validation", "Worker.mechanical"] as const)
      expect(routeFor(roleTask)).toMatchObject({ model: "haiku", effort: "medium" })
    expect(routeFor("Worker.integration")).toMatchObject({ model: "sonnet", effort: "medium" })
    for (const roleTask of ["Worker.implementation", "Worker.debugging", "Worker.visual"] as const)
      expect(routeFor(roleTask)).toMatchObject({ model: "sonnet", effort: "high" })
  })

  test("only workers write, and every Reviewer reviews", () => {
    for (const route of ROUTES) {
      expect(isWriter(route.roleTask)).toBe(route.mutability === "ScopedWrite")
      expect(isReviewer(route.roleTask)).toBe(route.role === "Reviewer")
      if (route.role !== "Worker") expect(isWriter(route.roleTask)).toBe(false)
    }
  })
})
