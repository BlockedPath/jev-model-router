import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directories: string[] = [];
const routerCommand = join(import.meta.dir, "../scripts/router");

async function invoke(temporary: string, command: string, input: unknown = {}, key?: string) {
  const proc = Bun.spawn([routerCommand, command], {
    cwd: temporary,
    env: { PATH: process.env.PATH ?? "", HOME: temporary, CODEX_HOME: temporary,
      BUN_CONFIG_VERBOSE_FETCH: "0", ...(key ? { TYPESAFE_API_KEY: key } : {}) },
    stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { output: command.startsWith("recommend") || command === "status" ? JSON.parse(stdout) : stdout.trim(), stderr, exitCode };
}

async function recommend(input: unknown, config?: string, key?: string, command = "recommend") {
  const temporary = await mkdtemp(join(import.meta.dir, "tmp-"));
  directories.push(temporary);
  if (config !== undefined) await writeFile(join(temporary, "jev-model-router.json"), config);
  await writeFile(join(temporary, ".env"), "TYPESAFE_API_KEY=trap-key\n");
  return invoke(temporary, command, input, key);
}

afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("recommend returns an explicit fallback model for eligible plaintext without loading cwd .env", async () => {
  const input = { message: "A private proposed task", task_name: "worker_task", fork_turns: "none", agent_type: "worker", extra: 1 };
  const result = await recommend(input);
  expect(result.output).toMatchObject({ kind: "route", model: "gpt-6-sol", source: "fallback", reason: "credential unavailable" });
  expect(JSON.stringify(result.output)).not.toContain(input.message);
  expect(JSON.stringify(result.output)).not.toContain("trap-key");
  expect(result.exitCode).toBe(0);
});

test("recommend preserves pinned, protected, and encrypted inputs before config access", async () => {
  const input = { message: "task", task_name: "worker_task", fork_turns: "none", agent_type: "worker" };
  for (const [change, reason] of [
    [{ model: "gpt-6-astra" }, "explicit model"],
    [{ agent_type: "expert" }, "protected or unknown role"],
    [{ task_name: "validator_check" }, "protected task"],
    [{ message: `gAAAA${"A".repeat(100)}=` }, "encrypted message"],
  ] as const) {
    const result = await recommend({ ...input, ...change }, "invalid JSON", "synthetic-key");
    expect(result.output).toEqual({ kind: "preserve", reason });
    expect(result.stderr).toBe("");
  }
});

test("recommend treats config errors and invalid input as preserve", async () => {
  const input = { message: "task", task_name: "worker_task", fork_turns: "none" };
  expect((await recommend(input, "invalid JSON")).output).toEqual({ kind: "preserve", reason: "Router config is not valid JSON" });
  expect((await recommend({ message: "task" })).output.kind).toBe("preserve");
  expect((await recommend({ message: "x".repeat(130_000) })).output.kind).toBe("preserve");
});

test("recommend-pstack requires opt-in and falls back to Sol only for an eligible default", async () => {
  const input = { pstackRole: "feature, refactoring", modelSource: "pstack-default", spawn: {
    message: "Routine code change", task_name: "worker_change", fork_turns: "none", agent_type: "worker",
    model: "gpt-6-sol", extra: "preserved",
  } };
  expect((await recommend(input, undefined, undefined, "recommend-pstack")).output).toEqual({
    kind: "preserve", reason: "pstack routing disabled",
  });
  const enabled = await recommend(input, JSON.stringify({ pstackRouting: true }), undefined, "recommend-pstack");
  expect(enabled.output).toMatchObject({ kind: "route", model: "gpt-6-sol", source: "fallback", reason: "credential unavailable" });
  expect(JSON.stringify(enabled.output)).not.toContain(input.spawn.message);
  expect((await recommend(input, JSON.stringify({ enabled: false, pstackRouting: true }), undefined, "recommend-pstack")).output)
    .toEqual({ kind: "preserve", reason: "router disabled" });
});

test("excluded pstack requests do not read the configured key file", async () => {
  const config = JSON.stringify({ pstackRouting: true, envFile: "/nonexistent/jev-router-test-key" });
  const spawn = { message: "task", task_name: "worker_task", fork_turns: "none", agent_type: "worker", model: "gpt-6-sol" };
  for (const value of [
    { pstackRole: "feature, refactoring", modelSource: "user", spawn },
    { pstackRole: "feature, refactoring", modelSource: "panel", spawn },
    { pstackRole: "bug-fix", modelSource: "pstack-default", spawn },
    { pstackRole: "feature, refactoring", modelSource: "pstack-default", spawn: { ...spawn, task_name: "validator_check" } },
    { pstackRole: "feature, refactoring", modelSource: "pstack-default", spawn: { ...spawn, message: `gAAAA${"A".repeat(100)}=` } },
  ]) {
    const result = await recommend(value, config, undefined, "recommend-pstack");
    expect(result.output.kind).toBe("preserve");
    expect(JSON.stringify(result.output)).not.toContain("Cannot read configured envFile");
    expect(result.stderr).toBe("");
  }
});

test("local config errors preserve pstack input while generic recommend still protects Sol", async () => {
  const spawn = { message: "task", task_name: "worker_task", fork_turns: "none", agent_type: "worker", model: "gpt-6-sol" };
  const input = { pstackRole: "feature, refactoring", modelSource: "pstack-default", spawn };
  expect((await recommend(input, "invalid JSON", undefined, "recommend-pstack")).output)
    .toEqual({ kind: "preserve", reason: "Router config is not valid JSON" });
  expect((await recommend(input, JSON.stringify({ pstackRouting: true, envFile: "/nonexistent/jev-router-test-key" }), undefined, "recommend-pstack")).output)
    .toEqual({ kind: "preserve", reason: "Cannot read configured envFile" });
  expect((await recommend(spawn, JSON.stringify({ pstackRouting: true }))).output)
    .toEqual({ kind: "preserve", reason: "explicit model" });
});

test("pstack toggles preserve other config fields and status exposes the opt-in", async () => {
  const temporary = await mkdtemp(join(import.meta.dir, "tmp-"));
  directories.push(temporary);
  const path = join(temporary, "jev-model-router.json");
  const original = { enabled: false, pstackRouting: false, confidenceThreshold: 0.72,
    envFile: "/nonexistent/jev-router-test-key" };
  await writeFile(path, JSON.stringify(original));
  expect((await invoke(temporary, "pstack-enable")).exitCode).toBe(0);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...original, pstackRouting: true });
  expect((await invoke(temporary, "pstack-disable")).exitCode).toBe(0);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
  await writeFile(path, JSON.stringify({ enabled: true, pstackRouting: true, confidenceThreshold: 0.72 }));
  const status = await invoke(temporary, "status");
  expect(status.output).toMatchObject({ enabled: true, pstackRouting: true, confidenceThreshold: 0.72, credentialPresent: false });
});
