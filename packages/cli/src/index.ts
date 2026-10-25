#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { ConfigProvider, Console, Effect, Layer } from "effect"
import { Command } from "effect/cli"

import packageJson from "../package.json" with { type: "json" }
import { doctorCommand } from "./cmd/doctor.ts"
import { setupCommand } from "./cmd/setup.ts"
import { Shell } from "./shell.ts"

const holyagent = Command.make("holyagent").pipe(
  Command.withDescription("Install and configure HolyAgent for your user and your projects."),
  Command.withSubcommands([setupCommand, doctorCommand]),
)

const program = holyagent.pipe(
  Command.run({ version: packageJson.version }),
  Effect.tapError((error) =>
    "_tag" in error && error._tag === "CliFailure" && error.message !== ""
      ? Console.error(`error: ${error.message}`)
      : Effect.void,
  ),
  Effect.provide(
    Layer.mergeAll(Shell.layer, BunServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv())),
  ),
)

BunRuntime.runMain(program, { disableErrorReporting: true })
