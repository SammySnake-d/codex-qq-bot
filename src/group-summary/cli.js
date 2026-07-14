#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadGroupSummaryConfig, parseGroupIds } from "./config.js";
import { OneBotClient } from "./onebot-client.js";
import { createSummaryProvider } from "./providers.js";
import { acquireProcessLock } from "./process-lock.js";
import { GroupSummaryStore } from "./sqlite-store.js";
import { runGroupSummaryPass } from "./worker.js";

export async function main(argv = process.argv.slice(2), { env = process.env, projectDir = process.cwd() } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return [];
  }

  const config = loadGroupSummaryConfig({ env, projectDir });
  if (options.provider) config.provider.type = options.provider;
  if (options.send != null) config.sendEnabled = options.send;
  const groupIds = options.groupIds.length ? options.groupIds : config.groupIds;
  if (!groupIds.length) {
    throw new Error("No QQ groups configured. Set QQ_SUMMARY_GROUP_IDS or pass --group <id>.");
  }

  const releaseLock = await acquireProcessLock(config.lockPath);
  const store = new GroupSummaryStore(config.databasePath);
  try {
    const oneBot = new OneBotClient(config.oneBot);
    const provider = createSummaryProvider(config.provider, { workspaceDir: config.workspaceDir });
    const results = [];
    for (const groupId of groupIds) {
      results.push(await runGroupSummaryPass({
        groupId,
        config,
        store,
        oneBot,
        provider,
        force: options.force
      }));
    }
    process.stdout.write(`${JSON.stringify({ ok: results.every(isSuccessfulResult), results }, null, 2)}\n`);
    if (results.some((result) => !isSuccessfulResult(result))) process.exitCode = 1;
    return results;
  } finally {
    store.close();
    await releaseLock();
  }
}

export function parseArgs(argv) {
  const options = { groupIds: [], force: false, send: null, provider: "", help: false };
  const args = [...argv];
  if (args[0] === "run") args.shift();
  while (args.length) {
    const arg = args.shift();
    if (arg === "--group") options.groupIds.push(...parseGroupIds(args.shift() || ""));
    else if (arg === "--force") options.force = true;
    else if (arg === "--send") options.send = true;
    else if (arg === "--dry-run") options.send = false;
    else if (arg === "--provider") {
      const provider = String(args.shift() || "").toLowerCase();
      if (!["codex", "claude"].includes(provider)) throw new Error("--provider must be codex or claude");
      options.provider = provider;
    } else if (["--help", "-h"].includes(arg)) options.help = true;
    else throw new Error(`Unknown group summary argument: ${arg}`);
  }
  return options;
}

function isSuccessfulResult(result) {
  return !["generation_failed", "delivery_failed", "delivery_unknown"].includes(result.status);
}

function helpText() {
  return [
    "Usage: node src/group-summary/cli.js run [options]",
    "",
    "Options:",
    "  --group <id>             Run only the selected QQ group; repeatable",
    "  --force                  Bypass due/activity thresholds when messages exist",
    "  --send                   Enable OneBot delivery for this run",
    "  --dry-run                Generate and persist output without sending",
    "  --provider codex|claude  Override QQ_SUMMARY_PROVIDER",
    "  --help                   Show this help"
  ].join("\n");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code || "SUMMARY_WORKER_FAILED" }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
