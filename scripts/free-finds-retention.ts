import { readdir, rename, stat, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";

export const FREE_FINDS_REPORT_RETENTION_COUNT = 48;
export const FREE_FINDS_SCHEDULER_LOG_MAX_BYTES = 512 * 1024;
export const FREE_FINDS_SCHEDULER_LOG_BACKUP_FILENAME = "free-finds-scheduler.log.1";

const reportName = /^free-finds-report-.*\.json$/;

/** Remove only the oldest readable Free Finds reports; malformed reports remain for diagnosis. */
export async function pruneFreeFindsReports(root: string, keepCount = FREE_FINDS_REPORT_RETENTION_COUNT): Promise<string[]> {
  let names: string[];
  try { names = (await readdir(root)).filter((name) => reportName.test(name)); } catch { return []; }
  const readable: Array<{ name: string; runAt: number }> = [];
  for (const name of names) {
    try {
      const value = JSON.parse(await readFile(join(root, name), "utf8")) as { runAt?: unknown };
      const runAt = typeof value.runAt === "string" ? Date.parse(value.runAt) : NaN;
      if (Number.isFinite(runAt)) readable.push({ name, runAt });
    } catch { /* retain malformed files as diagnostics */ }
  }
  readable.sort((a, b) => b.runAt - a.runAt || b.name.localeCompare(a.name));
  const removed: string[] = [];
  for (const report of readable.slice(Math.max(0, keepCount))) {
    try { await unlink(join(root, report.name)); removed.push(report.name); } catch { /* concurrent cleanup or a missing file is harmless */ }
  }
  return removed;
}

export async function rotateFreeFindsSchedulerLog(root: string, maxBytes = FREE_FINDS_SCHEDULER_LOG_MAX_BYTES): Promise<boolean> {
  const logPath = join(root, "free-finds-scheduler.log");
  try {
    if ((await stat(logPath)).size < maxBytes) return false;
    await rename(logPath, join(root, FREE_FINDS_SCHEDULER_LOG_BACKUP_FILENAME));
    return true;
  } catch { return false; }
}
