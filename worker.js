import { readFile } from "node:fs/promises";
import { SpanKind } from "@opentelemetry/api";
import { join } from "node:path";

import { INPUT_IMAGE_KEYS, generateWithRetry } from "./lib/bfl.js";
import * as anifusion from "./lib/anifusion.js";
import { MODELS } from "./lib/models.js";
import { connectQueue, consumeJobs, publishEvent } from "./lib/queue.js";
import { OUTPUT_DIR, withImageUrls, writeJobResult } from "./lib/store.js";
import { startTracing, withSpan, extractContext } from "./lib/tracing.js";

startTracing("flux-app-worker");

// Public origin of the api (e.g. https://flux.example.com) so traces can link
// to the finished image; without it the link is the site-relative path.
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const CONCURRENCY = Math.max(1, parseInt(process.env.WORKER_CONCURRENCY, 10) || 2);

const extOf = (contentType) =>
  contentType.includes("jpeg") ? "jpeg" : contentType.includes("webp") ? "webp" : "png";

// Write one finished image and return its job record (with a public URL).
async function saveImage(runId, jobIndex, fields, buffer, contentType) {
  const record = await writeJobResult(runId, jobIndex, {
    index: jobIndex,
    status: "done",
    ...fields,
    finishedAt: new Date().toISOString(),
  }, buffer, extOf(contentType));
  return withImageUrls(runId, record);
}

// Anifusion jobs arrive with a ready request body (the api uploaded the
// images). A character sheet is one job that fills `count` image slots.
async function processAnifusionJob(job, model) {
  const { runId, jobIndex, payload } = job;
  const result = await anifusion.generateWithRetry(model, payload);
  const cost = typeof result.cost === "number" ? { costCredits: result.cost } : {};
  if (!result.images) {
    return [await saveImage(runId, jobIndex, { seed: result.seed, anifusionId: result.id, ...cost },
      result.buffer, result.contentType)];
  }
  // The sheet is billed once; put the whole cost on the first view.
  const records = [];
  for (let i = 0; i < job.count; i++) {
    const img = result.images[i];
    records.push(img
      ? await saveImage(runId, i, { anifusionId: result.id, ...(i === 0 ? cost : { costCredits: 0 }) },
        img.buffer, img.contentType)
      : await writeJobResult(runId, i, {
        index: i, status: "failed", error: "Anifusion returned fewer views than expected.",
        finishedAt: new Date().toISOString(),
      }));
  }
  return records;
}

async function processJob(job) {
  const { runId, jobIndex, modelId, payload, inputPaths = [] } = job;
  const model = MODELS[modelId];
  if (!model) throw new Error(`Unknown model in job: ${modelId}`);
  if (model.provider === "anifusion") return processAnifusionJob(job, model);

  // Reference images live on the shared volume; inline them for the API call.
  // FLUX 3 takes them as one `images` array, FLUX.2 as input_image, input_image_2, …
  const images = await Promise.all(inputPaths.map(async (rel) =>
    (await readFile(join(OUTPUT_DIR, rel))).toString("base64")));
  if (model.imagesField) {
    if (images.length) payload[model.imagesField] = images;
  } else {
    images.forEach((b64, k) => { payload[INPUT_IMAGE_KEYS[k]] = b64; });
  }

  const { buffer, contentType, seed, id, cost, expandedPrompt } = await generateWithRetry(model, payload);
  return [await saveImage(runId, jobIndex, {
    seed: seed ?? payload.seed,
    bflId: id,
    ...(typeof cost === "number" ? { costCredits: cost } : {}),
    ...(expandedPrompt ? { expandedPrompt } : {}),
  }, buffer, contentType)];
}

async function handleJob(job, msg, channel) {
  const { runId } = job;
  // Usually one image per job; a character sheet job covers job.count slots.
  const indices = job.count ? Array.from({ length: job.count }, (_, i) => i) : [job.jobIndex];
  const label = `${runId}/${indices.join(",")}`;
  for (const jobIndex of indices) publishEvent(queue, { type: "job.started", runId, jobIndex });
  console.log(`▶ job ${label} started`);
  try {
    const records = await withSpan("flux.job", {
      "openinference.span.kind": "CHAIN",
      "flux.run_id": runId,
      "flux.job_index": job.jobIndex,
      "flux.model": job.modelId,
      "input.value": job.payload?.prompt || job.payload?.description || "",
    }, async (span) => {
      const recs = await processJob(job);
      span.setAttribute("output.value", recs.filter((r) => r.image).map((r) => PUBLIC_URL + r.image).join("\n"));
      return recs;
    }, { kind: SpanKind.CONSUMER, parent: extractContext(msg.properties.headers) });
    for (const record of records) {
      publishEvent(queue, { type: record.status === "done" ? "job.done" : "job.failed", runId, jobIndex: record.index, job: record });
    }
    console.log(`✔ job ${label} done${records[0]?.seed != null ? ` (seed ${records[0].seed})` : ""}`);
  } catch (e) {
    // The clients already retried transient failures, so any error here
    // is settled — record it and ack rather than requeueing a poison message.
    const error = String(e.message || e);
    console.error(`✖ job ${label} failed: ${error}`);
    for (const jobIndex of indices) {
      try {
        const record = await writeJobResult(runId, jobIndex, {
          index: jobIndex,
          status: "failed",
          error,
          finishedAt: new Date().toISOString(),
        });
        publishEvent(queue, { type: "job.failed", runId, jobIndex, job: record });
      } catch (writeErr) {
        console.error(`  could not persist failure record: ${writeErr.message}`);
      }
    }
  }
  // Ack on the channel the message arrived on. If a reconnect replaced it the
  // broker has already requeued this job, so the throw is expected — not fatal.
  try { channel.ack(msg); }
  catch { console.warn(`  ack for ${label} dropped (channel replaced); job will be redelivered`); }
}

// Re-subscribed on every reconnect; consumers do not survive a closed channel.
const queue = await connectQueue({ setup: (ch) => consumeJobs(ch, CONCURRENCY, handleJob) });

console.log(`Worker consuming (concurrency ${CONCURRENCY})`);
