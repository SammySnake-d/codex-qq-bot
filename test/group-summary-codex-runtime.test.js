import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMinimalCodexConfig, prepareIsolatedCodexHome } from "../src/group-summary/codex-runtime.js";

const sourceConfig = `
model_provider = "custom"
model = "gpt-source"
model_reasoning_effort = "xhigh"

[model_providers.custom]
name = "custom"
requires_openai_auth = true
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"

[mcp_servers.secret]
command = "secret-command"

[hooks]
enabled = true
`;

test("derives a minimal provider config without MCP, hooks, or unrelated user settings", () => {
  const output = buildMinimalCodexConfig(sourceConfig, { model: "gpt-summary", reasoningEffort: "low" });
  assert.match(output, /model_provider = "custom"/);
  assert.match(output, /model = "gpt-summary"/);
  assert.match(output, /model_reasoning_effort = "low"/);
  assert.match(output, /\[model_providers\.custom\]/);
  assert.match(output, /base_url = "http:\/\/127\.0\.0\.1:8317\/v1"/);
  assert.doesNotMatch(output, /mcp_servers|secret-command|\[hooks\]/);
  assert.match(output, /supports_websockets = false/);
  assert.match(output, /\[skills\]/);
  assert.match(output, /bundled\.enabled = false/);
  assert.match(output, /include_instructions = false/);
});

test("removes a stale isolated auth file when the active auth file is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "group-summary-codex-auth-"));
  const sourceHome = join(directory, "source");
  const targetHome = join(directory, "target");
  await mkdir(sourceHome, { recursive: true });
  await mkdir(targetHome, { recursive: true });
  await writeFile(join(sourceHome, "config.toml"), sourceConfig);
  await writeFile(join(targetHome, "auth.json"), JSON.stringify({ stale: true }));
  try {
    const runtime = await prepareIsolatedCodexHome({
      codexConfigPath: join(sourceHome, "config.toml"),
      codexAuthPath: join(sourceHome, "auth.json"),
      codexRuntimeHome: targetHome,
      model: "",
      reasoningEffort: "low"
    });
    assert.equal(runtime.authPath, "");
    await assert.rejects(access(join(targetHome, "auth.json")), (error) => error.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes an isolated CODEX_HOME and copies auth without committing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "group-summary-codex-home-"));
  const sourceHome = join(directory, "source");
  const targetHome = join(directory, "target");
  await mkdir(sourceHome, { recursive: true });
  await writeFile(join(sourceHome, "config.toml"), sourceConfig);
  await writeFile(join(sourceHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key" }), { mode: 0o600 });
  try {
    const runtime = await prepareIsolatedCodexHome({
      codexConfigPath: join(sourceHome, "config.toml"),
      codexAuthPath: join(sourceHome, "auth.json"),
      codexRuntimeHome: targetHome,
      model: "",
      reasoningEffort: "low"
    });
    assert.equal(runtime.homeDir, targetHome);
    assert.equal(runtime.provider, "custom");
    assert.deepEqual(JSON.parse(await readFile(runtime.authPath, "utf8")), { OPENAI_API_KEY: "test-key" });
    assert.doesNotMatch(await readFile(runtime.configPath, "utf8"), /mcp_servers/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when a selected provider section is missing", () => {
  assert.throws(
    () => buildMinimalCodexConfig('model_provider = "missing"\n', {}),
    (error) => error.code === "CODEX_PROVIDER_CONFIG_MISSING"
  );
});
