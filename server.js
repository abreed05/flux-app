import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname, sep } from "node:path";
import { SpanKind, trace } from "@opentelemetry/api";

import { MAX_INPUT_IMAGES, PermanentError, estimateCost } from "./lib/bfl.js";
import * as anifusion from "./lib/anifusion.js";
import { MODELS, PROVIDERS, providerOf } from "./lib/models.js";
import { connectQueue, publishJob, consumeEvents } from "./lib/queue.js";
import { OUTPUT_DIR, OUTPUTS_URL, createRun, readRun, listRuns, deleteRun, ensureThumb } from "./lib/store.js";
import { startTracing, withSpan } from "./lib/tracing.js";

startTracing("flux-app-api");

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req, limitBytes = 167_772_160) { // ~160MB: up to 10 base64 input images
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---- static file serving ------------------------------------------------
const PUBLIC_DIR = join(__dirname, "public");

// Generated images never change once written (each lives under a unique
// runId), so they are cached forever. UI files revalidate via ETag.
const IMMUTABLE = "public, max-age=31536000, immutable";
const THUMB_PATH = /^\/runs\/([a-z0-9-]+)\/thumb-(\d+)\.webp$/i;

// Serve urlPath from rootDir with a path-traversal guard. Used for both the
// UI (public/) and generated images (OUTPUT_DIR, mounted at /outputs).
async function serveFrom(rootDir, urlPath, req, res, cacheControl) {
  const filePath = normalize(join(rootDir, urlPath));
  if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  let st;
  try {
    st = await stat(filePath);
    if (!st.isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404); res.end("Not found"); return;
  }
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { "Cache-Control": cacheControl, ETag: etag };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers); res.end(); return;
  }
  res.writeHead(200, {
    ...headers,
    "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
    "Content-Length": st.size,
  });
  createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
}

async function serveOutput(urlPath, req, res) {
  const thumb = urlPath.match(THUMB_PATH);
  if (thumb) {
    try { await stat(join(OUTPUT_DIR, urlPath)); }
    catch {
      try { await ensureThumb(thumb[1], Number(thumb[2])); }
      catch { res.writeHead(404); res.end("Not found"); return; }
    }
  }
  return serveFrom(OUTPUT_DIR, urlPath, req, res, IMMUTABLE);
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400); res.end("Bad request"); return;
  }
  if (urlPath === "/") urlPath = "/index.html";
  const done = urlPath.startsWith(OUTPUTS_URL + "/")
    ? serveOutput(urlPath.slice(OUTPUTS_URL.length), req, res)
    : serveFrom(PUBLIC_DIR, urlPath, req, res, "no-cache");
  done.catch((e) => {
    console.error("static serve failed:", e);
    if (!res.headersSent) { res.writeHead(500); res.end("Internal error"); }
  });
}

// ---- queue + live events -------------------------------------------------

// Connected SSE clients and per-run completion counters (for run.done).
const sseClients = new Set();
const runProgress = new Map(); // runId -> { n, settled }

function broadcast(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

async function onJobEvent(event) {
  broadcast(event);
  if (event.type !== "job.done" && event.type !== "job.failed") return;

  // Count settled jobs per run; read n from disk if we restarted mid-run.
  let p = runProgress.get(event.runId);
  if (!p) {
    try { p = { n: (await readRun(event.runId)).n, settled: 0 }; }
    catch { return; }
    runProgress.set(event.runId, p);
  }
  if (++p.settled >= p.n) {
    runProgress.delete(event.runId);
    broadcast({ type: "run.done", runId: event.runId });
  }
}

// Re-subscribed on every reconnect: the old exclusive queue dies with the connection.
const queue = await connectQueue({ setup: (ch) => consumeEvents(ch, onJobEvent) });

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(heartbeat); sseClients.delete(res); });
}

// ---- credits --------------------------------------------------------------
// One balance per configured provider: { bfl: { credits } | { error }, … }.
// Unconfigured providers are left out.
let creditsCache = { at: 0, data: null };

async function handleCredits(req, res) {
  if (Date.now() - creditsCache.at < 10_000 && creditsCache.data) {
    return sendJson(res, 200, creditsCache.data);
  }
  const data = {};
  await Promise.all(Object.entries(PROVIDERS).map(async ([id, p]) => {
    if (!p.client.API_KEY) return;
    try { data[id] = await p.client.getCredits(); }
    catch (e) { data[id] = { error: String(e.message || e) }; }
  }));
  creditsCache = { at: Date.now(), data };
  sendJson(res, 200, data);
}

// ---- Anifusion inputs --------------------------------------------------------
// Anifusion takes images as uploaded asset ids, not inline base64. Upload them
// here, once per run, so a 4-image run doesn't upload its references 4 times
// and upload errors (wrong format, too big) come straight back to the form.
const POSE_MODELS = new Set(["controlnet-openpose", "controlnet-anytest"]);

async function uploadAnifusionInputs(model, incoming, refBuffers) {
  const decode = (b64) => (typeof b64 === "string" && b64 ? Buffer.from(b64, "base64") : null);
  const source = model.supports.has("source_image") ? decode(incoming.source_image) : null;
  const poseImage = model.supports.has("controlnets") ? decode(incoming.pose_image) : null;
  if (source && (refBuffers.length || poseImage)) {
    throw new PermanentError("Image-to-image can't be combined with reference images or a pose image. Remove one or the other.");
  }
  if (poseImage && !POSE_MODELS.has(incoming.pose_model)) {
    throw new PermanentError(`Unknown pose control: ${incoming.pose_model}`);
  }
  const referenceIds = [];
  for (const [k, buf] of refBuffers.entries()) {
    referenceIds.push(await anifusion.uploadAsset(buf, "reference", `reference image ${k + 1}`));
  }
  const sourceId = source ? await anifusion.uploadAsset(source, "source", "source image") : undefined;
  const pose = poseImage ? {
    model: incoming.pose_model,
    imageId: await anifusion.uploadAsset(poseImage, "reference", "pose image"),
    strength: Math.min(2, Math.max(0, Number(incoming.pose_strength) || 1)),
  } : undefined;
  return { referenceIds, sourceId, pose };
}

// ---- run submission --------------------------------------------------------
// Image fields that arrive as base64 and are never forwarded as-is: BFL gets
// reference images via volume paths, Anifusion gets uploaded asset ids.
const IMAGE_INPUT_KEYS = new Set(["input_images", "source_image", "pose_image", "pose_model", "pose_strength"]);

async function handleCreateRun(req, res) {
  // Fail before createRun writes anything (or Anifusion uploads run), so a
  // broker outage leaves no orphan runs.
  if (!queue.channel) {
    return sendJson(res, 503, { error: "Message broker unavailable — reconnecting. Try again shortly." });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, 400, { error: "Invalid JSON body", detail: String(e) });
  }

  const model = MODELS[body.model];
  if (!model) return sendJson(res, 400, { error: `Unknown model: ${body.model}` });
  const provider = providerOf(model);
  if (!provider.client.API_KEY) {
    return sendJson(res, 503, { error: `${provider.keyVar} is not set. Add your ${provider.name} key to .env.` });
  }

  // Forward only the fields this model supports. Reference images arrive
  // separately (params.input_images: base64[]) and travel to the worker as
  // volume paths, not through RabbitMQ.
  const incoming = body.params || {};
  const inputImagesB64 = Array.isArray(incoming.input_images)
    ? incoming.input_images.slice(0, model.maxImages ?? MAX_INPUT_IMAGES) : [];
  const payload = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (IMAGE_INPUT_KEYS.has(key) || !model.supports.has(key)) continue;
    if (value === "" || value === null || value === undefined) continue;
    payload[key] = value;
  }
  if (model.requiresPrompt && !payload.prompt) {
    return sendJson(res, 400, { error: "This model requires a prompt." });
  }
  if (!payload.prompt && inputImagesB64.length === 0) {
    return sendJson(res, 400, { error: "A prompt (or a reference image) is required." });
  }

  // A character sheet is one job that returns six images.
  const n = model.fixedCount || Math.min(Math.max(parseInt(body.n, 10) || 1, 1), 4); // 1..4 images

  let inputBuffers;
  try {
    inputBuffers = inputImagesB64.map((b64) => Buffer.from(b64, "base64"));
  } catch {
    return sendJson(res, 400, { error: "Invalid base64 in input_images." });
  }

  let cost = null;
  let anifusionInputs;
  if (model.provider === "anifusion") {
    // Anifusion prices each job when the worker estimates it; the billed
    // credits land on each job record.
    try {
      anifusionInputs = await uploadAnifusionInputs(model, incoming, inputBuffers);
    } catch (e) {
      return sendJson(res, e instanceof PermanentError ? 400 : 502, { error: String(e.message || e) });
    }
  } else {
    const inputMp = Number(body.input_mp) || 0;
    const perImage = estimateCost(model, payload, inputMp);
    cost = { usd: +(perImage * n).toFixed(4), credits: Math.round(perImage * n * 100), estimate: true };
  }

  const { runId, inputPaths } = await createRun({
    model: body.model,
    modelLabel: model.label,
    provider: model.provider,
    prompt: payload.prompt || "",
    params: payload,
    n,
    cost,
    inputImages: inputImagesB64.length,
  }, inputBuffers);

  trace.getActiveSpan()?.setAttributes({
    "flux.run_id": runId,
    "flux.model": body.model,
    "flux.images": n,
    "flux.input_images": inputImagesB64.length,
    ...(cost ? { "flux.estimated_cost_usd": cost.usd } : {}),
    "input.value": payload.prompt || "",
  });

  // Give each image a distinct seed so a batch isn't identical.
  // If the user fixed a seed, offset from it; otherwise randomize per image.
  const baseSeed = payload.seed;
  const jobs = model.fixedCount ? 1 : n;
  for (let i = 0; i < jobs; i++) {
    const p = { ...payload };
    if (baseSeed !== undefined) p.seed = Number(baseSeed) + i;
    else if (model.supports.has("seed")) p.seed = Math.floor(Math.random() * 2_147_483_647);
    const job = { runId, jobIndex: i, modelId: body.model };
    if (model.provider === "anifusion") {
      // The worker sends this body as-is; images are already uploaded.
      job.payload = anifusion.buildBody(model, p, anifusionInputs);
      if (model.fixedCount) job.count = n;
    } else {
      Object.assign(job, { payload: p, inputPaths });
    }
    publishJob(queue, job);
  }
  runProgress.set(runId, { n, settled: 0 });

  sendJson(res, 202, { run: await readRun(runId) });
}

// ---- run deletion -----------------------------------------------------------
async function handleDeleteRuns(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, 400, { error: "Invalid JSON body", detail: String(e) });
  }
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length || !ids.every((id) => typeof id === "string")) {
    return sendJson(res, 400, { error: "ids must be a non-empty array of run ids." });
  }

  const deleted = [];
  for (const id of ids) {
    try {
      await deleteRun(id); // validates the id format before touching disk
      runProgress.delete(id);
      deleted.push(id);
    } catch (e) {
      return sendJson(res, 400, { error: `Could not delete ${id}: ${String(e.message || e)}`, deleted });
    }
  }
  broadcast({ type: "runs.deleted", ids: deleted }); // keep other tabs in sync
  sendJson(res, 200, { deleted });
}

// ---- router -------------------------------------------------------------
const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (req.method === "GET" && pathname === "/api/models") {
    return sendJson(res, 200,
      Object.entries(MODELS).map(([id, m]) => ({
        id, label: m.label, supports: [...m.supports], price: m.price,
        maxImages: m.maxImages, requiresPrompt: !!m.requiresPrompt,
        provider: m.provider, providerName: providerOf(m).name, configured: !!providerOf(m).client.API_KEY,
        ranges: m.ranges, fixedCount: m.fixedCount,
      })));
  }
  // k8s readiness probe target: a pod that has lost the broker still serves
  // /api/models fine but cannot submit a thing. Liveness stays on /api/models.
  if (req.method === "GET" && pathname === "/api/health") {
    const broker = queue.channel ? "connected" : "disconnected";
    return sendJson(res, queue.channel ? 200 : 503, { ok: !!queue.channel, broker });
  }
  if (req.method === "GET" && pathname === "/api/credits") {
    return handleCredits(req, res);
  }
  if (req.method === "GET" && pathname === "/api/runs") {
    return listRuns().then((runs) => sendJson(res, 200, runs))
      .catch((e) => sendJson(res, 500, { error: String(e.message || e) }));
  }
  if (req.method === "GET" && pathname.startsWith("/api/runs/")) {
    return readRun(pathname.slice("/api/runs/".length)).then((run) => sendJson(res, 200, run))
      .catch(() => sendJson(res, 404, { error: "Run not found" }));
  }
  if (req.method === "GET" && pathname === "/api/events") {
    return handleEvents(req, res);
  }
  if (req.method === "POST" && pathname === "/api/runs") {
    // Root span of the trace: the workers' job spans attach to it via AMQP headers.
    return withSpan("flux.run", {
      "openinference.span.kind": "CHAIN",
      "http.request.method": "POST",
      "http.route": "/api/runs",
    }, () => handleCreateRun(req, res), { kind: SpanKind.SERVER }).catch((e) => {
      console.error("run submit failed:", e);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error", detail: String(e.message || e) });
    });
  }
  if (req.method === "DELETE" && pathname === "/api/runs") {
    return handleDeleteRuns(req, res).catch((e) => {
      console.error("run delete failed:", e);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error", detail: String(e.message || e) });
    });
  }
  if (req.method === "GET") return serveStatic(req, res);

  res.writeHead(405); res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`\n  FLUX image studio running:  http://localhost:${PORT}`);
  const unset = Object.values(PROVIDERS).filter((p) => !p.client.API_KEY);
  for (const p of unset) console.log(`  ⚠  ${p.keyVar} not set, so ${p.name} models won't run. Add it to .env.`);
  if (unset.length) console.log("");
});
