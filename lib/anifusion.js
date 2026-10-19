import { randomUUID } from "node:crypto";

import { sleep, PermanentError } from "./bfl.js"; // bfl.js also loads .env
import { withSpan } from "./tracing.js";

// Anifusion Developer API (https://anifusion.ai/developers/api/). Requires a
// Creator or Pro plan; the API spends the same credits as the editor.
export const API_KEY = process.env.ANIFUSION_API_KEY;
export const BASE_URL = (process.env.ANIFUSION_BASE_URL || "https://anifusion.ai/api/v1").replace(/\/$/, "");
const ORIGIN = new URL(BASE_URL).origin;

// Every paid start sends a max_credits ceiling. The worker sets it to the
// estimate, and refuses any job whose estimate is above this cap.
export const MAX_CREDITS = Math.max(1, parseInt(process.env.ANIFUSION_MAX_CREDITS, 10) || 200);

// ---- model registry -----------------------------------------------------
// A curated subset of GET /models. Each request schema sets
// additionalProperties: false, so `supports` lists exactly the fields that
// model's text_to_image variant accepts (plus i2i extras where noted).
// Reference images, the pose ControlNet and the img2img source are uploaded
// as assets by the api and sent by id; they're listed under pseudo-params
// (input_images, controlnets, source_image) so the UI can show or hide them.
// `ranges` are [min, max, default] from the OpenAPI schema.
const SDXL = ["prompt", "negative_prompt", "width", "height", "seed", "steps", "guidance",
  "quality_tags", "input_images", "controlnets", "source_image", "denoise_strength"];
const sdxl = (label, ranges, { lightning = true } = {}) => ({
  label, maxImages: 4, ranges,
  supports: new Set([...SDXL, ...(lightning ? ["lightning"] : [])]),
});
const promptOnly = (label, maxImages) => ({
  label, maxImages, supports: new Set(["prompt", "width", "height", "input_images"]),
});

const DEFS = {
  "illustriousxl2": sdxl("Illustrious XL 2  (anime, pose control)", { steps: [1, 30, 28], guidance: [0, 12, 5] }),
  "wai-illustrious-v14": sdxl("WAI Illustrious v14  (anime, pose control)", { steps: [1, 50, 28], guidance: [0, 12, 7] }),
  "noobaixl": sdxl("NoobAI XL  (anime, pose control)", { steps: [1, 30, 28], guidance: [0, 12, 3.5] }, { lightning: false }),
  "animaginexl4.0": sdxl("Animagine XL 4.0  (anime, pose control)", { steps: [1, 50, 28], guidance: [0, 12, 5] }),
  "novaanimexl": sdxl("Nova Anime XL  (anime, pose control)", { steps: [1, 50, 28], guidance: [0, 12, 4.5] }),
  "ponydiffusionv6": sdxl("Pony Diffusion V6  (pose control)", { steps: [1, 30, 25], guidance: [0, 12, 7] }),
  "fluxdevmanga": {
    label: "Flux Dev Manga  (black-and-white manga)",
    maxImages: 0,
    ranges: { steps: [1, 50, 28], guidance: [0, 12, 3.5] },
    supports: new Set(["prompt", "width", "height", "seed", "steps", "guidance",
      "flux_manga_append_style_hint", "source_image", "denoise_strength"]),
  },
  "nano-banana-pro": promptOnly("Nano Banana Pro  (up to 14 character refs)", 14),
  "nano-banana-2": promptOnly("Nano Banana 2  (up to 14 character refs)", 14),
  "gpt-image-2": promptOnly("GPT Image 2  (up to 8 refs)", 8),
  // Six views of one character from a description (+ optional references).
  // Not an image model: it has its own endpoint and returns six images.
  "character-sheet": {
    label: "Character sheet  (6 views of one character)",
    kind: "character-sheet",
    maxImages: 14,
    fixedCount: 6,
    supports: new Set(["prompt", "tags", "input_images"]),
  },
};

// Ids are namespaced so they can't collide with BFL model ids.
export const MODELS = Object.fromEntries(Object.entries(DEFS).map(([id, m]) => [
  `anifusion:${id}`,
  { ...m, provider: "anifusion", apiModel: id, requiresPrompt: true, price: { anifusion: true, maxCredits: MAX_CREDITS } },
]));

// ---- HTTP ---------------------------------------------------------------
class CapacityError extends Error {}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${API_KEY}`, accept: "application/json", ...extra };
}

// "invalid_request: prompt is too long" from the documented error envelope.
function describeError(status, text) {
  try {
    const { error } = JSON.parse(text);
    if (error?.message) return `Anifusion ${status} ${error.code}: ${error.message}`;
  } catch { /* not the JSON envelope */ }
  return `Anifusion ${status}: ${text.slice(0, 500)}`;
}

function errorCode(text) {
  try { return JSON.parse(text).error?.code; } catch { return undefined; }
}

// One API call. Rate-limit 429s (20 writes / 120 reads a minute) wait and
// retry; a 429 capacity_limited (2 active generations per account) is thrown
// as CapacityError for the caller to wait out. 5xx and network errors retry a
// few times; other 4xx are permanent. Returns parsed JSON (or null).
async function request(method, path, { body, headers = {}, raw } = {}) {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const deadline = Date.now() + 120_000;
  let failures = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: authHeaders(body && !raw ? { "Content-Type": "application/json", ...headers } : headers),
        body: raw ?? (body ? JSON.stringify(body) : undefined),
      });
    } catch (e) {
      if (++failures >= 4) throw e;
      await sleep(800 * 2 ** failures);
      continue;
    }
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if (res.status === 429) {
      if (errorCode(text) === "capacity_limited") throw new CapacityError(describeError(429, text));
      const wait = (Number(res.headers.get("retry-after")) || 5) * 1000;
      if (Date.now() + wait > deadline) throw new Error(describeError(429, text));
      await sleep(wait);
      continue;
    }
    if (res.status >= 500 && ++failures < 4) {
      await sleep(800 * 2 ** failures);
      continue;
    }
    const msg = describeError(res.status, text);
    throw res.status < 500 ? new PermanentError(msg) : new Error(msg);
  }
}

// ---- response helpers -----------------------------------------------------
// The OpenAPI spec documents request bodies but not most response bodies, so
// fields are looked up by their likely names anywhere in the response.
function find(obj, keys) {
  const queue = [obj];
  while (queue.length) {
    const o = queue.shift();
    if (!o || typeof o !== "object") continue;
    for (const k of keys) if (o[k] != null && typeof o[k] !== "object") return o[k];
    queue.push(...Object.values(o));
  }
  return undefined;
}

// Image URLs in document order, best key first. display_url is what the docs
// name; url is what comic operations use. Page links (editor_url…) are skipped.
function findImageUrls(obj) {
  const byKey = { display_url: [], image_url: [], download_url: [], url: [] };
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && k in byKey && /^(https?:\/\/|\/)/.test(v)) byKey[k].push(v);
      else walk(v);
    }
  })(obj);
  for (const urls of Object.values(byKey)) if (urls.length) return [...new Set(urls)];
  return [];
}

function findAll(obj, key) {
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (k === key && typeof v === "string") out.push(v);
      else walk(v);
    }
  })(obj);
  return [...new Set(out)];
}

const SUCCESS = new Set(["succeeded", "partially_succeeded", "completed", "complete", "ready", "done"]);
const FAILURE = new Set(["failed", "cancelled", "canceled", "error", "expired", "moderated", "rejected"]);

// ---- account --------------------------------------------------------------
export async function getCredits() {
  const data = await request("GET", "/credit-balance");
  const credits = find(data, ["balance", "credits", "available_credits", "credit_balance", "total"]);
  return { credits: Number(credits) || 0 };
}

// ---- assets ---------------------------------------------------------------
const MAX_UPLOAD = 10 * 1024 * 1024;

function sniffImageType(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

// Upload one image and return its asset id: intent → PUT bytes → complete.
// purpose: "source" | "reference" (pose images go up as references).
export function uploadAsset(buffer, purpose, label = "image") {
  return withSpan("anifusion.upload", { "anifusion.purpose": purpose, "anifusion.bytes": buffer.length }, async () => {
    const type = sniffImageType(buffer);
    if (!type) throw new PermanentError(`The ${label} must be a PNG, JPEG or WebP for Anifusion.`);
    if (buffer.length > MAX_UPLOAD) {
      throw new PermanentError(`The ${label} is ${(buffer.length / 1048576).toFixed(1)} MiB; Anifusion accepts up to 10 MiB.`);
    }
    const intent = await request("POST", "/assets/upload-intents", { body: { purpose } });
    const assetId = find(intent, ["asset_id", "id"]);
    if (!assetId) throw new Error(`Upload intent has no asset id: ${JSON.stringify(intent).slice(0, 300)}`);
    const uploadUrl = find(intent, ["upload_url"]) || `/assets/${assetId}/upload`;
    const target = new URL(uploadUrl, BASE_URL + "/");
    if (target.origin === ORIGIN) {
      // Same host: the docs say to send the API credential with the bytes.
      await request("PUT", target.href, { raw: buffer, headers: { "Content-Type": type } });
    } else {
      // A presigned storage URL would reject (and shouldn't see) our key.
      const res = await fetch(target, { method: "PUT", headers: { "Content-Type": type }, body: buffer });
      if (!res.ok) throw new Error(`Asset upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    await request("POST", `/assets/${assetId}/complete`);
    return assetId;
  });
}

// ---- generation -------------------------------------------------------------
// Download a finished image. Display URLs expire after five minutes, so this
// runs as soon as the job succeeds. The key only goes to Anifusion's own host.
// Their storage serves images as application/octet-stream, so the format
// comes from the file's bytes, with the header only as a fallback.
async function download(urls) {
  let lastErr;
  for (const u of urls) {
    const url = new URL(u, ORIGIN);
    try {
      const res = await fetch(url, url.origin === ORIGIN ? { headers: { Authorization: `Bearer ${API_KEY}` } } : {});
      const header = res.headers.get("content-type") || "";
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = sniffImageType(buffer) || (header.startsWith("image/") ? header : null);
        if (contentType) return { buffer, contentType };
      }
      lastErr = new Error(`Image download failed (${res.status} ${header})`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("No image URL to download.");
}

async function poll(path, span, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  let pollFailures = 0;
  while (Date.now() < deadline) {
    await sleep(polls < 10 ? 2000 : 4000);
    span.setAttribute("anifusion.polls", ++polls);
    let data;
    try {
      data = await request("GET", path);
      pollFailures = 0;
    } catch (e) {
      if (e instanceof PermanentError || ++pollFailures >= 5) throw e;
      continue;
    }
    const status = String(find(data, ["status", "state"]) || "").toLowerCase();
    if (SUCCESS.has(status)) return data;
    if (FAILURE.has(status) || status.includes("moderat")) {
      span.setAttribute("anifusion.status", status);
      const reason = find(data, ["error_code", "message", "error", "reason"]);
      // Credits are charged at start, so a rerun would charge again.
      throw new PermanentError(`Anifusion job ${status}${reason ? `: ${reason}` : ""}`);
    }
  }
  throw new PermanentError("Timed out waiting for Anifusion (the job may still finish in your Anifusion account).");
}

// Estimate, then start with the estimate's price as the ceiling. Starts that
// hit the 2-active-jobs limit wait and re-estimate (estimates expire after ten
// minutes), so extra workers queue here instead of failing.
async function estimateAndStart(kind, body, span) {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const est = await request("POST", `/${kind}/estimates`, { body });
    const estimateId = find(est, ["estimate_id"]) ?? find(est, ["id"]);
    const credits = Number(find(est, ["expected_credits", "credits", "estimated_credits", "cost"]));
    if (!estimateId) throw new Error(`Estimate has no estimate_id: ${JSON.stringify(est).slice(0, 300)}`);
    if (find(est, ["has_sufficient_credits"]) === false) {
      throw new PermanentError(`Not enough Anifusion credits (this job needs ${credits || "more"}).`);
    }
    if (credits > MAX_CREDITS) {
      throw new PermanentError(`Anifusion estimates ${credits} credits, over the ANIFUSION_MAX_CREDITS cap of ${MAX_CREDITS}.`);
    }
    span.setAttribute("anifusion.estimated_credits", credits || 0);
    try {
      const started = await request("POST", `/${kind}`, {
        body: { ...body, estimate_id: estimateId, max_credits: credits || MAX_CREDITS },
        headers: { "Idempotency-Key": randomUUID() },
      });
      return { started, credits };
    } catch (e) {
      if (!(e instanceof CapacityError) || Date.now() > deadline) throw e;
      span.addEvent("anifusion.capacity_wait");
      await sleep(10_000 + Math.random() * 5000);
    }
  }
}

// Once a job has started its credits are spent, so nothing after the start
// (polling, lookups, downloads) may surface as retryable.
async function afterStart(fn) {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof PermanentError ? e : new PermanentError(e.message);
  }
}

function spanAttributes(model, body) {
  const { prompt, description, negative_prompt, ...rest } = body;
  return {
    "openinference.span.kind": "LLM",
    "langfuse.observation.type": "generation",
    "llm.model_name": model.apiModel,
    "llm.invocation_parameters": JSON.stringify(rest),
    "input.value": prompt || description || "",
    ...(negative_prompt ? { "flux.negative_prompt": negative_prompt } : {}),
  };
}

// One standalone image. body is the /images/estimates request (operation,
// model_id, prompt, width, height, …). Returns { buffer, contentType, … }.
export function generateImage(model, body) {
  return withSpan("anifusion.generate", spanAttributes(model, body), async (span) => {
    const { started, credits } = await estimateAndStart("images", body, span);
    return afterStart(async () => {
      const opId = find(started, ["operation_id"]) ?? find(started, ["id"]);
      if (!opId) throw new PermanentError(`Image start has no operation id: ${JSON.stringify(started).slice(0, 300)}`);
      span.setAttribute("anifusion.operation_id", String(opId));

      const op = await withSpan("anifusion.poll", {}, (s) => poll(`/image-generations/${opId}`, s, 5 * 60_000));
      let urls = findImageUrls(op);
      if (!urls.length) {
        // The operation may only name the image; its display URL is on /images/{id}.
        const imageId = find(op, ["image_id"]) ?? findAll(op, "id").find((id) => id !== opId);
        if (imageId) urls = findImageUrls(await request("GET", `/images/${imageId}`));
      }
      if (!urls.length) throw new PermanentError(`No image in the finished operation: ${JSON.stringify(op).slice(0, 400)}`);

      const { buffer, contentType } = await withSpan("anifusion.download", {}, () => download(urls));
      const charged = Number(find(op, ["charged_credits", "credits_charged", "cost"])) || credits;
      span.setAttribute("output.value", JSON.stringify({ opId, contentType, bytes: buffer.length }));
      return { buffer, contentType, id: opId, cost: charged || undefined, seed: body.seed };
    });
  });
}

// A six-view character sheet. Returns { images: [{ buffer, contentType }], … }.
export function generateCharacterSheet(model, body) {
  return withSpan("anifusion.character_sheet", spanAttributes(model, body), async (span) => {
    const { started, credits } = await estimateAndStart("character-sheets", body, span);
    return afterStart(async () => {
      const sheetId = find(started, ["sheet_id"]) ?? find(started, ["id"]);
      if (!sheetId) throw new PermanentError(`Character sheet start has no id: ${JSON.stringify(started).slice(0, 300)}`);
      span.setAttribute("anifusion.sheet_id", String(sheetId));

      const sheet = await withSpan("anifusion.poll", {}, (s) => poll(`/character-sheets/${sheetId}`, s, 10 * 60_000));
      const urls = findImageUrls(sheet);
      if (!urls.length) throw new PermanentError(`No images in the finished sheet: ${JSON.stringify(sheet).slice(0, 400)}`);

      // Each URL is its own view, so download them separately (not as fallbacks).
      const images = await withSpan("anifusion.download", {}, () => Promise.all(urls.map((u) => download([u]))));
      const charged = Number(find(sheet, ["charged_credits", "credits_charged", "cost"])) || credits;
      return { images, id: sheetId, cost: charged || undefined };
    });
  });
}

// Retry once if the job failed before Anifusion accepted it. Everything after
// a start is a PermanentError, because credits are charged at start.
export async function generateWithRetry(model, body) {
  const run = model.kind === "character-sheet" ? generateCharacterSheet : generateImage;
  try {
    return await run(model, body);
  } catch (e) {
    if (e instanceof PermanentError) throw e;
    console.warn(`Anifusion job failed (${e.message}); retrying once…`);
    return run(model, body);
  }
}

// Build the API request body from the app's payload and uploaded asset ids.
// Only fields the model's schema allows are sent (additionalProperties: false).
export function buildBody(model, payload, { referenceIds = [], sourceId, pose } = {}) {
  if (model.kind === "character-sheet") {
    return {
      pipeline: "hybrid",
      description: payload.prompt,
      ...(payload.tags ? { tags: payload.tags } : {}),
      ...(referenceIds.length ? { reference_image_ids: referenceIds } : {}),
    };
  }
  const body = { operation: sourceId ? "image_to_image" : "text_to_image", model_id: model.apiModel };
  for (const k of ["prompt", "negative_prompt", "width", "height", "seed", "steps", "guidance",
    "quality_tags", "lightning", "flux_manga_append_style_hint"]) {
    if (payload[k] !== undefined && model.supports.has(k)) body[k] = payload[k];
  }
  if (sourceId) {
    body.source_image_id = sourceId;
    if (payload.denoise_strength !== undefined) body.denoise_strength = payload.denoise_strength;
  } else {
    if (referenceIds.length) body.reference_image_ids = referenceIds;
    if (pose) body.controlnets = [{ model: pose.model, image_id: pose.imageId, strength: pose.strength }];
  }
  return body;
}
