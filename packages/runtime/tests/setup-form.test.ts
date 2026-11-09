import { describe, expect, test } from "bun:test"

import { chooseForm, describeForm, detectForm, hasDisplay } from "../src/setup/form.ts"

describe("the display of a machine", () => {
  test.each([
    ["linux", {}, false],
    ["linux", { DISPLAY: "" }, false],
    ["linux", { DISPLAY: ":0" }, true],
    ["linux", { WAYLAND_DISPLAY: "wayland-0" }, true],
    ["freebsd", {}, false],
    // macOS and Windows have a graphical session without these variables.
    ["darwin", {}, true],
    ["win32", {}, true],
  ])("%s with %j has a display: %p", (platform, env, display) => {
    expect(hasDisplay(env, platform)).toBe(display)
  })
})

describe("form detection", () => {
  test("a graphical machine is the normal form, and one without a display is headless", () => {
    expect(detectForm({ DISPLAY: ":0" }, "linux")).toEqual({
      form: "normal",
      source: "detected",
      reason: "a graphical session is available",
    })
    expect(detectForm({}, "darwin").form).toBe("normal")
    expect(detectForm({}, "win32").form).toBe("normal")
    expect(detectForm({}, "linux")).toEqual({
      form: "headless",
      source: "detected",
      reason: "no DISPLAY or WAYLAND_DISPLAY is set",
    })
  })

  test("a cloud session and CI are headless whatever the display says", () => {
    expect(detectForm({ CLAUDE_CODE_REMOTE: "true", DISPLAY: ":0" }, "linux")).toMatchObject({
      form: "headless",
      reason: "a claude.ai cloud session",
    })
    expect(detectForm({ CI: "true" }, "darwin")).toMatchObject({
      form: "headless",
      reason: "CI is set",
    })
    expect(detectForm({ CI: "1", DISPLAY: ":0" }, "linux").form).toBe("headless")
  })

  test("CI set to false or empty does not make a machine headless", () => {
    expect(detectForm({ CI: "false" }, "darwin").form).toBe("normal")
    expect(detectForm({ CI: "" }, "win32").form).toBe("normal")
  })

  test("the flag overrides the detection in both directions", () => {
    expect(chooseForm({ DISPLAY: ":0" }, "headless", "linux")).toEqual({
      form: "headless",
      source: "flag",
      reason: "--form headless",
    })
    expect(chooseForm({}, "normal", "linux")).toMatchObject({ form: "normal", source: "flag" })
    expect(chooseForm({}, undefined, "linux")).toEqual(detectForm({}, "linux"))
  })

  test("a form is described with how it was chosen", () => {
    expect(describeForm(detectForm({ CI: "true" }, "linux"))).toBe("headless (detected: CI is set)")
    expect(describeForm(chooseForm({}, "normal", "linux"))).toBe("normal (set by --form normal)")
  })
})
