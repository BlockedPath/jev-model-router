import { describe, expect, test } from "bun:test";
import { eligibility, EFFORTS, route, type Effort, type EffortPolicy } from "../src/router";

const base = { hook_event_name: "PreToolUse", tool_name: "spawn_agent", tool_input: {
  message: "Inspect a small file", task_name: "researcher_file", fork_turns: "none", agent_type: "researcher", extra: { kept: true },
} };
const auto: EffortPolicy = { kind: "auto" };
const fixed = (value: Effort): EffortPolicy => ({ kind: "fixed", value });
const preserve: EffortPolicy = { kind: "preserve" };
const request = (effort: EffortPolicy = auto, transport?: (url: string, init: RequestInit) => Promise<Response>) =>
  ({ task: "A task", role: "worker", effort, key: "test-key", threshold: 0.6, transport });

function choice<K extends string>(options: readonly K[], selected: K, confidence = 0.9) {
  const probabilities = Object.fromEntries(options.map((option) => [option, option === selected ? 0.9 : 0.1 / (options.length - 1)]));
  return { type: "choice", choice: selected, confidence, probabilities };
}
const models = ["luna", "sol", "astra"] as const;
function response(model: (typeof models)[number], effort: Effort = "high", modelConfidence = 0.9, effortConfidence = 0.9): Response {
  return new Response(JSON.stringify({ answers: { route: choice(models, model, modelConfidence),
    effort: choice(EFFORTS, effort, effortConfidence) }, usage: { input_tokens: 12, output_tokens: 3 } }));
}

describe("eligibility", () => {
  test("routes the three spawn names and keeps input", () => {
    for (const tool_name of ["spawn_agent", "collaboration.spawn_agent", "collaborationspawn_agent"]) {
      const result = eligibility({ ...base, tool_name });
      expect(result.kind).toBe("route");
      if (result.kind === "route") {
        expect(result.input).toEqual(base.tool_input);
        expect(result.effort).toEqual(auto);
      }
    }
  });

  test("preserves explicit models, inherited history, protected roles and unsupported effort", () => {
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

  test("assigns auto only to ordinary unpinned roles and fixes every compatible explicit effort", () => {
    for (const role of [undefined, "default", "researcher", "planner", "worker", "reviewer", "explorer"]) {
      for (const effort of [undefined, ...EFFORTS]) {
        const input = { ...base.tool_input, ...(role ? { agent_type: role } : {}), ...(effort ? { reasoning_effort: effort } : {}) };
        const result = eligibility({ ...base, tool_input: input });
        expect(result.kind).toBe("route");
        if (result.kind === "route") expect(result.effort).toEqual(effort ? fixed(effort) :
          ["planner", "reviewer", "explorer"].includes(role ?? "") ? preserve : auto);
      }
    }
  });

  test("preserves an opaque token but accepts a plaintext task with the same prefix", () => {
    const encrypted = `gAAAA${"A".repeat(100)}=`;
    expect(eligibility({ ...base, tool_name: "collaborationspawn_agent",
      tool_input: { ...base.tool_input, message: encrypted } })).toEqual({ kind: "preserve", reason: "encrypted message" });
    expect(eligibility({ ...base, tool_input: { ...base.tool_input, message: "gAAAA is a string to inspect" } }).kind).toBe("route");
  });
});

describe("Jev choices", () => {
  test("asks two independent questions once for every model and effort pair", async () => {
    for (const model of models) for (const effort of EFFORTS) {
      let called = 0;
      const result = await route({ ...request(), transport: async (url, init) => {
        called++;
        expect(url).toBe("https://api.typesafe.ai/v1/systemone");
        expect(init.redirect).toBe("error");
        const body = JSON.parse(String(init.body));
        expect(body.model).toBe("jev-latest");
        expect(body.state).toEqual({ task: "A task", role: "worker" });
        expect(Object.keys(body.questions)).toEqual(["route", "effort"]);
        expect(Object.keys(body.questions.route.criteria)).toEqual([...models]);
        expect(Object.keys(body.questions.effort.criteria)).toEqual([...EFFORTS]);
        return response(model, effort);
      } });
      expect(called).toBe(1);
      expect(result).toMatchObject({ model: `gpt-6-${model}`, source: "jev", confidence: 0.9,
        reasoning_effort: effort, reasoning_source: "jev", reasoning_confidence: 0.9,
        usage: { input_tokens: 12, output_tokens: 3 } });
    }
  });

  test("fixed and preserved efforts never request an effort answer", async () => {
    for (const effort of EFFORTS) {
      const result = await route({ ...request(fixed(effort)), transport: async (_url, init) => {
        expect(Object.keys(JSON.parse(String(init.body)).questions)).toEqual(["route"]);
        return response("astra", "low");
      } });
      expect(result).toMatchObject({ model: "gpt-6-astra", reasoning_effort: effort, reasoning_source: "explicit" });
    }
    const result = await route({ ...request(preserve), transport: async (_url, init) => {
      expect(Object.keys(JSON.parse(String(init.body)).questions)).toEqual(["route"]);
      return response("luna", "low");
    } });
    expect(result.reasoning_source).toBe("preserved");
    expect(Object.hasOwn(result, "reasoning_effort")).toBe(false);
  });

  test("each malformed or uncertain answer falls back independently", async () => {
    const validModel = choice(models, "astra");
    const validEffort = choice(EFFORTS, "xhigh");
    const invalidAnswers = [
      undefined,
      { ...validModel, type: "other" },
      { ...validModel, probabilities: { luna: 0.3, sol: 0.6, astra: 0.1 } },
      { ...validModel, probabilities: { luna: 0.1, sol: 0, astra: 0.9, extra: 0 } },
      { ...validModel, probabilities: { luna: 0.7, sol: 0.1, astra: 0.1 } },
      { ...validModel, probabilities: { luna: "0.05", sol: 0.05, astra: 0.9 } },
      { ...validModel, confidence: 1.1 },
      { ...validModel, confidence: 0.59 },
    ];
    for (const routeAnswer of invalidAnswers) {
      const result = await route({ ...request(), transport: async () => new Response(JSON.stringify({ answers: {
        route: routeAnswer, effort: validEffort } })) });
      expect(result).toMatchObject({ model: "gpt-6-sol", source: "fallback", reasoning_effort: "xhigh", reasoning_source: "jev" });
    }
    const invalidEfforts = [undefined, { ...validEffort, type: "other" },
      { ...validEffort, probabilities: { low: 0.9, medium: 0.1, high: 0, xhigh: 0, max: 0 } },
      { ...validEffort, confidence: Number.NaN }, { ...validEffort, confidence: 0.59 }];
    for (const effortAnswer of invalidEfforts) {
      const result = await route({ ...request(), transport: async () => new Response(JSON.stringify({ answers: {
        route: validModel, effort: effortAnswer } })) });
      expect(result).toMatchObject({ model: "gpt-6-astra", source: "jev", reasoning_effort: "high", reasoning_source: "fallback" });
      expect(result.reasoning_confidence).toBeUndefined();
    }
  });

  test("the configured threshold accepts both answers at its boundary", async () => {
    const result = await route({ ...request(), transport: async () => response("luna", "xhigh", 0.6, 0.6) });
    expect(result).toMatchObject({ model: "gpt-6-luna", source: "jev", confidence: 0.6,
      reasoning_effort: "xhigh", reasoning_source: "jev", reasoning_confidence: 0.6 });
  });

  test("keeps caller effort across model failure and uses high for automatic whole failure", async () => {
    const bad = async () => new Response("bad", { status: 429 });
    for (const effort of EFFORTS) {
      const result = await route({ ...request(fixed(effort)), transport: bad });
      expect(result).toMatchObject({ model: "gpt-6-sol", reasoning_effort: effort, reasoning_source: "explicit" });
    }
    expect(await route({ ...request(), transport: bad })).toMatchObject({ model: "gpt-6-sol", reasoning_effort: "high", reasoning_source: "fallback" });
    const result = await route({ ...request(preserve), transport: bad });
    expect(result.model).toBe("gpt-6-sol");
    expect(Object.hasOwn(result, "reasoning_effort")).toBe(false);
  });

  test("does not call the service without a key or for an oversized task", async () => {
    let calls = 0;
    const never = async () => { calls++; throw new Error("network should not run"); };
    expect((await route({ ...request(), key: undefined, transport: never })).reasoning_effort).toBe("high");
    expect((await route({ ...request(), task: "x".repeat(16_001), transport: never })).model).toBe("gpt-6-sol");
    expect(calls).toBe(0);
  });

  test("releases an HTTP error response even if its body never finishes", async () => {
    let signal: AbortSignal | null | undefined;
    const result = await route({ ...request(), transport: async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream(), { status: 429 });
    } });
    expect(result.source).toBe("fallback");
    expect(signal?.aborted).toBe(true);
  });

  test("falls back for redirect rejection, deadline, stalled body and large body", async () => {
    expect((await route({ ...request(), transport: async () => { throw new Error("redirect"); } })).source).toBe("fallback");
    const late = async () => await new Promise<Response>(() => undefined);
    const started = performance.now();
    expect((await route({ ...request(), transport: late })).reason).toBe("service timeout");
    expect(performance.now() - started).toBeLessThan(5_000);
    const stalled = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
    const stalledStart = performance.now();
    expect((await route({ ...request(), transport: async () => stalled })).reason).toBe("service timeout");
    expect(performance.now() - stalledStart).toBeLessThan(5_000);
    expect((await route({ ...request(), transport: async () => new Response("x".repeat(65_537)) })).source).toBe("fallback");
  }, 10_000);
});
