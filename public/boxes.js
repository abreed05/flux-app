// Visual editor for FLUX 3 bounding boxes.
//
// FLUX 3 takes boxes inside the prompt: a caption that names each element as
// <id>, then a JSON array of rows (https://docs.bfl.ai/flux_3/flux3_image_bounding_boxes).
//   layout (no reference images): { id, bbox, desc }
//   edit (with reference images): { id, from, src_bbox, tgt_bbox, desc }
// Every box is [top, left, bottom, right] in integers 0–1000 of its frame:
// src_bbox of the reference named by `from`, tgt_bbox / bbox of the output.
// Edit rows come in four kinds, set by which fields are null:
//   keep   from=ref, src = tgt   stays exactly where it is
//   move   from=ref, src ≠ tgt   moves or resizes
//   new    from=null, src=null   generates desc at tgt (add, replace, recolor)
//   remove from=ref, tgt=null    removed; the background fills in
const BoxEditor = (() => {
  const $ = (id) => document.getElementById(id);

  const COLORS = ["#e8b04a", "#6fb3d9", "#e0708a", "#8fcf7a", "#b99af0", "#f08b5b",
    "#5fd0c0", "#d9d36f", "#9fb0c8", "#f2a3c7", "#7aa0f0", "#c7e07a"];
  const KINDS = { keep: "Keep", move: "Move", new: "New", remove: "Remove" };
  const MIN_DRAG = 8; // grid units; a smaller drag on empty space is a click, not a box
  const ID_RE = /^[A-Za-z0-9_]+$/;

  // ctx: { refs: () => [{ dataUrl, width, height }], prompt: <textarea>, aspect: <select>, onChange() }
  let ctx = null;
  let rows = [];        // { id, desc, kind, from: ref index | null, src, tgt, color }; boxes are { t, l, b, r }
  let view = "out";     // "out" (output frame) or a reference index
  let selected = null;  // row
  let drag = null;
  let items = [];       // boxes currently drawn on the stage: { row, which: "src" | "tgt" }
  let colorSeq = 0;

  const copy = (b) => (b ? { ...b } : null);
  const clamp = (v) => Math.max(0, Math.min(1000, Math.round(v)));
  const toArr = (b) => (b ? [b.t, b.l, b.b, b.r] : null);
  const fromArr = (a) => (Array.isArray(a) && a.length === 4 && a.every(Number.isFinite)
    ? { t: a[0], l: a[1], b: a[2], r: a[3] } : null);
  const same = (a, b) => !!a && !!b && a.t === b.t && a.l === b.l && a.b === b.b && a.r === b.r;
  const fmt = (b) => `[${toArr(b).join(", ")}]`;

  const isEdit = () => ctx.refs().length > 0;
  const isOpen = () => !$("boxModal").hidden;
  // With aspect "auto" the output keeps image 1's framing, so the output view
  // can show image 1 and its source boxes directly.
  const outIsImage1 = () => isEdit() && ctx.aspect.value === "auto";

  // ---- geometry ------------------------------------------------------------
  function frame() {
    const refs = ctx.refs();
    if (view !== "out") return { w: refs[view].width, h: refs[view].height, bg: refs[view].dataUrl };
    if (ctx.aspect.value === "auto") {
      return refs.length ? { w: refs[0].width, h: refs[0].height, bg: refs[0].dataUrl } : { w: 1, h: 1 };
    }
    const [w, h] = ctx.aspect.value.split(":").map(Number);
    return { w, h };
  }

  function boxesInView() {
    const out = [];
    for (const row of rows) {
      if (view === "out") {
        if (row.src && row.from === 0 && outIsImage1() && row.kind !== "keep") out.push({ row, which: "src" });
        if (row.tgt) out.push({ row, which: "tgt" });
      } else if (row.from === view && row.src) {
        out.push({ row, which: "src" });
      }
    }
    return out;
  }

  // Keep rows have one box in two roles, so editing either moves both.
  function setBox(row, which, box) {
    if (row.kind === "keep") { row.src = copy(box); row.tgt = copy(box); }
    else row[which] = box;
  }

  function gridPoint(e) {
    const rect = $("bxStage").getBoundingClientRect();
    return { y: ((e.clientY - rect.top) / rect.height) * 1000, x: ((e.clientX - rect.left) / rect.width) * 1000 };
  }

  // ---- rows ----------------------------------------------------------------
  function nextId() {
    for (let i = 1; ; i++) if (!rows.some((r) => r.id === `element_${i}`)) return `element_${i}`;
  }

  function newRow(fields) {
    return { id: nextId(), desc: "", color: COLORS[colorSeq++ % COLORS.length], ...fields };
  }

  // A box drawn on an image marks an existing element (Keep); one drawn on a
  // blank output frame places something new.
  function createRow(box) {
    let row;
    if (!isEdit()) row = newRow({ kind: "new", from: null, src: null, tgt: box });
    else if (view !== "out") row = newRow({ kind: "keep", from: view, src: box, tgt: copy(box) });
    else if (outIsImage1()) row = newRow({ kind: "keep", from: 0, src: box, tgt: copy(box) });
    else row = newRow({ kind: "new", from: null, src: null, tgt: box });
    rows.push(row);
    return row;
  }

  function setKind(row, kind) {
    const anyBox = copy(row.src || row.tgt);
    if (kind === "new") {
      row.from = null;
      row.src = null;
      row.tgt = row.tgt || anyBox;
    } else {
      if (row.from == null) row.from = view === "out" ? 0 : view;
      row.src = row.src || anyBox;
      if (kind === "keep") row.tgt = copy(row.src);
      if (kind === "move") row.tgt = row.tgt || copy(row.src);
      if (kind === "remove") row.tgt = null;
    }
    row.kind = kind;
  }

  function removeRow(row) {
    rows = rows.filter((r) => r !== row);
    if (selected === row) selected = null;
    renderAll();
    changed();
  }

  function rowFromJson(o) {
    if (!o || typeof o !== "object" || typeof o.id !== "string") return null;
    const base = { id: o.id, desc: typeof o.desc === "string" ? o.desc : "" };
    if ("bbox" in o) {
      const tgt = fromArr(o.bbox);
      return tgt && newRow({ ...base, kind: "new", from: null, src: null, tgt });
    }
    const m = /^ref_image_(\d+)$/.exec(o.from ?? "");
    const from = m ? Number(m[1]) : null;
    const src = fromArr(o.src_bbox);
    const tgt = fromArr(o.tgt_bbox);
    if (from == null) return tgt && newRow({ ...base, kind: "new", from: null, src: null, tgt });
    if (!src) return null;
    const kind = !tgt ? "remove" : same(src, tgt) ? "keep" : "move";
    return newRow({ ...base, kind, from, src, tgt });
  }

  function rowToJson(row) {
    if (!isEdit()) return { id: row.id, bbox: toArr(row.tgt || row.src), desc: row.desc };
    return {
      id: row.id,
      from: row.from == null ? null : `ref_image_${row.from}`,
      src_bbox: toArr(row.src),
      tgt_bbox: toArr(row.tgt),
      desc: row.desc,
    };
  }

  // Split "caption [{...}, ...]" into the caption and parsed rows, for prompts
  // pasted from the BFL docs. Rows hold only number arrays, so the first "[{"
  // whose remainder parses as an array of rows is the start of the table.
  function splitPrompt(prompt) {
    for (let i = prompt.indexOf("[{"); i !== -1; i = prompt.indexOf("[{", i + 1)) {
      let parsed;
      try { parsed = JSON.parse(prompt.slice(i)); } catch { continue; }
      if (!Array.isArray(parsed) || !parsed.length) continue;
      const imported = parsed.map(rowFromJson);
      if (imported.every(Boolean)) return { caption: prompt.slice(0, i).trimEnd(), rows: imported };
    }
    return null;
  }

  // ---- checks ----------------------------------------------------------------
  // Problems the API would reject or that make a row meaningless; these block
  // generation.
  function errors() {
    const out = [];
    const seen = new Set();
    const nRefs = ctx.refs().length;
    for (const row of rows) {
      if (!row.id) out.push("Every box needs an id.");
      else if (!ID_RE.test(row.id)) out.push(`Box id “${row.id}” may only use letters, digits and _.`);
      else if (seen.has(row.id)) out.push(`Box id “${row.id}” is used twice.`);
      seen.add(row.id);
      if (row.from != null && row.from >= nRefs) out.push(`“${row.id}” comes from image ${row.from + 1}, which isn't attached.`);
      if (!isEdit() && row.kind === "remove") out.push(`“${row.id}” is a Remove row but there is no reference image.`);
    }
    return [...new Set(out)];
  }

  // Things the docs advise against; shown in the editor but not blocking.
  function warnings() {
    const out = [];
    const caption = ctx.prompt.value;
    const missing = rows.filter((r) => r.id && !caption.includes(`<${r.id}>`)).map((r) => `<${r.id}>`);
    if (missing.length) out.push(`Name each box in the prompt: ${missing.join(", ")} ${missing.length > 1 ? "aren't" : "isn't"} mentioned.`);
    const noDesc = rows.filter((r) => !r.desc.trim()).map((r) => r.id);
    if (noDesc.length) out.push(`Describe what each box should look like: ${noDesc.join(", ")} ${noDesc.length > 1 ? "have" : "has"} no description.`);
    if (!isEdit() && rows.length && ctx.aspect.value === "auto") {
      out.push("Aspect ratio is Auto, which renders square here. Pick the ratio you designed the boxes for.");
    }
    return out;
  }

  // ---- rendering ---------------------------------------------------------------
  function renderTabs() {
    const refs = ctx.refs();
    // One reference at Auto: the output frame *is* image 1, so no tabs needed.
    const tabs = !refs.length || (refs.length === 1 && ctx.aspect.value === "auto") ? []
      : ["out", ...refs.map((_, k) => k).filter((k) => !(k === 0 && outIsImage1()))];
    if (view !== "out" && !tabs.includes(view)) view = "out";
    const box = $("bxTabs");
    box.hidden = tabs.length === 0;
    box.innerHTML = "";
    for (const t of tabs) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = t === "out" ? (outIsImage1() ? "Output · image 1" : "Output") : `Image ${t + 1}`;
      b.setAttribute("aria-pressed", String(t === view));
      b.addEventListener("click", () => { view = t; renderAll(); });
      box.appendChild(b);
    }
  }

  function renderHelp() {
    let help;
    if (!isEdit()) {
      help = "Drag to draw a box for each element of a new image. The grid stretches with the frame, so pick the aspect ratio first.";
    } else if (view === "out" && outIsImage1()) {
      help = "Drag over each element of image 1 to mark it (Keep). Then switch a row to Move and drag its solid box, to New to regenerate it from the description, or to Remove to erase it.";
    } else if (view === "out") {
      help = "Output frame. Draw boxes for new elements and place the targets of moved ones. Mark existing elements on the image tabs.";
    } else {
      help = `Drag over elements of image ${view + 1} to use them (from ref_image_${view}). Their target boxes live on the Output tab.`;
    }
    $("bxHelp").textContent = `${help} Move a box by its label or edge; select it to resize from the corners.`;
  }

  function sizeStage() {
    const f = frame();
    const wrap = $("bxStageWrap").getBoundingClientRect();
    const ar = f.w / f.h;
    const width = Math.max(50, Math.min(wrap.width, wrap.height * ar));
    const stage = $("bxStage");
    stage.style.width = `${width}px`;
    stage.style.height = `${width / ar}px`;
    const bg = $("bxBg");
    if (f.bg) {
      if (bg.getAttribute("src") !== f.bg) bg.src = f.bg;
      bg.hidden = false;
    } else {
      bg.hidden = true;
    }
    stage.classList.toggle("blank", !f.bg);
  }

  function boxEl(b, color, cls, label) {
    const el = document.createElement("div");
    el.className = `bx-box ${cls}`;
    el.style.cssText = `--c:${color};top:${b.t / 10}%;left:${b.l / 10}%;height:${(b.b - b.t) / 10}%;width:${(b.r - b.l) / 10}%`;
    if (b.t < 40) el.classList.add("label-inside");
    const tag = document.createElement("span");
    tag.textContent = label;
    tag.dataset.grip = "";
    el.appendChild(tag);
    return el;
  }

  function renderStage() {
    const layer = $("bxLayer");
    layer.innerHTML = "";
    items = boxesInView();
    items.forEach((item, i) => {
      const { row, which } = item;
      const isSel = row === selected;
      const ghost = which === "src" && view === "out"; // a moved/removed element's original spot
      const label = row.kind === "remove" ? `${row.id} · remove`
        : ghost || (which === "src" && row.kind === "move") ? `${row.id} · from` : row.id;
      const el = boxEl(row[which], row.color,
        `kind-${row.kind} ${which}${ghost ? " ghost" : ""}${isSel ? " selected" : ""}`, label);
      el.dataset.i = i;
      if (isSel) {
        for (const c of ["nw", "ne", "sw", "se"]) {
          const h = document.createElement("i");
          h.className = `bx-handle ${c}`;
          h.dataset.corner = c;
          el.appendChild(h);
        }
      }
      layer.appendChild(el);
    });
    if (drag?.mode === "create" && drag.box) {
      layer.appendChild(boxEl(drag.box, "#ffffff", "drawing", nextId()));
    }
  }

  function coordsText(row) {
    if (!isEdit()) return fmt(row.tgt || row.src);
    const img = row.from == null ? "" : `image ${row.from + 1} `;
    switch (row.kind) {
      case "keep": return `${img}${fmt(row.src)} · unchanged`;
      case "move": return `${img}${fmt(row.src)} → ${fmt(row.tgt)}`;
      case "remove": return `${img}${fmt(row.src)} → removed`;
      default: return `new at ${fmt(row.tgt)}`;
    }
  }

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function renderRows() {
    const list = $("bxRows");
    list.innerHTML = "";
    const edit = isEdit();
    const refs = ctx.refs();
    if (!rows.length) {
      list.appendChild(el("li", { className: "bx-empty", textContent: "No boxes yet. Drag on the image to add one." }));
      return;
    }
    rows.forEach((row, i) => {
      const li = el("li", { className: `bx-row${row === selected ? " selected" : ""}` });
      li.dataset.i = i;
      li.style.setProperty("--c", row.color);
      li.addEventListener("focusin", () => select(row));
      li.addEventListener("pointerdown", () => select(row));

      const id = el("input", { type: "text", value: row.id, className: "bx-id", title: "Element id, used as <id> in the prompt", spellcheck: false });
      id.addEventListener("input", () => { row.id = id.value.trim(); renderStage(); renderMeta(); changed(); });

      const top = el("div", { className: "bx-row-top" }, el("span", { className: "bx-swatch" }), id);

      if (edit) {
        const kind = el("select", { className: "bx-kind", title: "What happens to this element" });
        for (const [k, label] of Object.entries(KINDS)) kind.appendChild(el("option", { value: k, textContent: label, selected: k === row.kind }));
        kind.addEventListener("change", () => { setKind(row, kind.value); selected = row; renderAll(); changed(); });
        top.appendChild(kind);
        if (row.kind !== "new") {
          const from = el("select", { className: "bx-from", title: "Reference image this element comes from" });
          refs.forEach((_, k) => from.appendChild(el("option", { value: k, textContent: `img ${k + 1}`, selected: k === row.from })));
          from.addEventListener("change", () => { row.from = Number(from.value); renderAll(); changed(); });
          top.appendChild(from);
        }
      }

      const tok = el("button", { type: "button", className: "bx-icon", textContent: "‹›", title: `Insert <${row.id}> into the prompt` });
      tok.addEventListener("click", () => insertToken(`<${row.id}>`));
      const del = el("button", { type: "button", className: "bx-icon", textContent: "×", title: "Delete box" });
      del.addEventListener("click", () => removeRow(row));
      top.append(tok, del);

      const desc = el("textarea", {
        className: "bx-desc",
        rows: 2,
        value: row.desc,
        placeholder: row.kind === "keep" ? "What this element looks like now…"
          : row.kind === "remove" ? "What is being removed…" : "What it should look like…",
      });
      desc.addEventListener("input", () => { row.desc = desc.value; renderMeta(); changed(); });

      li.append(top, desc, el("div", { className: "bx-coords" }));
      list.appendChild(li);
    });
  }

  // Cheap refresh for anything that changes while typing or dragging.
  function renderMeta() {
    document.querySelectorAll("#bxRows .bx-row").forEach((li) => {
      const row = rows[Number(li.dataset.i)];
      if (row) li.querySelector(".bx-coords").textContent = coordsText(row);
    });
    $("bxJson").textContent = rows.length ? JSON.stringify(rows.map(rowToJson), null, 2) : "(none)";
    const problems = [...errors(), ...warnings()];
    $("bxWarn").hidden = problems.length === 0;
    $("bxWarn").innerHTML = "";
    for (const p of problems) $("bxWarn").appendChild(el("div", { textContent: p }));
    $("bxMode").textContent = isEdit() ? "Edit · boxes refer to your reference images" : "Layout · new image";
    renderSummary();
  }

  function renderTokens() {
    const box = $("bxTokens");
    box.innerHTML = "";
    const refs = ctx.refs();
    if (!refs.length) return;
    box.appendChild(el("span", { textContent: "Insert:" }));
    refs.forEach((_, k) => {
      const b = el("button", { type: "button", className: "bx-chip", textContent: `<ref_image_${k}>`, title: `Refers to image ${k + 1}` });
      b.addEventListener("click", () => insertToken(`<ref_image_${k}>`));
      box.appendChild(b);
    });
  }

  function renderSummary() {
    const n = rows.length;
    $("boxSummary").textContent = n ? `${n} box${n > 1 ? "es" : ""} · ${isEdit() ? "edit" : "layout"}` : "No boxes";
    $("boxClear").hidden = n === 0;
  }

  function renderAll() {
    renderTabs();
    renderHelp();
    renderRows();
    renderMeta();
    renderTokens();
    if (isOpen()) { sizeStage(); renderStage(); }
  }

  function select(row) {
    if (selected === row) return;
    selected = row;
    document.querySelectorAll("#bxRows .bx-row").forEach((li) =>
      li.classList.toggle("selected", rows[Number(li.dataset.i)] === row));
    // Jump to the tab where the selected row's box is visible.
    if (row && !boxesInView().some((it) => it.row === row)) {
      if (row.tgt) view = "out";
      else if (row.from != null) view = row.from;
      renderTabs();
      renderHelp();
      sizeStage();
    }
    renderStage();
  }

  function insertToken(tok) {
    const ta = $("bxCaption");
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const pad = start > 0 && !/\s$/.test(ta.value.slice(0, start)) ? " " : "";
    ta.setRangeText(pad + tok, start, end, "end");
    ta.focus();
    ctx.prompt.value = ta.value;
    renderMeta();
  }

  function changed() { ctx.onChange?.(); }

  // ---- pointer interaction ---------------------------------------------------
  // A box moves by its label tab or its edge, and resizes by the corner
  // handles of the selected box. Dragging inside a box draws a new one, since
  // layouts nearly always have a full-frame background box underneath
  // everything; a click without a drag selects the box under the pointer.
  const EDGE_PX = 8;

  function onEdge(e, node) {
    const r = node.getBoundingClientRect();
    return Math.min(e.clientX - r.left, r.right - e.clientX, e.clientY - r.top, r.bottom - e.clientY) <= EDGE_PX;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const p = gridPoint(e);
    const boxNode = e.target.closest("[data-i]");
    const item = boxNode && items[Number(boxNode.dataset.i)];
    const corner = e.target.dataset.corner;
    if (item && (corner || e.target.dataset.grip != null || onEdge(e, boxNode))) {
      select(item.row);
      drag = { mode: corner ? "resize" : "move", corner, item, start: copy(item.row[item.which]), p0: p };
    } else {
      drag = { mode: "create", p0: p, box: null, hit: item?.row ?? null };
    }
    $("bxStage").setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    const p = gridPoint(e);
    $("bxCursor").textContent = `top ${clamp(p.y)} · left ${clamp(p.x)}`;
    if (!drag) {
      const boxNode = e.target.closest("[data-i]");
      $("bxStage").style.cursor = boxNode && !e.target.dataset.corner && e.target.dataset.grip == null && onEdge(e, boxNode) ? "move" : "";
      return;
    }
    if (drag.mode === "create") {
      const a = drag.p0;
      drag.box = { t: clamp(Math.min(a.y, p.y)), l: clamp(Math.min(a.x, p.x)), b: clamp(Math.max(a.y, p.y)), r: clamp(Math.max(a.x, p.x)) };
    } else if (drag.mode === "move") {
      const s = drag.start;
      const dy = Math.max(-s.t, Math.min(1000 - s.b, p.y - drag.p0.y));
      const dx = Math.max(-s.l, Math.min(1000 - s.r, p.x - drag.p0.x));
      setBox(drag.item.row, drag.item.which,
        { t: Math.round(s.t + dy), l: Math.round(s.l + dx), b: Math.round(s.b + dy), r: Math.round(s.r + dx) });
    } else {
      const b = { ...drag.start };
      if (drag.corner.includes("n")) b.t = clamp(p.y);
      if (drag.corner.includes("s")) b.b = clamp(p.y);
      if (drag.corner.includes("w")) b.l = clamp(p.x);
      if (drag.corner.includes("e")) b.r = clamp(p.x);
      setBox(drag.item.row, drag.item.which,
        { t: Math.min(b.t, b.b), l: Math.min(b.l, b.r), b: Math.max(b.t, b.b), r: Math.max(b.l, b.r) });
    }
    renderStage();
    renderMeta();
  }

  function onPointerUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === "create") {
      if (d.box && d.box.b - d.box.t >= MIN_DRAG && d.box.r - d.box.l >= MIN_DRAG) {
        const row = createRow(d.box);
        selected = row;
        renderRows();
        renderMeta();
        renderStage();
        $("bxRows").querySelector(".bx-row.selected .bx-desc")?.focus({ preventScroll: true });
      } else {
        select(d.hit);
        renderStage();
        $("bxRows").querySelector(".bx-row.selected")?.scrollIntoView({ block: "nearest" });
      }
    }
    changed();
  }

  // ---- open / close ------------------------------------------------------------
  function open() {
    // Pick up a box table pasted at the end of the prompt (e.g. from the BFL docs).
    if (!rows.length) {
      const split = splitPrompt(ctx.prompt.value);
      if (split) {
        rows = split.rows;
        ctx.prompt.value = split.caption;
      }
    }
    $("bxCaption").value = ctx.prompt.value;
    $("bxAspect").value = ctx.aspect.value;
    $("boxModal").hidden = false;
    document.body.classList.add("modal-open");
    renderAll();
  }

  function close() {
    $("boxModal").hidden = true;
    document.body.classList.remove("modal-open");
    drag = null;
    changed();
  }

  function init(context) {
    ctx = context;

    // Mirror the main aspect-ratio select so the frame can be set here too.
    $("bxAspect").innerHTML = ctx.aspect.innerHTML;
    $("bxAspect").addEventListener("change", () => {
      ctx.aspect.value = $("bxAspect").value;
      ctx.aspect.dispatchEvent(new Event("change"));
    });
    ctx.aspect.addEventListener("change", () => {
      $("bxAspect").value = ctx.aspect.value;
      if (isOpen()) renderAll();
    });

    $("bxCaption").addEventListener("input", () => { ctx.prompt.value = $("bxCaption").value; renderMeta(); });

    const stage = $("bxStage");
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", onPointerUp);
    stage.addEventListener("pointerleave", () => { if (!drag) $("bxCursor").textContent = ""; });

    $("boxOpen").addEventListener("click", open);
    $("bxClose").addEventListener("click", close);
    $("boxModal").addEventListener("click", (e) => { if (e.target === $("boxModal")) close(); });
    $("boxClear").addEventListener("click", () => {
      if (!confirm("Remove all boxes?")) return;
      clear();
    });
    window.addEventListener("resize", () => { if (isOpen()) { sizeStage(); renderStage(); } });
    document.addEventListener("keydown", (e) => {
      if (!isOpen()) return;
      if (e.key === "Escape") close();
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
      if ((e.key === "Delete" || e.key === "Backspace") && selected && !typing) {
        e.preventDefault();
        removeRow(selected);
      }
    });
    renderSummary();
  }

  function clear() {
    rows = [];
    selected = null;
    renderAll();
    changed();
  }

  // A reference image was removed: rows from it lose their source (Remove rows
  // go entirely; the rest become New), and later images shift down by one.
  function refRemoved(index) {
    rows = rows.filter((r) => !(r.from === index && r.kind === "remove"));
    for (const r of rows) {
      if (r.from === index) { r.kind = "new"; r.from = null; r.tgt = r.tgt || r.src; r.src = null; }
      else if (r.from > index) r.from -= 1;
    }
    if (typeof view === "number" && view >= index) view = "out";
    refsChanged();
  }

  function refsChanged() {
    if (isOpen()) renderAll();
    else renderMeta();
  }

  return {
    init,
    open,
    clear,
    refRemoved,
    refsChanged,
    count: () => rows.length,
    // Blocking problems, or null when the boxes are fine to send.
    validate: () => (rows.length ? errors()[0] ?? null : null),
    // The prompt FLUX 3 receives: caption, a space, then the row table.
    applyTo: (caption) => (rows.length ? `${caption} ${JSON.stringify(rows.map(rowToJson))}` : caption),
  };
})();
