import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireProcessLock } from "../src/group-summary/process-lock.js";

test("prevents overlapping cron workers and releases the owned lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "group-summary-lock-"));
  const lockPath = join(directory, "worker.lock");
  try {
    const release = await acquireProcessLock(lockPath);
    await assert.rejects(acquireProcessLock(lockPath), (error) => error.code === "SUMMARY_LOCKED");
    await release();
    const releaseAgain = await acquireProcessLock(lockPath);
    await releaseAgain();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not steal an old lock while its owner process is still alive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "group-summary-live-lock-"));
  const lockPath = join(directory, "worker.lock");
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "live" }));
    await assert.rejects(
      acquireProcessLock(lockPath, { staleMs: 0, now: () => Date.now() + 60_000 }),
      (error) => error.code === "SUMMARY_LOCKED"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replaces an old lock whose owner process is gone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "group-summary-stale-lock-"));
  const lockPath = join(directory, "worker.lock");
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "stale" }));
    const release = await acquireProcessLock(lockPath, { staleMs: 0, now: () => Date.now() + 60_000 });
    await release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
