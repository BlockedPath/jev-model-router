import { describe, expect, test } from "bun:test";
import { eligibility, route } from "../src/router";

const base = { hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_input: {
  message: "Inspect a small file", task_name: "researcher_file", fork_turns: "none", agent_type: "researcher", extra: { kept: true },
} };

function response(choice: "luna" | "sol" | "astra", confidence = 0.9): Response {
  const probabilities = { luna: 0.05, sol: 0.05, astra: 0.05, [choice]: 0.9 };
  return new Response(JSON.stringify({ answers: { route: { type: "choice", choice, confidence, probabilities } },
    usage: { input_tokens: 12, output_tokens: 3 } }));
}

describe("eligibility", () => {
  test("routes the three exact spawn tool names and retains the original input", () => {
    for (const tool_name of ["spawn_agent", "collaboration.spawn_agent", "collaborationspawn_agent"]) {
      const result = eligibility({ ...base, tool_name });
      expect(result.kind).toBe("route");
      if (result.kind === "route") expect(result.input).toEqual(base.tool_input);
    }
  });

  test("preserves explicit choices, inherited history, protected and unknown roles, and unsupported effort", () => {
    const inputs = [
      { model: null }, { model: "" }, { fork_turns: "all" }, { fork_turns: undefined },
      { agent_type: "expert" }, { agent_type: "validator" }, { agent_type: "custom" },
      { task_name: "expert_audit" }, { task_name: "validator_runtime" },
      { reasoning_effort: "ultra" }, { reasoning_effort: "none" },
      { message: "" }, { task_name: "" },
    ];
    for (const change of inputs) {
      expect(eligibility({ ...base, tool_input: { ...base.tool_input, ...change } }).kind).toBe("preserve");
    }
    expect(eligibility({ ...base, tool_name: "other" }).kind).toBe("preserve");
    expect(eligibility({ ...base, hook_event_name: "PostToolUse" }).kind).toBe("preserve");
    expect(eligibility({ ...base, tool_input: [] }).kind).toBe("preserve");
  });

  test("accepts compatible effort and the ordinary role allowlist", () => {
    for (const role of [undefined, "default", "researcher", "planner", "worker", "reviewer", "explorer"]) {
      for (const effort of [undefined, "low", "medium", "high", "xhigh", "max"]) {
        const input = { ...base.tool_input, ...(role ? { agent_type: role } : {}), ...(effort ? { reasoning_effort: effort } : {}) };
        expect(eligibility({ ...base, tool_input: input }).kind).toBe("route");
      }
    }
  });

  test("preserves a whole opaque token but accepts a plaintext task with the same prefix", () => {
    const encrypted = `gAAAA${"A".repeat(100)}=`;
    expect(eligibility({ ...base, tool_name: "collaborationspawn_agent",
      tool_input: { ...base.tool_input, message: encrypted } })).toEqual({ kind: "preserve", reason: "encrypted message" });
    expect(eligibility({ ...base, tool_input: { ...base.tool_input, message: "gAAAA is a string to inspect" } }).kind).toBe("route");
  });
});

describe("Jev choice", () => {
  test("uses the selected tier and sends a fixed bounded request", async () => {
    for (const choice of ["luna", "sol", "astra"] as const) {
      let called = 0;
      const result = await route("A task", "worker", "test-key", 0.6, async (url, init) => {
        called++;
        expect(url).toBe("https://api.typesafe.ai/v1/systemone");
        expect(init?.redirect).toBe("error");
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("jev-latest");
        expect(body.state).toEqual({ task: "A task", role: "worker" });
        expect(Object.keys(body.questions.route.criteria)).toEqual(["luna", "sol", "astra"]);
        return response(choice);
      });
      expect(called).toBe(1);
      expect(result).toMatchObject({ model: `gpt-6-${choice}`, source: "jev", confidence: 0.9,
        usage: { input_tokens: 12, output_tokens: 3 } });
    }
  });

  test("does not call the service without a key or for an oversized task", async () => {
    let calls = 0;
    const never = async () => { calls++; throw new Error("network should not run"); };
    expect((await route("task", "worker", undefined, 0.6, never)).model).toBe("gpt-6-sol");
    expect((await route("x".repeat(16_001), "worker", "test", 0.6, never)).model).toBe("gpt-6-sol");
    expect(calls).toBe(0);
  });

  test("releases an HTTP error response even if its body never finishes", async () => {
    let signal: AbortSignal | null | undefined;
    const result = await route("task", "worker", "test", 0.6, async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream(), { status: 429 });
    });
    expect(result.source).toBe("fallback");
    expect(signal?.aborted).toBe(true);
  });

  test("falls back on malformed, inconsistent, or uncertain answers", async () => {
    const bad = [
      {}, { answers: { route: { type: "noul", choice: "luna" } } },
      { answers: { route: { type: "choice", choice: "luna", confidence: 0.9,
        probabilities: { luna: 0.3, sol: 0.6, astra: 0.1 } } } },
      { answers: { route: { type: "choice", choice: "luna", confidence: 0.9,
        probabilities: { luna: 0.9, sol: 0.1, astra: 0, extra: 0 } } } },
      { answers: { route: { type: "choice", choice: "luna", confidence: 0.9,
        probabilities: { luna: 0.7, sol: 0.1, astra: 0.1 } } } },
    ];
    for (const value of bad) {
      expect((await route("task", "worker", "test", 0.6, async () => new Response(JSON.stringify(value)))).source).toBe("fallback");
    }
    expect((await route("task", "worker", "test", 0.6, async () => response("luna", 0.59))).reason).toBe("low confidence");
  });

  test("falls back for HTTP, redirect rejection, deadline, stalled body, and large body", async () => {
    expect((await route("task", "worker", "test", 0.6, async () => new Response("bad", { status: 429 }))).source).toBe("fallback");
    expect((await route("task", "worker", "test", 0.6, async () => { throw new Error("redirect"); })).source).toBe("fallback");
    const late = async () => await new Promise<Response>(() => undefined);
    const started = performance.now();
    expect((await route("task", "worker", "test", 0.6, late)).reason).toBe("service timeout");
    expect(performance.now() - started).toBeLessThan(5_000);
    const stalled = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
    const stalledStart = performance.now();
    expect((await route("task", "worker", "test", 0.6, async () => stalled)).reason).toBe("service timeout");
    expect(performance.now() - stalledStart).toBeLessThan(5_000);
    const huge = "x".repeat(65_537);
    expect((await route("task", "worker", "test", 0.6, async () => new Response(huge))).source).toBe("fallback");
  }, 10_000);
});
