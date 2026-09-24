# Jev Model Router

This Codex plugin asks TypeSafe Jev to choose `gpt-6-luna`, `gpt-6-sol`, or `gpt-6-astra` for eligible independent subagents. It leaves the parent model and explicit subagent model choices untouched. Codex may encrypt the task message before a PreToolUse hook sees it, so agents should use the plaintext `recommend` command before spawning.

## Install

You need Codex with plugin and subagent support, Bun on the Codex host's PATH, a TypeSafe API key, and access to the configured Astra, Sol, and Luna models. The launch scripts currently require a POSIX shell, such as on macOS, Linux, or WSL. Bun 1.3.14 and Codex CLI 0.156.1 were used for verification.

Add the GitHub marketplace and install the plugin:

```sh
codex plugin marketplace add BlockedPath/jev-model-router
codex plugin add jev-model-router@jev-model-router
```

Then ask Codex to configure Jev Model Router using an existing key file. The plugin's skill locates its installed setup command. You can also clone the source to run the commands yourself:

```sh
git clone https://github.com/BlockedPath/jev-model-router.git
cd jev-model-router
scripts/router setup --env-file /absolute/path/to/key-file
scripts/router status
```

The key file must contain a `TYPESAFE_API_KEY=value` line. Alternatively, export `TYPESAFE_API_KEY` in the Codex process. The plugin reads only the explicitly named key file; it does not automatically load a project's `.env`. Each user supplies their own key. Review and trust the plugin hooks in `/hooks`, then start a fresh task.

When testing a local clone before publication, replace the marketplace-add command with `codex plugin marketplace add /absolute/path/to/jev-model-router`.

Run `scripts/router status` to check whether routing is enabled and a credential is available. Run `scripts/router disable` or `scripts/router enable` to change it. Run `scripts/router live-smoke` for a synthetic request to TypeSafe. The smoke command prints the model, latency, confidence, and usage, but no task text or key.

The pstack bridge is off by default. If you use pstack, run `scripts/router pstack-enable` and add the [scoped integration instructions](references/pstack-integration.md) to your Codex `AGENTS.md` and pstack model sheet. Keep existing model rows as fallbacks. This repository does not install or overwrite personal pstack settings. `scripts/router pstack-disable` turns the bridge off without changing the rest of the config. `status` reports `pstackRouting`.

## Recommend a model before spawning

Prepare the proposed `spawn_agent` input as JSON in a local file. Then run `scripts/router recommend < /absolute/path/to/proposed-spawn.json` from the plugin root. For example, a proposed input can have `message`, `task_name`, `fork_turns: "none"`, and `agent_type: "worker"`. Use a file tool to write the JSON. Do not interpolate task text into shell code.

If the command returns `kind: "route"`, pass its `model` explicitly to `spawn_agent` and keep every other field unchanged. If it returns `kind: "preserve"`, use the original input. This command does not authorize delegation. It applies only when delegation is already allowed and no user, role, or pstack model pin takes precedence. The command never prints the task or key.

## Reconsider scoped pstack Sol defaults

When `pstackRouting` is enabled and Sol came from one of the pstack defaults below, send `{"pstackRole":"feature, refactoring","modelSource":"pstack-default","spawn":{...}}` to `scripts/router recommend-pstack` on stdin. Replace the sample role with the exact matching row and include the full original `spawn` input, including `model: "gpt-6-sol"`. This is a caller attestation of where Sol came from; the plugin cannot infer provenance from a task name.

| `pstackRole` | Required `spawn.agent_type` |
| --- | --- |
| `feature, refactoring` | `worker` |
| `swarm workers` | `worker` |
| `how explorer` | `researcher` or `explorer` |
| `why investigators` | `researcher` or `explorer` |

If the result is `kind: "route"`, replace only `spawn.model` with the returned model. For `kind: "preserve"` or an unavailable command, keep the original Sol input. Direct user model choices, custom role pins, expert or validator work, bug and performance roles, strongest-judgment roles, and comparison, race, or panel selections stay fixed. A panel selection remains a panel selection even when its model is Sol. The generic `recommend` command and PreToolUse hook still preserve all explicit model fields.

## Routing rules

The PreToolUse hook recognizes `spawn_agent`, `collaboration.spawn_agent`, and the observed Codex tool name `collaborationspawn_agent`. It can rewrite only plaintext calls with `fork_turns: "none"`, a nonempty `message` and `task_name`, and no `model` property. When Codex supplies an opaque encrypted message, the hook passes the call through and points the agent to `recommend`. It never sends ciphertext to TypeSafe. Both paths protect expert and validator roles and task names. Supported roles are the default, researcher, planner, worker, reviewer, and explorer. Calls with other roles, inherited history, or unsupported reasoning efforts pass through unchanged. The hook preserves all other tool input fields.

Jev receives the task message and role as data in one Choice request. It classifies mechanical or lookup work as Luna, ordinary work as Sol, and difficult bugs, ambiguous architecture, or consequential judgments as Astra. The default confidence threshold is 0.6 and is provisional. An eligible call falls back to Sol when the key is missing, Jev fails, its response is invalid, or confidence is below the threshold. The request has a 4 second deadline and no retry. Task input is limited to 16,000 characters. Hook input is limited to 128 KiB and Jev output to 64 KiB. Invalid hook input passes through unchanged.

Configuration lives at `${CODEX_HOME:-~/.codex}/jev-model-router.json`. An absolute `JEV_ROUTER_CONFIG` can override the path. The fields are `enabled` (default `true`), `pstackRouting` (default `false`), optional absolute `envFile`, and `confidenceThreshold` (default `0.6`, range 0 to 1). An exported key wins over `envFile`. A config error is reported without the key, task, or service response and leaves the call unchanged.

The SessionStart hook gives the installed plugin's absolute command path. When `pstackRouting` is enabled, it adds the scoped pstack instructions. It does not authorize extra delegation. Hook installation still requires Codex trust review in `/hooks`.

Sources: [Codex Hooks](https://learn.chatgpt.com/docs/hooks#pretooluse), [TypeSafe API reference](https://docs.typesafe.ai/api), and [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice).

For local checks, run `bun install --frozen-lockfile`, `bun test`, and `bun run typecheck` in this directory. The hook and CLI run with Bun without installed runtime packages.

## License

[MIT](LICENSE).
