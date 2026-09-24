import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directories: string[] = [];
const pluginRoot = join(import.meta.dir, "..");

async function hook(input: unknown, options: { config?: string; cwdEnv?: string; session?: boolean } = {}) {
  const temporary = await mkdtemp(join(import.meta.dir, "tmp-"));
  directories.push(temporary);
  if (options.config !== undefined) await writeFile(join(temporary, "jev-model-router.json"), options.config);
  if (options.cwdEnv !== undefined) await writeFile(join(temporary, ".env"), options.cwdEnv);
  const proc = Bun.spawn([process.execPath, "--no-env-file", join(pluginRoot, "src/hook.ts"), ...(options.session ? ["session"] : [])], {
    cwd: temporary,
    env: { PATH: process.env.PATH ?? "", HOME: temporary, CODEX_HOME: temporary, BUN_CONFIG_VERBOSE_FETCH: "0" },
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { output: JSON.parse(stdout), stderr, exitCode, temporary };
}

afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("exclusions produce no rewrite or network when config is invalid", async () => {
  const input = { hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_input: {
    message: "task", task_name: "worker_task", fork_turns: "all", extra: "kept",
  } };
  const result = await hook(input, { config: "invalid JSON" });
  expect(result.output).toEqual({});
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("eligible input falls back to Sol while preserving all fields and never loading cwd .env", async () => {
  const input = { hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: {
    message: "task", task_name: "worker_task", fork_turns: "none", agent_type: "worker", reasoning_effort: "high", extra: { nested: 1 },
  } };
  const result = await hook(input, { cwdEnv: "TYPESAFE_API_KEY=trap-key" });
  expect(result.output.hookSpecificOutput.updatedInput).toEqual({ ...input.tool_input, model: "gpt-6-sol" });
  expect(result.output.hookSpecificOutput.permissionDecision).toBe("allow");
  expect(result.output.hookSpecificOutput.additionalContext).not.toContain("trap-key");
  expect(result.output.hookSpecificOutput.additionalContext).toContain("credential unavailable");
  expect(result.exitCode).toBe(0);
});

test("automatic fallback adds high only to ordinary roles and preserves unrelated input", async () => {
  const tool_input = { message: "task", task_name: "worker_task", fork_turns: "none", agent_type: "worker",
    extra: { nested: 1 } };
  const result = await hook({ hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_input });
  expect(result.output.hookSpecificOutput.updatedInput).toEqual({ ...tool_input, model: "gpt-6-sol", reasoning_effort: "high" });
  expect(Object.keys(result.output.hookSpecificOutput.updatedInput).sort()).toEqual(
    [...Object.keys(tool_input), "model", "reasoning_effort"].sort());
  expect(result.output.hookSpecificOutput.additionalContext).toContain("effort high (fallback");

  const planner = { ...tool_input, agent_type: "planner", task_name: "planner_task" };
  const preserved = await hook({ hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_input: planner });
  expect(preserved.output.hookSpecificOutput.updatedInput).toEqual({ ...planner, model: "gpt-6-sol" });
});

test("invalid config passes eligible call through with a sanitized error", async () => {
  const result = await hook({ hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_input: {
    message: "secret task", task_name: "worker_task", fork_turns: "none",
  } }, { config: "{invalid" });
  expect(result.output).toEqual({});
  expect(result.stderr).toContain("Router config is not valid JSON");
  expect(result.stderr).not.toContain("secret task");
});

test("session start explains pins and privacy", async () => {
  const result = await hook({}, { session: true });
  const text = result.output.hookSpecificOutput.additionalContext;
  expect(text).toContain("pstack");
  expect(text).toContain("TypeSafe");
  expect(text).toContain("does not authorize new subagents");
  expect(text).toContain("/scripts/router' recommend");
  expect(text).not.toContain("recommend-pstack");
});

test("session start adds scoped pstack guidance only when opted in", async () => {
  const result = await hook({}, { session: true, config: JSON.stringify({ pstackRouting: true }) });
  const text = result.output.hookSpecificOutput.additionalContext;
  expect(text).toContain("/scripts/router' recommend-pstack");
  expect(text).toContain('modelSource:"pstack-default"');
  expect(text).toContain('effortSource:"role-default"');
  expect(text).toContain("comparison or race panel selections stay fixed");
  expect(text).toContain("kind preserve or an unavailable command, keep the original Sol/high input");
  expect(text.length).toBeLessThan(2500);
});

test("opaque Codex message is preserved with guidance and no credential or network access", async () => {
  const ciphertext = `gAAAA${"A".repeat(100)}=`;
  const result = await hook({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: {
    message: ciphertext, task_name: "worker_secret", fork_turns: "none", agent_type: "worker",
  } }, { config: JSON.stringify({ envFile: "/nonexistent/jev-router-test-key" }) });
  expect(result.output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(result.output.hookSpecificOutput.updatedInput).toBeUndefined();
  expect(result.output.hookSpecificOutput.additionalContext).toContain("recommend");
  expect(JSON.stringify(result.output)).not.toContain(ciphertext);
  expect(result.stderr).toBe("");
});

test("disabled session emits no context", async () => {
  const result = await hook({}, { session: true, config: JSON.stringify({ enabled: false }) });
  expect(result.output).toEqual({});
});

test("disabled router emits no recommendation guidance for encrypted messages", async () => {
  const result = await hook({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: {
    message: `gAAAA${"A".repeat(100)}=`, task_name: "worker_secret", fork_turns: "none",
  } }, { config: JSON.stringify({ enabled: false }) });
  expect(result.output).toEqual({});
});

test("hook caps oversized stdin", async () => {
  const result = await hook({ hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_input: {
    message: "x".repeat(132_000), task_name: "worker_large", fork_turns: "none",
  } });
  expect(result.output).toEqual({});
});
