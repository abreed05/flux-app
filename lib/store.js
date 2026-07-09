import { mkdir, writeFile, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Disk layout (OUTPUT_DIR is a shared volume between api and worker):
//   runs/<runId>/run.json       api-owned: model, params, n, createdAt, cost
//   runs/<runId>/inputs/<k>.img api-owned: uploaded reference images (raw bytes)
//   runs/<runId>/job-<i>.json   worker-owned: per-image status/seed/error
//   runs/<runId>/image-<i>.<ext> worker-owned: generated image
export const OUTPUT_DIR = process.env.OUTPUT_DIR || join(process.cwd(), "outputs");
const RUNS_DIR = join(OUTPUT_DIR, "runs");

// Public URL prefix under which the api serves OUTPUT_DIR.
export const OUTPUTS_URL = "/outputs";

// JSON files are read by the other service, so write via tmp+rename to
// avoid a reader seeing a partial file.
async function writeJsonAtomic(path, obj) {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, path);
}

export function runDir(runId) {
  if (!/^[a-z0-9-]+$/i.test(runId)) throw new Error(`Bad runId: ${runId}`);
  return join(RUNS_DIR, runId);
}

// inputImages: array of Buffers. Returns { runId, inputPaths } where
// inputPaths are relative to OUTPUT_DIR (what goes into the job message).
export async function createRun(record, inputImages = []) {
  const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const dir = runDir(runId);
  await mkdir(join(dir, "inputs"), { recursive: true });

  const inputPaths = [];
  for (let k = 0; k < inputImages.length; k++) {
    const rel = join("runs", runId, "inputs", `${k + 1}.img`);
    await writeFile(join(OUTPUT_DIR, rel), inputImages[k]);
    inputPaths.push(rel);
  }
  await writeJsonAtomic(join(dir, "run.json"), { id: runId, createdAt: new Date().toISOString(), ...record });
  return { runId, inputPaths };
}

export async function writeJobResult(runId, jobIndex, jobRecord, imageBuffer, ext) {
  const dir = runDir(runId);
  await mkdir(dir, { recursive: true }); // tolerate a worker beating a slow volume
  if (imageBuffer) {
    jobRecord.file = `image-${jobIndex}.${ext}`;
    await writeFile(join(dir, jobRecord.file), imageBuffer);
  }
  await writeJsonAtomic(join(dir, `job-${jobIndex}.json`), jobRecord);
  return jobRecord;
}

export async function readRun(runId) {
  const dir = runDir(runId);
  const run = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
  const jobs = [];
  for (let i = 0; i < (run.n || 1); i++) {
    try {
      const job = JSON.parse(await readFile(join(dir, `job-${i}.json`), "utf8"));
      if (job.file) job.image = `${OUTPUTS_URL}/runs/${runId}/${job.file}`;
      jobs.push(job);
    } catch {
      jobs.push({ index: i, status: "pending" });
    }
  }
  return { ...run, jobs };
}

// Removes the run's whole directory (run.json, inputs, images, job files).
// A worker finishing a job afterwards may recreate a partial dir, but
// listRuns skips dirs without a run.json, so it stays invisible.
export async function deleteRun(runId) {
  await rm(runDir(runId), { recursive: true, force: true });
}

export async function listRuns(limit = 50) {
  let ids;
  try {
    ids = await readdir(RUNS_DIR);
  } catch {
    return []; // no runs yet
  }
  const runs = [];
  for (const id of ids) {
    try { runs.push(await readRun(id)); }
    catch { /* half-written or foreign dir — skip */ }
  }
  runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return runs.slice(0, limit);
}
