# ⚡ FLUX Image Studio

A web app for generating images with the **Black Forest Labs FLUX.2 API**.
The browser GUI talks to a small Node backend that proxies the API — so your API key
stays on the server — and generation runs through a **RabbitMQ job queue** consumed by
worker processes, so you can kick off multiple runs simultaneously and watch them all
complete live.

## Features

- Model picker: **FLUX.2 [flex]**, **[pro]**, **[klein] 9B**, **[max]**
- Prompt + **negative prompt**
- **Multi-reference image-to-image**: up to **8 reference images**, referenced by number
  in the prompt — *“the subject from image 1 in the environment from image 2”*
- **Concurrent runs**: queue as many runs as you like; each appears as a live-updating
  card in the feed (RabbitMQ + scalable workers)
- **Persistent history**: images and run metadata are written to disk (a Docker volume),
  so the gallery survives restarts
- **Live credits badge**: your remaining BFL balance in the top bar, refreshed after runs
- **Guidance scale** and **steps** sliders — see note below
- **Batch generation**: 1–4 images per run (each gets a distinct seed)
- **Live credit-cost estimate** that updates with model, resolution, reference images, and count
- Size presets + custom width/height, output format (PNG/JPEG), seed control, prompt upsampling

## Architecture

```
browser ──POST /api/runs──▶ api service ──publish──▶ RabbitMQ [flux.jobs]
        ◀── run id ─────────┘   ▲                        │
        ◀── SSE /api/events ────┘ (flux.events)          ▼
                                                  worker service(s)
                                                    │──▶ api.bfl.ai  (submit + poll)
                                                    └──▶ outputs volume (images + JSON)
```

- One run = *n* jobs (one message per image), so a 4-image run is parallelized across
  workers automatically.
- Workers ack a message only after the result is persisted; if a worker dies mid-job,
  RabbitMQ redelivers it. Moderated/4xx failures are recorded as failed, not retried.
- The api service relays worker events to the browser over Server-Sent Events.
- No Redis: RabbitMQ carries jobs/events, the shared volume carries state, and nothing
  here benefits from a cache.

## Quick start (Docker)

1. **Get an API key** at <https://dashboard.bfl.ai>.
2. ```bash
   cp .env.example .env     # paste your BFL_API_KEY
   docker compose up --build
   ```
3. Open <http://localhost:3000>. RabbitMQ's management UI is at
   <http://localhost:15672> (guest/guest).

Scale generation throughput with more workers:

```bash
docker compose up -d --scale worker=3
```

Each worker also runs `WORKER_CONCURRENCY` (default 2) jobs in parallel.

## Local development (no Docker for the app)

You still need RabbitMQ; the easiest way is to run just that one service:

```bash
docker compose up -d rabbitmq
npm install
npm start          # api on :3000
npm run worker     # in a second terminal
```

Requires **Node 18+**. `AMQP_URL` defaults to `amqp://localhost` and outputs go to
`./outputs/`.

## Tracing (optional)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` on the api and workers to export OpenTelemetry
traces over OTLP/HTTP. Each run is one trace: `flux.run` (the request) →
`flux.job` (one per image, joined across RabbitMQ via message headers) →
`bfl.generate` with `bfl.submit` / `bfl.poll` / `bfl.download` children. Spans
carry the prompt, model, parameters, seed and estimated cost using the attribute
names Arize Phoenix and Langfuse understand; reference images are never exported.
With the variable unset, tracing is off.

### Guidance scale & steps

These sliders are only adjustable on **FLUX.2 [flex]** and **[klein]**. **[pro]** and
**[max]** are distilled models that set guidance/steps internally, so the sliders are
greyed out (with an on-screen note) when those models are selected. [flex] is the
default so the controls are live out of the box.

### Multi-reference prompting

Upload up to 8 reference images; the UI labels them **image 1 … image 8** and they are
sent as `input_image`, `input_image_2`, … `input_image_8`. Refer to them by number:

> “The person from image 1 wearing the jacket from image 2, in the style of image 3.”

### Cost estimates & credits

Costs are shown as an **estimate** (`≈`), computed from BFL's megapixel-based pricing
(1 credit = $0.01). The rates live in the `MODELS` map in `lib/bfl.js` (`price:
{ firstMp, extraMp, inputMp }`). [max]'s rates are exact; the others use the published
1-MP "from" price with an approximate extra-MP rate — confirm exact figures at
<https://bfl.ai/pricing>. Reference images bill by their input megapixels.

The top-bar badge shows your real remaining balance via `GET /v1/credits` and refreshes
a moment after each run completes.

## ⚠️ Verify the model endpoint slugs

FLUX.2 is new and BFL occasionally adjusts endpoint paths. The model → path map lives
in **`lib/bfl.js`** in the `MODELS` object:

```js
"flux-2-pro":      { path: "/v1/flux-2-pro", ... },
"flux-2-flex":     { path: "/v1/flux-2-flex", ... },
"flux-2-klein-9b": { path: "/v1/flux-2-klein-9b", ... },
"flux-2-max":      { path: "/v1/flux-2-max", ... },
```

If a request 404s, check the current path/params in the official docs and update the
`path` (and the `supports` set, which controls which parameters are forwarded) there.
Docs: <https://docs.bfl.ai> · Integration guide: <https://docs.bfl.ml/api_integration/integration_guidelines>

> Note: `negative_prompt` is forwarded when present, but not every FLUX.2 model honors
> it — models that ignore unknown fields will simply skip it.
