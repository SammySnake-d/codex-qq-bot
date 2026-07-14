import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeTextAtomically } from "../file-store.js";

export async function prepareIsolatedCodexHome(config) {
  const source = await readFile(config.codexConfigPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const targetHome = config.codexRuntimeHome;
  const targetConfigPath = join(targetHome, "config.toml");
  const targetAuthPath = join(targetHome, "auth.json");
  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  await writeTextAtomically(targetConfigPath, buildMinimalCodexConfig(source, config), { mode: 0o600 });

  const authCopied = await copyFile(config.codexAuthPath, targetAuthPath)
    .then(async () => {
      await chmod(targetAuthPath, 0o600);
      return true;
    })
    .catch((error) => {
      if (error.code === "ENOENT") {
        return rm(targetAuthPath, { force: true }).then(() => false);
      }
      throw error;
    });

  return {
    homeDir: targetHome,
    configPath: targetConfigPath,
    authPath: authCopied ? targetAuthPath : "",
    provider: readTopLevelString(source, "model_provider") || "default"
  };
}

export function buildMinimalCodexConfig(source, config = {}) {
  const provider = readTopLevelString(source, "model_provider");
  const model = String(config.model || readTopLevelString(source, "model") || "").trim();
  const reasoningEffort = String(config.reasoningEffort || readTopLevelString(source, "model_reasoning_effort") || "low").trim();
  const lines = [];

  if (provider) lines.push(`model_provider = ${JSON.stringify(provider)}`);
  if (model) lines.push(`model = ${JSON.stringify(model)}`);
  if (reasoningEffort) lines.push(`model_reasoning_effort = ${JSON.stringify(reasoningEffort)}`);
  lines.push("disable_response_storage = true");
  lines.push("supports_websockets = false");
  lines.push('sandbox_mode = "read-only"');
  lines.push('approval_policy = "never"');
  lines.push("", "[skills]", "bundled.enabled = false", "include_instructions = false");

  if (provider) {
    const section = readTomlSection(source, `model_providers.${provider}`);
    if (!section) {
      const error = new Error(`Codex provider ${provider} is selected but [model_providers.${provider}] is missing`);
      error.code = "CODEX_PROVIDER_CONFIG_MISSING";
      throw error;
    }
    lines.push("", section.trim());
  }
  return `${lines.join("\n")}\n`;
}

function readTopLevelString(source, key) {
  for (const rawLine of String(source || "").split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[")) break;
    const match = line.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(["'])(.*?)\\1\\s*$`));
    if (match) return match[2];
  }
  return "";
}

function readTomlSection(source, sectionName) {
  const lines = String(source || "").split(/\r?\n/);
  let collecting = false;
  const output = [];
  for (const rawLine of lines) {
    const header = rawLine.trim().match(/^\[([^\]]+)\]$/)?.[1] || "";
    if (header) {
      if (collecting) break;
      if (normalizeSectionName(header) === sectionName) collecting = true;
    }
    if (collecting) output.push(rawLine);
  }
  return output.join("\n").trim();
}

function normalizeSectionName(value) {
  return String(value || "").split(".").map((part) => part.trim().replace(/^["']|["']$/g, "")).join(".");
}

function stripTomlComment(line) {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== "\\") {
      quote = quote === character ? "" : quote || character;
    } else if (character === "#" && !quote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
