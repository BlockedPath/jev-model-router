import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { credential, readConfig } from "../src/config";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("defaults without config and parses only an explicitly named key file", async () => {
  const temporary = await mkdtemp(join(import.meta.dir, "tmp-"));
  directories.push(temporary);
  const envFile = join(temporary, "key.env");
  await writeFile(envFile, "OTHER_SECRET=ignored\nexport TYPESAFE_API_KEY='synthetic-key'\n");
  expect(await readConfig({ CODEX_HOME: temporary })).toEqual({ enabled: true, pstackRouting: false, confidenceThreshold: 0.6 });
  await writeFile(join(temporary, "jev-model-router.json"), JSON.stringify({ envFile, confidenceThreshold: 0.72 }));
  const config = await readConfig({ CODEX_HOME: temporary });
  expect(config).toEqual({ enabled: true, pstackRouting: false, confidenceThreshold: 0.72, envFile });
  expect(await credential(config, {})).toEqual({ source: "envFile", key: "synthetic-key" });
  expect(await credential(config, { TYPESAFE_API_KEY: "exported-key" })).toEqual({ source: "environment", key: "exported-key" });
});

test("rejects invalid config and never interprets shell expressions in key files", async () => {
  const temporary = await mkdtemp(join(import.meta.dir, "tmp-"));
  directories.push(temporary);
  await writeFile(join(temporary, "jev-model-router.json"), JSON.stringify({ envFile: "relative.env" }));
  expect(readConfig({ CODEX_HOME: temporary })).rejects.toThrow("absolute path");
  const envFile = join(temporary, "key.env");
  await writeFile(envFile, "TYPESAFE_API_KEY=$(not-a-command)\n");
  expect(credential({ enabled: true, pstackRouting: false, confidenceThreshold: 0.6, envFile }, {})).rejects.toThrow("invalid");
  await writeFile(join(temporary, "jev-model-router.json"), JSON.stringify({ pstackRouting: "true" }));
  expect(readConfig({ CODEX_HOME: temporary })).rejects.toThrow("pstackRouting must be boolean");
});
