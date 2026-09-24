import { isAbsolute } from "node:path";
import { ConfigError, credential, configPath, readConfig, writeConfig } from "./config";
import { readInput } from "./input";
import { pstackEligibility } from "./pstack";
import { eligibility, route } from "./router";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "recommend" || command === "recommend-pstack") {
    const input = await readInput();
    const eligible = command === "recommend-pstack"
      ? pstackEligibility(input)
      : eligibility({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: input });
    if (eligible.kind === "preserve") {
      console.log(JSON.stringify({ kind: "preserve", reason: eligible.reason }));
      return;
    }
    try {
      const config = await readConfig();
      if (!config.enabled) { console.log(JSON.stringify({ kind: "preserve", reason: "router disabled" })); return; }
      if (command === "recommend-pstack" && !config.pstackRouting) {
        console.log(JSON.stringify({ kind: "preserve", reason: "pstack routing disabled" }));
        return;
      }
      const { key } = await credential(config);
      const decision = await route(eligible.task, eligible.role, key, config.confidenceThreshold);
      console.log(JSON.stringify({ kind: "route", model: decision.model, source: decision.source,
        reason: decision.reason, confidence: decision.confidence ?? null, usage: decision.usage ?? null }));
    } catch (error) {
      console.log(JSON.stringify({ kind: "preserve", reason: error instanceof ConfigError ? error.message : "unexpected local error" }));
    }
    return;
  }
  if (command === "setup") {
    if (process.argv[3] !== "--env-file" || !process.argv[4] || process.argv.length !== 5 || !isAbsolute(process.argv[4])) {
      throw new ConfigError("Usage: setup --env-file /absolute/path");
    }
    const config = { ...(await readConfig()), envFile: process.argv[4] };
    const path = await writeConfig(config);
    console.log(`Router config written to ${path}`);
    return;
  }
  if (command === "status") {
    const config = await readConfig();
    const found = await credential(config);
    console.log(JSON.stringify({ configPath: configPath(), enabled: config.enabled,
      pstackRouting: config.pstackRouting, confidenceThreshold: config.confidenceThreshold,
      credentialPresent: Boolean(found.key), credentialSource: found.source }));
    return;
  }
  if (command === "enable" || command === "disable") {
    const config = await readConfig();
    const path = await writeConfig({ ...config, enabled: command === "enable" });
    console.log(`Router ${command === "enable" ? "enabled" : "disabled"} in ${path}`);
    return;
  }
  if (command === "pstack-enable" || command === "pstack-disable") {
    const config = await readConfig();
    const path = await writeConfig({ ...config, pstackRouting: command === "pstack-enable" });
    console.log(`Pstack routing ${command === "pstack-enable" ? "enabled" : "disabled"} in ${path}`);
    return;
  }
  if (command === "live-smoke") {
    const config = await readConfig();
    const found = await credential(config);
    if (!found.key) throw new ConfigError("No TypeSafe credential is available");
    const started = performance.now();
    const result = await route("Look up the current installed Bun version and report the version string.", "researcher", found.key, config.confidenceThreshold);
    console.log(JSON.stringify({ model: result.model, source: result.source, reason: result.reason,
      confidence: result.confidence ?? null, latencyMs: Math.round(performance.now() - started), usage: result.usage ?? null }));
    if (result.source !== "jev") process.exitCode = 1;
    return;
  }
  throw new ConfigError("Usage: router recommend | recommend-pstack | setup --env-file /absolute/path | status | enable | disable | pstack-enable | pstack-disable | live-smoke");
}

try { await main(); }
catch (error) {
  process.stderr.write(`jev-model-router: ${error instanceof ConfigError ? error.message : "unexpected local error"}\n`);
  process.exitCode = 1;
}
