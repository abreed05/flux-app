import { mkdir, writeFile, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

// Disk layout (OUTPUT_DIR is a shared volume between api and worker):
//   runs/<runId>/run.json       api-owned: model, params, n, createdAt, cost
//   runs/<runId>/inputs/<k>.img api-owned: uploaded reference images (raw bytes)
//   runs/<runId>/job-<i>.json   worker-owned: per-image status/seed/error
//   runs/<runId>/image-<i>.<ext> worker-owned: generated image
//   runs/<runId>/thumb-<i>.webp  gallery thumbnail (worker, or api backfill)
export const OUTPUT_DIR = process.env.OUTPUT_DIR || join(process.cwd(), "outputs");
const RUNS_DIR = join(OUTPUT_DIR, "runs");

// Public URL prefix under which the api serves OUTPUT_DIR.
export const OUTPUTS_URL = "/outputs";

const THUMB_WIDTH = 320;
const thumbFile = (jobIndex) => `thumb-${jobIndex}.webp`;

// JSON files are read by the other service, so write via tmp+rename to
// avoid a reader seeing a partial file.
async function writeJsonAtomic(path, obj) {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, path);
}

async function writeThumb(dir, jobIndex, imageBuffer) {
  const thumb = await sharp(imageBuffer)
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
  const path = join(dir, thumbFile(jobIndex));
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, thumb);
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
    // Non-fatal: the api regenerates a missing thumbnail on first request.
    await writeThumb(dir, jobIndex, imageBuffer)
      .catch((e) => console.warn(`thumbnail for ${runId}/${jobIndex} failed: ${e.message}`));
  }
  await writeJsonAtomic(join(dir, `job-${jobIndex}.json`), jobRecord);
  return jobRecord;
}

export function withImageUrls(runId, job) {
  if (!job.file) return job;
  const base = `${OUTPUTS_URL}/runs/${runId}`;
  return { ...job, image: `${base}/${job.file}`, thumb: `${base}/${thumbFile(job.index)}` };
}

async function readJob(dir, runId, i) {
  try {
    return withImageUrls(runId, JSON.parse(await readFile(join(dir, `job-${i}.json`), "utf8")));
  } catch {
    return { index: i, status: "pending" };
  }
}

export async function readRun(runId) {
  const dir = runDir(runId);
  const run = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
  const jobs = await Promise.all(Array.from({ length: run.n || 1 }, (_, i) => readJob(dir, runId, i)));
  return { ...run, jobs };
}

// Backfills thumbnails for images generated before thumbnails existed (or
// whose worker-side resize failed). Concurrent requests share one resize.
const thumbsInFlight = new Map();

export function ensureThumb(runId, jobIndex) {
  const key = `${runId}/${jobIndex}`;
  if (!thumbsInFlight.has(key)) {
    const p = (async () => {
      const dir = runDir(runId);
      const job = JSON.parse(await readFile(join(dir, `job-${jobIndex}.json`), "utf8"));
      if (!job.file) throw new Error("job has no image");
      await writeThumb(dir, jobIndex, await readFile(join(dir, job.file)));
    })().finally(() => thumbsInFlight.delete(key));
    thumbsInFlight.set(key, p);
  }
  return thumbsInFlight.get(key);
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
  // runIds start with a fixed-width base36 timestamp, so name order is
  // creation order: read only the newest dirs instead of every run on disk.
  ids.sort().reverse();
  const runs = [];
  let next = 0;
  while (next < ids.length && runs.length < limit) {
    const batch = ids.slice(next, next + limit - runs.length);
    next += batch.length;
    const results = await Promise.allSettled(batch.map(readRun));
    // half-written or foreign dirs are rejected and skipped
    for (const r of results) if (r.status === "fulfilled") runs.push(r.value);
  }
  return runs;
}
