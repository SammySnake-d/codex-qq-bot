import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_ACTIVE_HOURS = "08:00-23:30";

export function loadGroupSummaryConfig({ env = process.env, projectDir = process.cwd() } = {}) {
  const groupIds = parseGroupIds(env.QQ_SUMMARY_GROUP_IDS || "");
  const provider = String(env.QQ_SUMMARY_PROVIDER || "codex").trim().toLowerCase();
  const homeDir = env.HOME || homedir();
  const codexSourceHome = resolve(env.CODEX_HOME || join(homeDir, ".codex"));
  if (!["codex", "claude"].includes(provider)) {
    throw new Error(`QQ_SUMMARY_PROVIDER must be codex or claude, received ${provider || "empty"}`);
  }

  return {
    groupIds,
    databasePath: resolve(projectDir, env.QQ_SUMMARY_DB_PATH || "data/group-summary.sqlite"),
    lockPath: resolve(projectDir, env.QQ_SUMMARY_LOCK_PATH || "runtime/group-summary.lock"),
    workspaceDir: resolve(projectDir, env.QQ_SUMMARY_WORKSPACE || "workspaces/group-summary"),
    sendEnabled: parseBoolean(env.QQ_SUMMARY_SEND_ENABLED, false),
    selfId: parseOptionalQqId(env.QQ_SUMMARY_SELF_ID),
    oneBot: {
      baseUrl: String(env.ONEBOT_API_BASE || "http://127.0.0.1:3000").replace(/\/+$/, ""),
      accessToken: String(env.ONEBOT_ACCESS_TOKEN || env.CODEX_REMOTE_CONTACT_ONEBOT_TOKEN || "").trim(),
      timeoutMs: parseInteger(env.QQ_SUMMARY_ONEBOT_TIMEOUT_MS, 10_000, { min: 1_000, max: 60_000 }),
      historyBatchSize: parseInteger(env.QQ_SUMMARY_HISTORY_BATCH_SIZE, 200, { min: 1, max: 200 }),
      maxHistoryPages: parseInteger(env.QQ_SUMMARY_MAX_HISTORY_PAGES, 10, { min: 1, max: 100 })
    },
    provider: {
      type: provider,
      timeoutMs: parseInteger(env.QQ_SUMMARY_PROVIDER_TIMEOUT_MS, 180_000, { min: 10_000, max: 900_000 }),
      model: String(env.QQ_SUMMARY_MODEL || "").trim(),
      reasoningEffort: String(env.QQ_SUMMARY_REASONING_EFFORT || "low").trim(),
      codexPath: String(env.CODEX_CLI_PATH || "codex").trim(),
      codexIgnoreUserConfig: parseBoolean(env.QQ_SUMMARY_CODEX_IGNORE_USER_CONFIG, false),
      codexSourceHome,
      codexConfigPath: resolve(env.CODEX_CONFIG_PATH || join(codexSourceHome, "config.toml")),
      codexAuthPath: resolve(env.QQ_SUMMARY_CODEX_AUTH_PATH || join(codexSourceHome, "auth.json")),
      codexRuntimeHome: resolve(projectDir, env.QQ_SUMMARY_CODEX_HOME || "runtime/group-summary-codex-home"),
      claudePath: String(env.CLAUDE_CLI_PATH || "claude").trim(),
      claudeBare: parseBoolean(env.QQ_SUMMARY_CLAUDE_BARE, false),
      maxBudgetUsd: parseOptionalNumber(env.QQ_SUMMARY_MAX_BUDGET_USD, { min: 0.01, max: 100 })
    },
    policy: {
      minMessages: parseInteger(env.QQ_SUMMARY_MIN_MESSAGES, 50, { min: 1, max: 10_000 }),
      minSpeakers: parseInteger(env.QQ_SUMMARY_MIN_SPEAKERS, 3, { min: 1, max: 1_000 }),
      quietMinutes: parseInteger(env.QQ_SUMMARY_QUIET_MINUTES, 20, { min: 0, max: 1_440 }),
      minIntervalMinutes: parseInteger(env.QQ_SUMMARY_MIN_INTERVAL_MINUTES, 120, { min: 1, max: 10_080 }),
      dueMinMinutes: parseInteger(env.QQ_SUMMARY_DUE_MIN_MINUTES, 120, { min: 1, max: 10_080 }),
      dueMaxMinutes: parseInteger(env.QQ_SUMMARY_DUE_MAX_MINUTES, 360, { min: 1, max: 10_080 }),
      lowActivityMinMinutes: parseInteger(env.QQ_SUMMARY_LOW_ACTIVITY_MIN_MINUTES, 30, { min: 1, max: 1_440 }),
      lowActivityMaxMinutes: parseInteger(env.QQ_SUMMARY_LOW_ACTIVITY_MAX_MINUTES, 90, { min: 1, max: 1_440 }),
      activeChatMinMinutes: parseInteger(env.QQ_SUMMARY_ACTIVE_CHAT_MIN_MINUTES, 15, { min: 1, max: 1_440 }),
      activeChatMaxMinutes: parseInteger(env.QQ_SUMMARY_ACTIVE_CHAT_MAX_MINUTES, 30, { min: 1, max: 1_440 }),
      maxMessagesPerRun: parseInteger(env.QQ_SUMMARY_MAX_MESSAGES_PER_RUN, 1_000, { min: 1, max: 10_000 }),
      maxRenderedChars: parseInteger(env.QQ_SUMMARY_MAX_RENDERED_CHARS, 900, { min: 200, max: 4_000 }),
      activeHours: parseActiveHours(env.QQ_SUMMARY_ACTIVE_HOURS || DEFAULT_ACTIVE_HOURS)
    }
  };
}

export function parseGroupIds(value) {
  const ids = [...new Set(String(value || "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
  for (const id of ids) {
    if (!/^\d{4,20}$/.test(id)) throw new Error(`Invalid QQ group id: ${id}`);
  }
  return ids;
}

export function parseActiveHours(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`QQ_SUMMARY_ACTIVE_HOURS must use HH:MM-HH:MM, received ${value}`);
  const values = match.slice(1).map(Number);
  const [startHour, startMinute, endHour, endMinute] = values;
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
    throw new Error(`QQ_SUMMARY_ACTIVE_HOURS contains an invalid time: ${value}`);
  }
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  if (start === end) throw new Error("QQ_SUMMARY_ACTIVE_HOURS cannot span zero minutes");
  return { startMinute: start, endMinute: end, source: value };
}

function parseOptionalQqId(value) {
  const id = String(value || "").trim();
  if (!id) return "";
  if (!/^\d{4,20}$/.test(id)) throw new Error(`Invalid QQ_SUMMARY_SELF_ID: ${id}`);
  return id;
}

function parseBoolean(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parseInteger(value, fallback, { min, max }) {
  const number = value == null || String(value).trim() === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Expected integer between ${min} and ${max}, received ${value}`);
  }
  return number;
}

function parseOptionalNumber(value, { min, max }) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`Expected number between ${min} and ${max}, received ${value}`);
  }
  return number;
}
