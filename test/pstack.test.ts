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
    }
    expect(original.spawn.model).toBe("gpt-6-sol");
    expect(original.spawn.extra).toEqual({ original: true });
  }
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
  const decision = await route(result.task, result.role, "synthetic-key", 0.6, async () => new Response(JSON.stringify({
    answers: { route: { type: "choice", choice: "astra", confidence: 0.91,
      probabilities: { luna: 0.02, sol: 0.03, astra: 0.95 } } },
  })));
  expect(decision.model).toBe("gpt-6-astra");
  expect({ ...spawn, model: decision.model }).toEqual({ ...spawn, model: "gpt-6-astra" });
  expect(spawn.model).toBe("gpt-6-sol");
});
