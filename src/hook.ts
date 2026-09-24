import { ConfigError, credential, readConfig } from "./config";
import { readInput } from "./input";
import { eligibility, route } from "./router";
import { resolve } from "node:path";

const routerCommandPath = `'${resolve(import.meta.dir, "../scripts/router").replaceAll("'", "'\\''")}'`;
const recommendCommand = `${routerCommandPath} recommend`;
const recommendGuidance = `Before an eligible independent spawn without a user, role, or pstack model pin, send the plaintext proposed spawn input JSON on stdin to ${recommendCommand}. Start ordinary worker and researcher inputs with reasoning_effort high as the fallback; for automatic effort selection send a copy without that default field and retain the original high input. If kind route, apply its model and returned reasoning_effort, preserving other fields. If kind preserve, use the original input. User effort choices stay fixed. Do not interpolate task text into shell commands; use a JSON file or safe stdin pipe. This does not authorize new subagents.`;
const pstackGuidance = `For opted-in routine pstack Sol defaults, send {pstackRole,modelSource:"pstack-default",effortSource:"role-default",spawn:<original input>} as JSON on stdin to ${routerCommandPath} recommend-pstack before spawning. Use pstackRole exactly "feature, refactoring" or "swarm workers" with worker, or "how explorer" or "why investigators" with researcher or explorer. Include model gpt-6-sol, fork_turns none, and reasoning_effort high in the original spawn. Label a user or custom effort as effortSource:"explicit". The old three-key request keeps its effort. Direct user or custom role pins, expert and validator roles, bug, performance, strongest-judgment, and comparison or race panel selections stay fixed even when a panel chose Sol. On kind route, apply model and returned reasoning_effort; on kind preserve or an unavailable command, keep the original Sol/high input. No extra delegation is authorized.`;

function report(error: unknown): void {
  if (error instanceof ConfigError) process.stderr.write(`jev-model-router: ${error.message}\n`);
  else process.stderr.write("jev-model-router: unexpected local error\n");
}

async function main(): Promise<void> {
  if (process.argv[2] === "session") {
    try {
      const config = await readConfig();
      if (!config.enabled) { console.log("{}"); return; }
      console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Jev Model Router: ${recommendGuidance} Use fork_turns none only for genuinely independent tasks. Explicit model choices and protected expert or validator roles take precedence. Eligible task text is sent to TypeSafe for classification.${config.pstackRouting ? ` ${pstackGuidance}` : ""}`,
      } }));
    } catch (error) { report(error); console.log("{}"); }
    return;
  }
  const event = await readInput();
  const eligible = eligibility(event);
  if (eligible.kind === "preserve") {
    if (eligible.reason === "encrypted message") {
      try {
        if (!(await readConfig()).enabled) { console.log("{}"); return; }
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: recommendGuidance } }));
      } catch (error) { report(error); console.log("{}"); }
    } else console.log("{}");
    return;
  }
  try {
    const config = await readConfig();
    if (!config.enabled) { console.log("{}"); return; }
    const { key } = await credential(config);
    const decision = await route({ task: eligible.task, role: eligible.role, effort: eligible.effort,
      key, threshold: config.confidenceThreshold });
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...eligible.input, model: decision.model,
        ...(decision.reasoning_effort ? { reasoning_effort: decision.reasoning_effort } : {}) },
      additionalContext: `Jev Model Router selected ${decision.model} (${decision.source}: ${decision.reason}${decision.confidence === undefined ? "" : `, confidence ${decision.confidence.toFixed(2)}`}) and effort ${decision.reasoning_effort ?? "preserved"} (${decision.reasoning_source}: ${decision.reasoning_reason}${decision.reasoning_confidence === undefined ? "" : `, confidence ${decision.reasoning_confidence.toFixed(2)}`}).`,
    } }));
  } catch (error) { report(error); console.log("{}"); }
}

await main();
