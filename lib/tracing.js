import { trace, context, propagation, SpanStatusCode } from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";

// Until startTracing() registers a provider this is a no-op tracer, so the
// span helpers below are safe to call whether or not tracing is configured.
export const tracer = trace.getTracer("flux-app");

// Tracing is opt-in: with no OTLP endpoint set, nothing is started or exported.
// The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS itself and posts
// to <endpoint>/v1/traces.
export function startTracing(serviceName) {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return;

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME || serviceName,
      "service.namespace": "flux-app",
      // Phoenix files traces under this project; other backends ignore it.
      "openinference.project.name": process.env.PHOENIX_PROJECT_NAME || "flux-app",
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register(); // also installs W3C propagation + async context

  const flush = () => provider.shutdown().catch(() => { /* collector unreachable */ });
  process.once("SIGINT", flush);
  process.once("SIGTERM", flush);
  console.log(`Tracing enabled (${serviceName})`);
}

// Run fn inside a new active span; records a thrown error and always ends it.
export function withSpan(name, attributes, fn, { kind, parent } = {}) {
  return tracer.startActiveSpan(name, { kind, attributes }, parent ?? context.active(), async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(e.message || e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

// Trace context rides in AMQP message headers so a worker's job span joins
// the trace of the request that queued it.
export function injectContext(headers = {}) {
  propagation.inject(context.active(), headers);
  return headers;
}

export function extractContext(headers = {}) {
  // amqplib hands header values back as Buffers or strings depending on type.
  const carrier = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
  return propagation.extract(context.active(), carrier);
}
