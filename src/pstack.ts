import { eligibility, MODELS, type Eligibility } from "./router";

const ROLE_AGENTS = {
  "feature, refactoring": ["worker"],
  "swarm workers": ["worker"],
  "how explorer": ["researcher", "explorer"],
  "why investigators": ["researcher", "explorer"],
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pstackEligibility(value: unknown): Eligibility {
  if (!record(value) || Object.keys(value).length !== 3 ||
      !["pstackRole", "modelSource", "spawn"].every((key) => Object.hasOwn(value, key))) {
    return { kind: "preserve", reason: "invalid pstack input" };
  }
  if (value.modelSource !== "pstack-default") return { kind: "preserve", reason: "unsupported model source" };
  if (typeof value.pstackRole !== "string" || !Object.hasOwn(ROLE_AGENTS, value.pstackRole)) {
    return { kind: "preserve", reason: "unsupported pstack role" };
  }
  const spawn = value.spawn;
  if (!record(spawn)) return { kind: "preserve", reason: "invalid spawn input" };
  if (spawn.model !== MODELS.sol) return { kind: "preserve", reason: "model is not pstack Sol default" };
  const allowedAgents = ROLE_AGENTS[value.pstackRole as keyof typeof ROLE_AGENTS];
  if (typeof spawn.agent_type !== "string" || !allowedAgents.some((agent) => agent === spawn.agent_type)) {
    return { kind: "preserve", reason: "pstack role and agent type mismatch" };
  }
  const { model: _model, ...unpinnedSpawn } = spawn;
  return eligibility({ hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_input: unpinnedSpawn });
}
