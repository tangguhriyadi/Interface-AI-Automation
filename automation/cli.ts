#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PlaywrightAdapter } from "./adapter/playwrightAdapter.js";
import { consoleEscalationHandler } from "./consoleEscalationHandler.js";
import { discover, type DiscoveryGoal, type DiscoveryInputSpec } from "./discovery/discover.js";
import { AnthropicModel } from "./discovery/model.js";
import { writeDiscoveryEvidence, writeReplayEvidence } from "./evidence.js";
import { replay } from "./executor/replay.js";
import {
  loadAppProfile,
  loadCapabilityWithAppProfile,
  loadDiscoveryGoalFile,
  loadTenantOverlay,
} from "./schema/loader.js";
import type { Sensitivity } from "./schema/capability.js";

/**
 * The one CLI CLAUDE.md calls for: `discover` and `replay`, nothing else.
 * No argument-parsing framework — the surface is small enough that hand-
 * rolled `--flag value` parsing is simpler than a dependency (CLAUDE.md:
 * "Do not add frameworks... Simpler is better if justified").
 *
 * `username`/`password` inputs are resolved from `TARGET_APP_USERNAME`/
 * `TARGET_APP_PASSWORD` automatically when a capability/goal declares an
 * input by exactly that name and no `--input` overrides it — the same env
 * vars `test:integration` already uses, so a demo command never needs a
 * credential typed on the command line or committed anywhere (CLAUDE.md:
 * "Test credentials ... come from environment variables. No secrets in the
 * repo."). Every other input must be given explicitly via `--input name=value`.
 */

interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
  inputs: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | true>();
  const inputs = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      throw new CliUsageError(`Unexpected argument "${arg}" — every flag must start with "--".`);
    }
    const name = arg.slice(2);
    if (name === "input") {
      const pair = rest[++i];
      if (!pair || !pair.includes("=")) {
        throw new CliUsageError(`--input requires a "name=value" pair, got ${JSON.stringify(pair)}.`);
      }
      const eq = pair.indexOf("=");
      inputs.set(pair.slice(0, eq), pair.slice(eq + 1));
      continue;
    }
    // Boolean flags (no value follows, or the next token is itself another flag).
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      i++;
    }
  }
  return { command: command ?? "", flags, inputs };
}

class CliUsageError extends Error {}

function requireFlag(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) {
    throw new CliUsageError(`Missing required flag --${name}.`);
  }
  if (value === true) {
    throw new CliUsageError(`--${name} requires a value.`);
  }
  return value;
}

/**
 * Resolves one declared input's literal runtime value: an explicit
 * `--input name=value` always wins; `username`/`password` fall back to
 * `TARGET_APP_USERNAME`/`TARGET_APP_PASSWORD` when unset; anything else
 * missing is a hard error naming exactly what's needed.
 */
function resolveInputValue(name: string, provided: Map<string, string>): string {
  const explicit = provided.get(name);
  if (explicit !== undefined) {
    return explicit;
  }
  if (name === "username" && process.env.TARGET_APP_USERNAME) {
    return process.env.TARGET_APP_USERNAME;
  }
  if (name === "password" && process.env.TARGET_APP_PASSWORD) {
    return process.env.TARGET_APP_PASSWORD;
  }
  throw new CliUsageError(
    `Missing value for declared input "${name}" — pass --input ${name}=<value>` +
      (name === "username" || name === "password" ? ` or set TARGET_APP_${name.toUpperCase()}.` : "."),
  );
}

/** Headed by default — the escalation handoff's whole premise is a human acting in the same visible window automation was driving. `--headless` overrides it (useful in an environment with no display). */
function resolveHeadless(flags: Map<string, string | true>): boolean {
  return flags.has("headless");
}

async function runDiscover(flags: Map<string, string | true>, providedInputs: Map<string, string>): Promise<void> {
  const goalPath = requireFlag(flags, "goal");
  const appProfilePath = requireFlag(flags, "app-profile");
  const baseUrl = typeof flags.get("base-url") === "string" ? (flags.get("base-url") as string) : (process.env.TARGET_APP_BASE_URL ?? "http://localhost:4000");

  const goalFile = loadDiscoveryGoalFile(goalPath);
  const appProfile = loadAppProfile(appProfilePath);

  const inputs: Record<string, DiscoveryInputSpec> = {};
  for (const [name, spec] of Object.entries(goalFile.inputs)) {
    inputs[name] = { value: resolveInputValue(name, providedInputs), sensitivity: spec.sensitivity };
  }
  const outputs: Record<string, { sensitivity: Sensitivity }> = {};
  for (const [name, spec] of Object.entries(goalFile.outputs)) {
    outputs[name] = { sensitivity: spec.sensitivity };
  }

  const goal: DiscoveryGoal = {
    capabilityId: goalFile.capabilityId,
    version: goalFile.version,
    appId: goalFile.appId,
    description: goalFile.description,
    entryPoint: goalFile.entryPoint,
    inputs,
    outputs,
  };

  const adapter = await PlaywrightAdapter.launch(baseUrl, { headless: resolveHeadless(flags) });
  try {
    const model = new AnthropicModel();
    const result = await discover(goal, appProfile, adapter, model);

    const written = await writeDiscoveryEvidence(
      { description: goal.description, entryPoint: goal.entryPoint, inputs: goal.inputs },
      result,
      adapter,
    );
    console.log(`Evidence written to ${written.dir}`);

    if (result.status === "done") {
      // Defaults inside this run's own evidence directory, not into /capabilities — a
      // demo run of `discover` should never leave an untracked file in the working tree
      // for a reviewer to notice and wonder about. Pass --out explicitly to promote a
      // discovered artifact into /capabilities once a human has actually reviewed it
      // (approvalState stays "draft" either way — see automation/README.md).
      const outPath = typeof flags.get("out") === "string" ? (flags.get("out") as string) : join(written.dir, "capability.artifact.json");
      await writeFile(outPath, `${JSON.stringify(result.capability, null, 2)}\n`, "utf-8");
      console.log(`discover: done — capability written to ${outPath}`);
    } else {
      console.log(`discover: ${result.status}${"reason" in result ? ` — ${result.reason}` : ""}`);
    }
  } finally {
    await adapter.close();
  }
}

async function runReplay(flags: Map<string, string | true>, providedInputs: Map<string, string>): Promise<void> {
  const capabilityPath = requireFlag(flags, "capability");
  const appProfilePath = requireFlag(flags, "app-profile");
  const baseUrl = typeof flags.get("base-url") === "string" ? (flags.get("base-url") as string) : (process.env.TARGET_APP_BASE_URL ?? "http://localhost:4000");

  const { capability, appProfile } = loadCapabilityWithAppProfile(capabilityPath, appProfilePath);
  const tenantOverlayPath = flags.get("tenant-overlay");
  const tenantOverlay = typeof tenantOverlayPath === "string" ? loadTenantOverlay(tenantOverlayPath) : undefined;

  const inputs: Record<string, string> = {};
  for (const name of Object.keys(capability.inputs)) {
    inputs[name] = resolveInputValue(name, providedInputs);
  }

  const effectiveBaseUrl = tenantOverlay?.baseUrl ?? baseUrl;
  const adapter = await PlaywrightAdapter.launch(effectiveBaseUrl, { headless: resolveHeadless(flags) });
  try {
    const result = await replay(capability, appProfile, adapter, inputs, {
      ...(tenantOverlay ? { tenantOverlay } : {}),
      allowIrreversible: flags.has("allow-irreversible"),
      ...(flags.has("interactive") ? { onEscalation: consoleEscalationHandler } : {}),
    });

    const written = await writeReplayEvidence(capability, inputs, result, adapter);
    console.log(`Evidence written to ${written.dir}`);
    console.log(`replay: ${result.status}${"reason" in result ? ` — ${result.reason}` : ""}`);
    if (result.status !== "success" && result.status !== "business_outcome") {
      process.exitCode = 1;
    }
  } finally {
    await adapter.close();
  }
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  automation discover --goal <path> --app-profile <path> [--input name=value ...] [--out <path>] [--base-url <url>] [--headless]",
      "  automation replay --capability <path> --app-profile <path> [--tenant-overlay <path>] [--input name=value ...] [--allow-irreversible] [--interactive] [--base-url <url>] [--headless]",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const { command, flags, inputs } = parseArgs(process.argv.slice(2));
  try {
    if (command === "discover") {
      await runDiscover(flags, inputs);
    } else if (command === "replay") {
      await runReplay(flags, inputs);
    } else {
      printUsage();
      process.exitCode = command ? 1 : 0;
    }
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(`${basename(process.argv[1] ?? "cli")}: ${err.message}`);
      printUsage();
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
