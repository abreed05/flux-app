import { createServer } from "node:http";
import { readFile } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname, sep } from "node:path";
import { SpanKind, trace } from "@opentelemetry/api";

import { API_KEY, MODELS, INPUT_IMAGE_KEYS, MAX_INPUT_IMAGES, estimateCost, getCredits } from "./lib/bfl.js";
import { connectQueue, publishJob, consumeEvents } from "./lib/queue.js";
import { OUTPUT_DIR, OUTPUTS_URL, createRun, readRun, listRuns, deleteRun } from "./lib/store.js";
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

// Serve urlPath from rootDir with a path-traversal guard. Used for both the
// UI (public/) and generated images (OUTPUT_DIR, mounted at /outputs).
function serveFrom(rootDir, urlPath, res) {
  const filePath = normalize(join(rootDir, urlPath));
  if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400); res.end("Bad request"); return;
  }
  if (urlPath === "/") urlPath = "/index.html";
  if (urlPath.startsWith(OUTPUTS_URL + "/")) {
    return serveFrom(OUTPUT_DIR, urlPath.slice(OUTPUTS_URL.length), res);
  }
  serveFrom(PUBLIC_DIR, urlPath, res);
}

// ---- queue + live events -------------------------------------------------
const { channel } = await connectQueue();

// Connected SSE clients and per-run completion counters (for run.done).
const sseClients = new Set();
const runProgress = new Map(); // runId -> { n, settled }

function broadcast(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

await consumeEvents(channel, async (event) => {
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
});

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
let creditsCache = { at: 0, data: null };

async function handleCredits(req, res) {
  if (!API_KEY) return sendJson(res, 503, { error: "BFL_API_KEY is not set." });
  if (Date.now() - creditsCache.at < 10_000 && creditsCache.data) {
    return sendJson(res, 200, creditsCache.data);
  }
  try {
    const data = await getCredits();
    creditsCache = { at: Date.now(), data };
    sendJson(res, 200, data);
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e) });
  }
}

// ---- run submission --------------------------------------------------------
async function handleCreateRun(req, res) {
  if (!API_KEY) {
    return sendJson(res, 503, { error: "BFL_API_KEY is not set. Copy .env.example to .env and add your key." });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, 400, { error: "Invalid JSON body", detail: String(e) });
  }

  const model = MODELS[body.model];
  if (!model) return sendJson(res, 400, { error: `Unknown model: ${body.model}` });

  // Forward only the fields this model supports. Reference images arrive
  // separately (params.input_images: base64[]) and travel to the worker as
  // volume paths, not through RabbitMQ.
  const incoming = body.params || {};
  const inputImagesB64 = Array.isArray(incoming.input_images)
    ? incoming.input_images.slice(0, model.maxImages ?? MAX_INPUT_IMAGES) : [];
  const payload = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "input_images" || !model.supports.has(key)) continue;
    if (value === "" || value === null || value === undefined) continue;
    payload[key] = value;
  }
  if (model.requiresPrompt && !payload.prompt) {
    return sendJson(res, 400, { error: "This model requires a prompt." });
  }
  if (!payload.prompt && inputImagesB64.length === 0) {
    return sendJson(res, 400, { error: "A prompt (or a reference image) is required." });
  }

  const n = Math.min(Math.max(parseInt(body.n, 10) || 1, 1), 4); // 1..4 images

  let inputBuffers;
  try {
    inputBuffers = inputImagesB64.map((b64) => Buffer.from(b64, "base64"));
  } catch {
    return sendJson(res, 400, { error: "Invalid base64 in input_images." });
  }

  const inputMp = Number(body.input_mp) || 0;
  const perImage = estimateCost(model, payload, inputMp);
  const cost = { usd: +(perImage * n).toFixed(4), credits: Math.round(perImage * n * 100), estimate: true };

  const { runId, inputPaths } = await createRun({
    model: body.model,
    modelLabel: model.label,
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
    "flux.estimated_cost_usd": cost.usd,
    "input.value": payload.prompt || "",
  });

  // Give each image a distinct seed so a batch isn't identical.
  // If the user fixed a seed, offset from it; otherwise randomize per image.
  const baseSeed = payload.seed;
  for (let i = 0; i < n; i++) {
    const p = { ...payload };
    if (baseSeed !== undefined) p.seed = Number(baseSeed) + i;
    else if (model.supports.has("seed")) p.seed = Math.floor(Math.random() * 2_147_483_647);
    publishJob(channel, { runId, jobIndex: i, modelId: body.model, payload: p, inputPaths });
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
      })));
  }
  if (req.method === "GET" && pathname === "/api/credits") {
    return handleCredits(req, res);
  }
  if (req.method === "GET" && pathname === "/api/runs") {
    return listRuns().then((runs) => sendJson(res, 200, runs))
      .catch((e) => sendJson(res, 500, { error: String(e.message || e) }));
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
  if (!API_KEY) console.log("  ⚠  BFL_API_KEY not set — copy .env.example to .env and add your key.\n");
});
