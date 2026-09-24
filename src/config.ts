import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

export type RouterConfig = { enabled: boolean; pstackRouting: boolean; envFile?: string; confidenceThreshold: number };
export type Credential = { key?: string; source: "environment" | "envFile" | "none" };
export class ConfigError extends Error {}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JEV_ROUTER_CONFIG !== undefined) {
    if (!isAbsolute(env.JEV_ROUTER_CONFIG)) throw new ConfigError("JEV_ROUTER_CONFIG must be absolute");
    return env.JEV_ROUTER_CONFIG;
  }
  const codexHome = env.CODEX_HOME ?? join(homedir(), ".codex");
  if (!isAbsolute(codexHome)) throw new ConfigError("CODEX_HOME must be absolute");
  return join(codexHome, "jev-model-router.json");
}

export async function readConfig(env: NodeJS.ProcessEnv = process.env): Promise<RouterConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath(env), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { enabled: true, pstackRouting: false, confidenceThreshold: 0.6 };
    }
    throw new ConfigError("Cannot read router config");
  }
  if (raw.length > 16_384) throw new ConfigError("Router config is too large");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ConfigError("Router config is not valid JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError("Router config must be an object");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !["enabled", "pstackRouting", "envFile", "confidenceThreshold"].includes(key))) {
    throw new ConfigError("Router config has an unknown field");
  }
  const enabled = object.enabled ?? true;
  const pstackRouting = object.pstackRouting ?? false;
  const threshold = object.confidenceThreshold ?? 0.6;
  if (typeof enabled !== "boolean") throw new ConfigError("enabled must be boolean");
  if (typeof pstackRouting !== "boolean") throw new ConfigError("pstackRouting must be boolean");
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new ConfigError("confidenceThreshold must be between 0 and 1");
  }
  if (object.envFile !== undefined && (typeof object.envFile !== "string" || !isAbsolute(object.envFile))) {
    throw new ConfigError("envFile must be an absolute path");
  }
  return { enabled, pstackRouting, confidenceThreshold: threshold, ...(typeof object.envFile === "string" ? { envFile: object.envFile } : {}) };
}

export async function credential(config: RouterConfig, env: NodeJS.ProcessEnv = process.env): Promise<Credential> {
  if (env.TYPESAFE_API_KEY?.trim()) return { key: env.TYPESAFE_API_KEY.trim(), source: "environment" };
  if (!config.envFile) return { source: "none" };
  let raw: string;
  try { raw = await readFile(config.envFile, "utf8"); }
  catch { throw new ConfigError("Cannot read configured envFile"); }
  if (raw.length > 65_536) throw new ConfigError("Configured envFile is too large");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let key = match[1] ?? "";
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1);
    }
    if (key && !/[\s$`]/.test(key)) return { key, source: "envFile" };
    throw new ConfigError("Configured TYPESAFE_API_KEY is invalid");
  }
  return { source: "none" };
}

export async function writeConfig(config: RouterConfig, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = configPath(env);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}
