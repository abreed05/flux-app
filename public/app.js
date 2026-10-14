const $ = (id) => document.getElementById(id);

let MODELS = [];
let refImages = []; // [{ b64, dataUrl, mp, width, height }] — index order matches "image 1..N" in the prompt

function maxRefImages() {
  return currentModel()?.maxImages ?? 8;
}

// FLUX 3 rejects references over 16 MP (400) or under 256 × 256 (422).
const FLUX3_MAX_REF_MP = 16 * 1024 * 1024 / 1_000_000;
const FLUX3_MIN_REF_SIDE = 256;

// ---- init ---------------------------------------------------------------
async function init() {
  try {
    MODELS = await (await fetch("/api/models")).json();
  } catch {
    MODELS = [];
  }
  const sel = $("model");
  sel.innerHTML = "";
  for (const m of MODELS) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", onModelChange);
  onModelChange();

  refreshCredits();
  loadHistory();
  connectEvents();
}

function currentModel() {
  return MODELS.find((m) => m.id === $("model").value);
}

function onModelChange() {
  syncModelCapabilities();
  updateCost();
}

function modelSupports(param) {
  return (currentModel()?.supports || []).includes(param);
}

// Hide controls the selected model's API doesn't accept (FLUX 3 rejects
// unknown fields, and drops most FLUX.2 knobs), and show a hint.
function syncModelCapabilities() {
  document.querySelectorAll("[data-param]").forEach((el) => {
    el.classList.toggle("unsupported", !modelSupports(el.dataset.param));
  });
  // The guidance/steps note only makes sense among the FLUX.2 models.
  $("advHint").hidden = !(modelSupports("width") && !modelSupports("guidance"));

  const max = maxRefImages();
  $("maxRefs").textContent = max;
  if (refImages.length > max) {
    setStatus(`This model takes up to ${max} reference images — only the first ${max} will be sent.`, true);
  }
}

// ---- credits badge ------------------------------------------------------
let creditsTimer = null;

async function refreshCredits() {
  try {
    const resp = await fetch("/api/credits");
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    const credits = Number(data.credits) || 0;
    $("credits").textContent = `⚡ ${credits.toLocaleString()} credits · $${(credits / 100).toFixed(2)}`;
    $("credits").classList.remove("error");
  } catch {
    $("credits").textContent = "credits: unavailable";
    $("credits").classList.add("error");
  }
}

// Jobs settle in bursts; wait a beat and fetch once.
function refreshCreditsSoon() {
  clearTimeout(creditsTimer);
  creditsTimer = setTimeout(refreshCredits, 2000);
}

// ---- current output size ----------------------------------------------
function currentSize() {
  const size = $("size").value;
  if (size === "custom") {
    // Clamp to the API's valid range; an empty field would otherwise send 0.
    const clamp = (v) => Math.min(4096, Math.max(256, Number(v) || 1024));
    return { width: clamp($("width").value), height: clamp($("height").value) };
  }
  const [w, h] = size.split("x").map(Number);
  return { width: w, height: h };
}

// ---- live cost estimate ------------------------------------------------
function totalInputMp() {
  return refImages.reduce((sum, r) => sum + r.mp, 0);
}

// Mirrors estimateCost() in lib/bfl.js.
function perImageCost(p) {
  if (p.tiers) return p.tiers[$("resolution").value] ?? p.tiers["1k"]; // FLUX 3: flat per tier
  const { width, height } = currentSize();
  const outMp = (width * height) / 1_000_000;
  return p.firstMp + Math.max(0, outMp - 1) * p.extraMp + totalInputMp() * p.inputMp;
}

function updateCost() {
  const model = currentModel();
  if (!model || !model.price) { $("costEstimate").textContent = "—"; return; }
  const n = Number($("count").value);
  const per = perImageCost(model.price);
  const usd = per * n;
  const credits = Math.round(usd * 100);
  const each = n > 1 ? ` (${n} × ${(per).toFixed(3)})` : "";
  $("costEstimate").textContent = `≈ ${credits} credits · $${usd.toFixed(3)}${each}`;
}

// ---- size custom toggle ------------------------------------------------
$("size").addEventListener("change", (e) => {
  $("customSize").hidden = e.target.value !== "custom";
  updateCost();
});
$("width").addEventListener("input", updateCost);
$("height").addEventListener("input", updateCost);
$("count").addEventListener("change", updateCost);
$("resolution").addEventListener("change", updateCost);

// ---- slider value read-outs -------------------------------------------
$("guidance").addEventListener("input", (e) => ($("guidanceOut").textContent = e.target.value));
$("steps").addEventListener("input", (e) => ($("stepsOut").textContent = e.target.value));

// ---- reference images (up to 8 on FLUX.2, 10 on FLUX 3) ---------------------
function renderRefThumbs() {
  const box = $("i2iThumbs");
  box.innerHTML = "";
  refImages.forEach((ref, i) => {
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    const img = new Image();
    img.src = ref.dataUrl;
    const tag = document.createElement("span");
    tag.className = "thumb-tag";
    tag.textContent = `image ${i + 1}`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "thumb-remove";
    rm.textContent = "×";
    rm.title = "Remove";
    rm.addEventListener("click", () => {
      refImages.splice(i, 1);
      renderRefThumbs();
      updateCost();
    });
    wrap.append(img, tag, rm);
    box.appendChild(wrap);
  });
  $("i2iHint").hidden = refImages.length === 0;
}

function readFileAsRef(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve({
        b64: reader.result.split(",")[1], // strip data URI prefix
        dataUrl: reader.result,
        mp: (img.naturalWidth * img.naturalHeight) / 1_000_000,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
      img.onerror = () => reject(new Error(`Could not read ${file.name}`));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

$("input_image").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = ""; // allow re-selecting the same file later
  for (const file of files) {
    if (refImages.length >= maxRefImages()) {
      setStatus(`Reference limit is ${maxRefImages()} images for this model.`, true);
      break;
    }
    try {
      refImages.push(await readFileAsRef(file));
    } catch (err) {
      setStatus(String(err.message || err), true);
    }
  }
  renderRefThumbs();
  updateCost();
});

// ---- run state ------------------------------------------------------------
// runs is the source of truth; the gallery and viewer render from it.
const runs = new Map(); // runId -> run record { id, prompt, modelLabel, n, cost, jobs[] }
let selectedId = null;

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

function upsertRun(run) {
  runs.set(run.id, run);
  renderGalleryEntry(run);
  if (selectedId === run.id) renderViewer(run);
}

function selectRun(runId) {
  selectedId = runId;
  document.querySelectorAll(".g-item").forEach((el) =>
    el.classList.toggle("selected", el.dataset.id === runId));
  renderViewer(runs.get(runId));
}

// ---- gallery sidebar -------------------------------------------------------
function renderGalleryEntry(run) {
  let item = document.querySelector(`.g-item[data-id="${run.id}"]`);
  const fresh = !item;
  if (fresh) {
    item = document.createElement("div");
    item.className = "g-item";
    item.dataset.id = run.id;
    item.addEventListener("click", () => selectRun(run.id));
  }
  item.classList.toggle("selected", selectedId === run.id);
  item.classList.toggle("checked", checkedIds.has(run.id));
  item.title = run.prompt || "(image-only run)";
  item.innerHTML = "";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "g-check";
  check.title = "Select for deletion";
  check.checked = checkedIds.has(run.id);
  check.addEventListener("click", (e) => e.stopPropagation()); // don't open in viewer
  check.addEventListener("change", () => setChecked(run.id, check.checked));
  item.appendChild(check);

  const grid = document.createElement("div");
  grid.className = `g-grid cols-${run.n >= 2 ? 2 : 1}`;
  for (let i = 0; i < run.n; i++) {
    const job = run.jobs?.[i] || { status: "pending" };
    const cell = document.createElement("div");
    cell.className = "g-cell";
    if (job.status === "done" && job.image) {
      const img = new Image();
      img.src = job.image;
      img.loading = "lazy";
      img.alt = "";
      cell.appendChild(img);
    } else if (job.status === "failed") {
      cell.classList.add("failed");
      cell.textContent = "⚠";
    } else {
      cell.classList.add("waiting");
    }
    grid.appendChild(cell);
  }
  item.appendChild(grid);

  if (fresh) $("gallery").prepend(item);
  return item;
}

function rebuildGallery(orderedRuns) {
  const box = $("gallery");
  box.innerHTML = "";
  // prepend flips order, so feed it oldest-first to end newest-on-top
  for (const run of [...orderedRuns].reverse()) renderGalleryEntry(run);
}

// ---- gallery multi-select + delete ------------------------------------------
const checkedIds = new Set();

function updateDeleteBar() {
  $("gDeleteBar").hidden = checkedIds.size === 0;
  $("gDeleteCount").textContent = `${checkedIds.size} selected`;
  // While selecting, keep every checkbox visible (not just on hover).
  $("gallery").classList.toggle("selecting", checkedIds.size > 0);
}

function setChecked(runId, on) {
  if (on) checkedIds.add(runId);
  else checkedIds.delete(runId);
  const item = document.querySelector(`.g-item[data-id="${runId}"]`);
  if (item) {
    item.classList.toggle("checked", on);
    item.querySelector(".g-check").checked = on;
  }
  updateDeleteBar();
}

// Drop runs from local state + DOM (after our own delete or another tab's).
function removeRunsLocally(ids) {
  for (const id of ids) {
    runs.delete(id);
    checkedIds.delete(id);
    document.querySelector(`.g-item[data-id="${id}"]`)?.remove();
  }
  updateDeleteBar();
  if (selectedId && !runs.has(selectedId)) {
    const first = document.querySelector(".g-item");
    if (first) selectRun(first.dataset.id);
    else { selectedId = null; renderViewer(null); }
  }
}

$("gClearBtn").addEventListener("click", () => {
  for (const id of [...checkedIds]) setChecked(id, false);
});

$("gDeleteBtn").addEventListener("click", async () => {
  const ids = [...checkedIds];
  if (!ids.length) return;
  const label = ids.length === 1 ? "this creation" : `these ${ids.length} creations`;
  if (!confirm(`Delete ${label}? The images are removed permanently.`)) return;

  try {
    const resp = await fetch("/api/runs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const data = await resp.json();
    // A partial failure still reports what was deleted — clean those up too.
    if (data.deleted?.length) removeRunsLocally(data.deleted);
    if (!resp.ok) throw new Error(data.error || "Delete failed");
    setStatus(`Deleted ${data.deleted.length} creation${data.deleted.length > 1 ? "s" : ""}.`);
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
});

// ---- center viewer ---------------------------------------------------------
function renderViewer(run) {
  const grid = $("viewerGrid");
  const head = $("viewerHead");
  if (!run) {
    head.hidden = true;
    grid.className = "viewer-grid empty";
    grid.innerHTML = "<p>Your generated images will appear here — you can queue several runs at once.</p>";
    return;
  }

  head.hidden = false;
  $("viewerPrompt").textContent = run.prompt || "(image-only run)";
  $("viewerPrompt").title = run.prompt;
  // Prefer the billed cost the API reported (FLUX 3) once every image is in.
  const billed = (run.jobs || []).map((j) => j.costCredits);
  const c = billed.length === run.n && billed.every((x) => typeof x === "number")
    ? ` · ${+billed.reduce((a, b) => a + b, 0).toFixed(2)} cr`
    : run.cost ? ` · ≈ ${run.cost.credits} cr` : "";
  $("viewerMeta").textContent = `${(run.modelLabel || run.model || "").split("  ")[0]} · ${run.n} image${run.n > 1 ? "s" : ""}${c}`;

  grid.className = `viewer-grid cols-${run.n >= 2 ? 2 : 1}`;
  grid.innerHTML = "";
  for (let i = 0; i < run.n; i++) {
    const job = run.jobs?.[i] || { index: i, status: "pending" };
    grid.appendChild(renderViewerCell(run, job));
  }
}

function renderViewerCell(run, job) {
  const cell = document.createElement("div");
  cell.className = "v-cell";
  if (job.status === "done" && job.image) {
    const img = new Image();
    img.src = job.image;
    img.alt = "generated image";
    img.title = "Click for full screen";
    img.addEventListener("click", () => openLightbox(run, job.index));
    const bar = document.createElement("div");
    bar.className = "v-bar";
    const seedSpan = document.createElement("span");
    seedSpan.textContent = job.seed != null ? `seed ${job.seed}` : "";
    const dl = document.createElement("a");
    dl.textContent = "Download";
    dl.href = job.image;
    dl.download = `flux-${job.seed ?? job.index}.${(job.file || "image.png").split(".").pop()}`;
    bar.append(seedSpan);
    cell.append(img, bar);
    if (job.expandedPrompt) {
      // FLUX 3 expands short prompts and edits (and may add boxes); show what it used.
      const expanded = document.createElement("pre");
      expanded.className = "v-expanded";
      expanded.textContent = job.expandedPrompt;
      expanded.hidden = true;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = "Expanded prompt";
      toggle.addEventListener("click", () => {
        expanded.hidden = !expanded.hidden;
        cell.classList.toggle("show-expanded", !expanded.hidden);
      });
      bar.append(toggle);
      cell.append(expanded);
    }
    bar.append(dl);
  } else if (job.status === "failed") {
    cell.classList.add("failed");
    const msg = document.createElement("p");
    msg.textContent = job.error || "Generation failed.";
    cell.appendChild(msg);
  } else {
    cell.classList.add("waiting");
    cell.innerHTML = job.status === "running"
      ? '<div class="spinner"></div>'
      : '<span class="queued">queued</span>';
  }
  return cell;
}

// ---- lightbox (full-screen) -------------------------------------------------
let lbItems = [];
let lbIndex = 0;

function openLightbox(run, jobIndex) {
  const done = (run.jobs || []).filter((j) => j.status === "done" && j.image);
  lbItems = done.map((j) => ({
    src: j.image,
    seed: j.seed,
    file: j.file || "image.png",
    prompt: run.prompt || "",
  }));
  lbIndex = Math.max(0, done.findIndex((j) => j.index === jobIndex));
  if (!lbItems.length) return;
  renderLightbox();
  $("lightbox").hidden = false;
  document.body.classList.add("modal-open");
}

function renderLightbox() {
  const item = lbItems[lbIndex];
  if (!item) return;
  $("lbImg").src = item.src;
  const pos = lbItems.length > 1 ? `${lbIndex + 1}/${lbItems.length} · ` : "";
  const seed = item.seed != null ? ` · seed ${item.seed}` : "";
  $("lbInfo").textContent = `${pos}${item.prompt}${seed}`;
  const dl = $("lbDownload");
  dl.href = item.src;
  dl.download = `flux-${item.seed ?? lbIndex}.${item.file.split(".").pop()}`;
  const multi = lbItems.length > 1;
  $("lbPrev").hidden = !multi;
  $("lbNext").hidden = !multi;
}

function closeLightbox() {
  $("lightbox").hidden = true;
  document.body.classList.remove("modal-open");
}

function stepLightbox(delta) {
  lbIndex = (lbIndex + delta + lbItems.length) % lbItems.length;
  renderLightbox();
}

$("lbClose").addEventListener("click", closeLightbox);
$("lbPrev").addEventListener("click", () => stepLightbox(-1));
$("lbNext").addEventListener("click", () => stepLightbox(1));
$("lightbox").addEventListener("click", (e) => {
  if (e.target === $("lightbox")) closeLightbox(); // backdrop only
});
document.addEventListener("keydown", (e) => {
  if ($("lightbox").hidden) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft" && lbItems.length > 1) stepLightbox(-1);
  if (e.key === "ArrowRight" && lbItems.length > 1) stepLightbox(1);
});

// ---- history + live updates -------------------------------------------------
async function loadHistory() {
  let history;
  try {
    history = await (await fetch("/api/runs")).json(); // newest first
  } catch {
    return; // history is best-effort
  }
  runs.clear();
  for (const run of history) runs.set(run.id, run);
  for (const id of [...checkedIds]) if (!runs.has(id)) checkedIds.delete(id);
  updateDeleteBar();
  rebuildGallery(history);
  if (!selectedId || !runs.has(selectedId)) selectedId = history[0]?.id ?? null;
  selectRun(selectedId);
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = async (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }

    if (ev.type === "run.done") { refreshCreditsSoon(); return; }
    if (ev.type === "runs.deleted") { removeRunsLocally(ev.ids || []); return; }
    if (!ev.runId) return;

    const run = runs.get(ev.runId);
    if (!run) { await loadHistory(); return; } // run from another tab / before reload

    if (!Array.isArray(run.jobs)) run.jobs = [];
    if (ev.type === "job.started") run.jobs[ev.jobIndex] = { index: ev.jobIndex, status: "running" };
    if (ev.type === "job.done" || ev.type === "job.failed") run.jobs[ev.jobIndex] = { index: ev.jobIndex, ...ev.job };
    upsertRun(run);
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

// ---- generate ----------------------------------------------------------
// The server also drops fields the model doesn't support; aspect_ratio is
// gated here because FLUX.2 accepts it too, but there width/height win.
function buildParams() {
  const params = { prompt: $("prompt").value.trim() };
  if (modelSupports("resolution")) {
    params.aspect_ratio = $("aspect_ratio").value;
    params.resolution = $("resolution").value;
    params.grounding = $("grounding").checked;
  } else {
    Object.assign(params, currentSize(), {
      negative_prompt: $("negative_prompt").value.trim(),
      output_format: $("output_format").value,
      guidance: Number($("guidance").value),
      steps: Number($("steps").value),
    });
    const seed = $("seed").value.trim();
    if (seed !== "") params.seed = Number(seed);
    if ($("prompt_upsampling").checked) params.prompt_upsampling = true;
  }
  if (refImages.length) params.input_images = refImages.slice(0, maxRefImages()).map((r) => r.b64);
  return params;
}

// Catch FLUX 3 input errors before spending a queue slot on them.
function validateRefs() {
  if (!modelSupports("images")) return null;
  for (const [i, r] of refImages.entries()) {
    if (r.mp > FLUX3_MAX_REF_MP) return `Image ${i + 1} is ${r.mp.toFixed(1)} MP — FLUX 3 accepts up to 16 MP. Downscale it first.`;
    if (Math.min(r.width, r.height) < FLUX3_MIN_REF_SIDE) return `Image ${i + 1} is ${r.width}×${r.height} — FLUX 3 needs at least 256×256.`;
  }
  return null;
}

$("generate").addEventListener("click", async () => {
  const params = buildParams();
  const n = Number($("count").value);

  if (currentModel()?.requiresPrompt && !params.prompt) {
    return setStatus("Enter a prompt — with reference images, describe what to do with them.", true);
  }
  if (!params.prompt && !refImages.length) {
    return setStatus("Enter a prompt (or add a reference image).", true);
  }
  const refError = validateRefs();
  if (refError) return setStatus(refError, true);
  setStatus("Queuing run…");

  try {
    const resp = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: $("model").value, params, n, input_mp: totalInputMp() }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error + (data.detail ? `\n${typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)}` : ""));
    }
    upsertRun(data.run);
    selectRun(data.run.id);
    setStatus("Queued — feel free to start another run.");
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
});

init();
