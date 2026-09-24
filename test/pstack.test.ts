import { expect, test } from "bun:test";
import { pstackEligibility } from "../src/pstack";
import { eligibility, route } from "../src/router";

const spawn = { message: "Review a routine source change", task_name: "worker_change", fork_turns: "none",
  agent_type: "worker", model: "gpt-6-sol", reasoning_effort: "high", extra: { original: true } };
const request = { pstackRole: "feature, refactoring", modelSource: "pstack-default", spawn };

test("only the four approved pstack defaults map to their matching agent roles", () => {
  for (const [pstackRole, agent_type] of [
    ["feature, refactoring", "worker"], ["swarm workers", "worker"],
    ["how explorer", "researcher"], ["how explorer", "explorer"],
    ["why investigators", "researcher"], ["why investigators", "explorer"],
  ] as const) {
    const original = { ...request, pstackRole, spawn: { ...spawn, agent_type } };
    const result = pstackEligibility(original);
    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      const { model: _model, ...expectedInput } = original.spawn;
      expect(result.input).toEqual(expectedInput);
      expect(Object.hasOwn(result.input, "model")).toBe(false);
      expect(result.role).toBe(agent_type);
      expect(result.effort).toEqual({ kind: "fixed", value: "high" });
    }
    expect(original.spawn.model).toBe("gpt-6-sol");
    expect(original.spawn.extra).toEqual({ original: true });
  }
});

test("effort provenance controls selection without mutating the original spawn", () => {
  const auto = pstackEligibility({ ...request, effortSource: "role-default" });
  expect(auto.kind).toBe("route");
  if (auto.kind === "route") expect(auto.effort).toEqual({ kind: "auto" });
  expect(spawn.reasoning_effort).toBe("high");

  for (const agent_type of ["researcher", "explorer"] as const) {
    const result = pstackEligibility({ ...request, pstackRole: "how explorer", effortSource: "role-default",
      spawn: { ...spawn, agent_type } });
    expect(result.kind).toBe("route");
    if (result.kind === "route") expect(result.effort).toEqual(agent_type === "researcher" ? { kind: "auto" } : { kind: "preserve" });
  }
  const explicit = pstackEligibility({ ...request, effortSource: "explicit",
    spawn: { ...spawn, reasoning_effort: "xhigh" } });
  expect(explicit.kind).toBe("route");
  if (explicit.kind === "route") expect(explicit.effort).toEqual({ kind: "fixed", value: "xhigh" });
  const absent = pstackEligibility({ ...request, spawn: { ...spawn, reasoning_effort: undefined } });
  expect(absent.kind).toBe("preserve");
  const noEffort = pstackEligibility({ ...request, spawn: { message: spawn.message, task_name: spawn.task_name,
    fork_turns: spawn.fork_turns, agent_type: spawn.agent_type, model: spawn.model } });
  expect(noEffort.kind).toBe("route");
  if (noEffort.kind === "route") expect(noEffort.effort).toEqual({ kind: "preserve" });
});

test("pstack provenance and proposed input must match the exact opt-in contract", () => {
  const excluded: unknown[] = [
    null, [], { ...request, extra: true }, { pstackRole: request.pstackRole, spawn },
    { ...request, modelSource: "user" }, { ...request, modelSource: "panel" },
    { ...request, modelSource: "pstack-panel" }, { ...request, modelSource: null },
    { ...request, pstackRole: "bug-fix" }, { ...request, pstackRole: "perf-issue" },
    { ...request, pstackRole: "strongest judgment" }, { ...request, pstackRole: "arena runners" },
    { ...request, pstackRole: "feature, refactoring", spawn: { ...spawn, agent_type: "researcher" } },
    { ...request, pstackRole: "how explorer", spawn },
    { ...request, spawn: [] },
    { ...request, spawn: { ...spawn, model: undefined } },
    { ...request, spawn: { ...spawn, model: null } },
    { ...request, spawn: { ...spawn, model: "gpt-6-astra" } },
    { ...request, spawn: { ...spawn, fork_turns: "all" } },
    { ...request, spawn: { ...spawn, task_name: "expert_audit" } },
    { ...request, spawn: { ...spawn, task_name: "validator_check" } },
    { ...request, spawn: { ...spawn, agent_type: "expert" } },
    { ...request, spawn: { ...spawn, agent_type: "validator" } },
    { ...request, spawn: { ...spawn, message: `gAAAA${"A".repeat(100)}=` } },
    { ...request, effortSource: "role-default", spawn: { ...spawn, reasoning_effort: "low" } },
    { ...request, effortSource: "explicit", spawn: { ...spawn, reasoning_effort: undefined } },
    { ...request, effortSource: "unknown" },
    { ...request, effortSource: "role-default", spawn: { ...spawn, reasoning_effort: "ultra" } },
  ];
  for (const value of excluded) expect(pstackEligibility(value).kind).toBe("preserve");
});

test("generic routing keeps explicit Sol pinned even when pstack eligibility accepts it", () => {
  expect(eligibility({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: spawn })).toEqual({ kind: "preserve", reason: "explicit model" });
  expect(pstackEligibility(request).kind).toBe("route");
});

test("approved pstack input can use the shared Jev choice without changing its other fields", async () => {
  const result = pstackEligibility(request);
  expect(result.kind).toBe("route");
  if (result.kind !== "route") return;
  const decision = await route({ task: result.task, role: result.role, effort: result.effort,
    key: "synthetic-key", threshold: 0.6, transport: async (_url, init) => {
      expect(Object.keys(JSON.parse(String(init.body)).questions)).toEqual(["route"]);
      return new Response(JSON.stringify({
    answers: { route: { type: "choice", choice: "astra", confidence: 0.91,
      probabilities: { luna: 0.02, sol: 0.03, astra: 0.95 } } },
      }));
    } });
  expect(decision.model).toBe("gpt-6-astra");
  expect(decision.reasoning_effort).toBe("high");
  expect({ ...spawn, model: decision.model }).toEqual({ ...spawn, model: "gpt-6-astra" });
  expect(spawn.model).toBe("gpt-6-sol");
});
