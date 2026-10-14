import { readFile } from "node:fs/promises";
import { SpanKind } from "@opentelemetry/api";
import { join } from "node:path";

import { MODELS, INPUT_IMAGE_KEYS, generateWithRetry } from "./lib/bfl.js";
import { connectQueue, consumeJobs, publishEvent } from "./lib/queue.js";
import { OUTPUT_DIR, OUTPUTS_URL, writeJobResult } from "./lib/store.js";
import { startTracing, withSpan, extractContext } from "./lib/tracing.js";

startTracing("flux-app-worker");

// Public origin of the api (e.g. https://flux.example.com) so traces can link
// to the finished image; without it the link is the site-relative path.
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const CONCURRENCY = Math.max(1, parseInt(process.env.WORKER_CONCURRENCY, 10) || 2);

const { channel } = await connectQueue();

async function processJob(job) {
  const { runId, jobIndex, modelId, payload, inputPaths = [] } = job;
  const model = MODELS[modelId];
  if (!model) throw new Error(`Unknown model in job: ${modelId}`);

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
  const ext = contentType.includes("jpeg") ? "jpeg" : contentType.includes("webp") ? "webp" : "png";
  const record = await writeJobResult(runId, jobIndex, {
    index: jobIndex,
    status: "done",
    seed: seed ?? payload.seed,
    bflId: id,
    ...(typeof cost === "number" ? { costCredits: cost } : {}),
    ...(expandedPrompt ? { expandedPrompt } : {}),
    finishedAt: new Date().toISOString(),
  }, buffer, ext);
  record.image = `${OUTPUTS_URL}/runs/${runId}/${record.file}`;
  return record;
}

await consumeJobs(channel, CONCURRENCY, async (job, msg) => {
  const { runId, jobIndex } = job;
  publishEvent(channel, { type: "job.started", runId, jobIndex });
  console.log(`▶ job ${runId}/${jobIndex} started`);
  try {
    const record = await withSpan("flux.job", {
      "openinference.span.kind": "CHAIN",
      "flux.run_id": runId,
      "flux.job_index": jobIndex,
      "flux.model": job.modelId,
      "input.value": job.payload?.prompt || "",
    }, async (span) => {
      const rec = await processJob(job);
      span.setAttribute("output.value", PUBLIC_URL + rec.image);
      return rec;
    }, { kind: SpanKind.CONSUMER, parent: extractContext(msg.properties.headers) });
    publishEvent(channel, { type: "job.done", runId, jobIndex, job: record });
    console.log(`✔ job ${runId}/${jobIndex} done (seed ${record.seed})`);
  } catch (e) {
    // generateWithRetry already retried transient failures, so any error here
    // is settled — record it and ack rather than requeueing a poison message.
    const error = String(e.message || e);
    console.error(`✖ job ${runId}/${jobIndex} failed: ${error}`);
    try {
      const record = await writeJobResult(runId, jobIndex, {
        index: jobIndex,
        status: "failed",
        error,
        finishedAt: new Date().toISOString(),
      });
      publishEvent(channel, { type: "job.failed", runId, jobIndex, job: record });
    } catch (writeErr) {
      console.error(`  could not persist failure record: ${writeErr.message}`);
    }
  }
  channel.ack(msg);
});

console.log(`FLUX worker consuming (concurrency ${CONCURRENCY})`);
