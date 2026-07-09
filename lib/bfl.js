import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- tiny .env loader (no dependencies) --------------------------------
try {
  const env = readFileSync(join(__dirname, "..", ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* no .env file — rely on real environment variables */
}

export const API_KEY = process.env.BFL_API_KEY;
export const BASE_URL = (process.env.BFL_BASE_URL || "https://api.bfl.ai").replace(/\/$/, "");

// FLUX.2 accepts up to 8 reference images: input_image, input_image_2 … input_image_8.
export const MAX_INPUT_IMAGES = 8;
export const INPUT_IMAGE_KEYS = Array.from({ length: MAX_INPUT_IMAGES }, (_, i) =>
  i === 0 ? "input_image" : `input_image_${i + 1}`);

// ---- model registry -----------------------------------------------------
// Each model maps to its API path, the parameters it accepts, and pricing.
// Slugs follow the documented FLUX.2 pattern; adjust here if BFL changes them.
//
// price is an ESTIMATE (USD), megapixel-based, mirroring BFL's model:
//   cost = firstMp + max(0, outputMP - 1) * extraMp + inputMP * inputMp
// Known exactly for [max] (first $0.07 / extra $0.03 / input $0.03); the others
// use the published "from" 1-MP price with an approximate extra-MP rate.
// 1 credit = $0.01. Confirm exact figures at https://bfl.ai/pricing.
const COMMON_PARAMS = ["prompt", "negative_prompt", ...INPUT_IMAGE_KEYS, "seed", "width", "height",
  "aspect_ratio", "output_format"];
export const MODELS = {
  "flux-2-flex": {
    label: "FLUX.2 [flex]  (steps + guidance control)",
    path: "/v1/flux-2-flex",
    supports: new Set([...COMMON_PARAMS, "guidance", "steps", "prompt_upsampling", "safety_tolerance"]),
    price: { firstMp: 0.05, extraMp: 0.02, inputMp: 0.03 },
  },
  "flux-2-pro": {
    label: "FLUX.2 [pro]",
    path: "/v1/flux-2-pro",
    supports: new Set([...COMMON_PARAMS, "prompt_upsampling", "safety_tolerance"]),
    price: { firstMp: 0.03, extraMp: 0.015, inputMp: 0.03 },
  },
  "flux-2-klein-9b": {
    label: "FLUX.2 [klein] 9B  (open, fast)",
    path: "/v1/flux-2-klein-9b",
    supports: new Set([...COMMON_PARAMS, "guidance", "steps"]),
    price: { firstMp: 0.015, extraMp: 0.01, inputMp: 0.03 },
  },
  "flux-2-max": {
    label: "FLUX.2 [max]  (highest quality)",
    path: "/v1/flux-2-max",
    supports: new Set([...COMMON_PARAMS, "prompt_upsampling", "safety_tolerance"]),
    price: { firstMp: 0.07, extraMp: 0.03, inputMp: 0.03 },
  },
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Estimate the cost (USD) of one image at the given resolution + reference input.
export function estimateCost(model, width, height, inputMp = 0) {
  const p = model.price;
  const outMp = ((width || 1024) * (height || 1024)) / 1_000_000;
  return p.firstMp + Math.max(0, outMp - 1) * p.extraMp + inputMp * p.inputMp;
}

// Statuses the API can settle on besides Ready. Anything moderated is
// permanent — resubmitting the same prompt just gets moderated again.
const TERMINAL_STATUSES = new Set(["Error", "Failed", "Request Moderated", "Content Moderated", "Task not found"]);
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);

export class PermanentError extends Error {}

// fetch with exponential backoff on network errors and retryable HTTP statuses.
export async function fetchWithRetry(url, options, { attempts = 4, baseDelay = 800 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(baseDelay * 2 ** (i - 1) + Math.random() * 300);
    try {
      const res = await fetch(url, options);
      if (!RETRYABLE_HTTP.has(res.status)) return res;
      lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    } catch (e) {
      lastErr = e; // network error / timeout — retry
    }
  }
  throw lastErr;
}

// Remaining account balance: 1 credit = $0.01.
export async function getCredits() {
  const res = await fetchWithRetry(`${BASE_URL}/v1/credits`, {
    headers: { "x-key": API_KEY, accept: "application/json" },
  }, { attempts: 2 });
  if (!res.ok) throw new Error(`Credits lookup failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json(); // { credits }
}

// Submit one job, poll until Ready, and return the downloaded image bytes.
export async function generateOne(model, payload) {
  const submit = await fetchWithRetry(`${BASE_URL}${model.path}`, {
    method: "POST",
    headers: { "x-key": API_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const submitText = await submit.text();
  if (!submit.ok) {
    const err = new Error(`BFL submit failed (${submit.status}): ${submitText}`);
    // 4xx (bad params, bad key, moderation) won't succeed on a resubmit
    throw submit.status >= 400 && submit.status < 500 ? new PermanentError(err.message) : err;
  }
  let id, polling_url;
  try {
    ({ id, polling_url } = JSON.parse(submitText));
  } catch {
    throw new Error(`BFL submit returned non-JSON: ${submitText.slice(0, 200)}`);
  }
  const pollUrl = polling_url || `${BASE_URL}/v1/get_result?id=${id}`;

  // Poll until Ready (result URLs expire ~10 min, so we grab it promptly).
  // Transient poll failures (gateway blips, non-JSON bodies) don't kill the
  // job — only a run of consecutive failures does.
  const deadline = Date.now() + 180_000;
  let result = null;
  let pollFailures = 0;
  while (Date.now() < deadline) {
    await sleep(1500);
    let data;
    try {
      const poll = await fetch(pollUrl, { headers: { "x-key": API_KEY, accept: "application/json" } });
      data = await poll.json();
      pollFailures = 0;
    } catch (e) {
      if (++pollFailures >= 5) throw new Error(`Polling failed repeatedly: ${e.message || e}`);
      continue;
    }
    if (data.status === "Ready") { result = data; break; }
    if (TERMINAL_STATUSES.has(data.status)) {
      const msg = `Generation ${data.status}: ${JSON.stringify(data.details ?? data)}`;
      throw data.status.includes("Moderated") ? new PermanentError(msg) : new Error(msg);
    }
  }
  if (!result) throw new Error("Timed out waiting for the image.");

  const sampleUrl = result.result?.sample;
  if (!sampleUrl) throw new Error(`No image URL in result: ${JSON.stringify(result)}`);

  // Download now — the BFL URL expires; the caller persists the bytes.
  const img = await fetchWithRetry(sampleUrl, {}, { attempts: 3 });
  if (!img.ok) throw new Error(`Image download failed (${img.status})`);
  const buffer = Buffer.from(await img.arrayBuffer());
  const contentType = img.headers.get("content-type") || "image/png";
  return { buffer, contentType, seed: result.result?.seed, id };
}

// Run a job with one full-job retry for transient failures. Moderation and
// other 4xx outcomes are permanent, so those surface immediately.
export async function generateWithRetry(model, payload) {
  try {
    return await generateOne(model, payload);
  } catch (e) {
    if (e instanceof PermanentError) throw e;
    console.warn(`Job failed (${e.message}); retrying once…`);
    return generateOne(model, payload);
  }
}
