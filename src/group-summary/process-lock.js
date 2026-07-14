import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export async function acquireProcessLock(lockPath, { staleMs = 15 * 60_000, now = () => Date.now() } = {}) {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: now() })}\n`, "utf8");
      await handle.close();
      return async () => {
        const current = await readFile(lockPath, "utf8").then(JSON.parse).catch(() => null);
        if (current?.token === token) await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      const owner = await readFile(lockPath, "utf8").then(JSON.parse).catch(() => null);
      const ownerIsAlive = isProcessAlive(owner?.pid);
      if (!info || ownerIsAlive || now() - info.mtimeMs <= staleMs || attempt > 0) {
        const lockError = new Error(`Group summary worker is already running: ${lockPath}`);
        lockError.code = "SUMMARY_LOCKED";
        throw lockError;
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error(`Unable to acquire group summary lock: ${lockPath}`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
