import amqp from "amqplib";
import { sleep } from "./bfl.js";
import { injectContext } from "./tracing.js";

export const AMQP_URL = process.env.AMQP_URL || "amqp://localhost";
export const JOBS_QUEUE = "flux.jobs";
export const EVENTS_EXCHANGE = "flux.events";

// A self-healing connection handle. When the broker goes away (pod restart,
// upgrade, network blip) amqplib closes the channel for good — every later
// publish on it throws IllegalOperationError, forever. So the handle owns the
// channel: callers read `q.channel` at the moment they use it, and `setup` is
// re-run against each new channel to restore consumers.
//
// `attempts`/`delay` govern the first dial only — under docker compose the
// broker may still be booting even after its healthcheck passes for the first
// consumer. Once connected, reconnects retry forever with backoff.
export async function connectQueue({ attempts = 30, delay = 2000, setup } = {}) {
  const q = { conn: null, channel: null, close };
  let closing = false;

  async function dial() {
    const conn = await amqp.connect(AMQP_URL);
    try {
      const channel = await conn.createChannel();
      await channel.assertQueue(JOBS_QUEUE, { durable: true });
      await channel.assertExchange(EVENTS_EXCHANGE, "fanout", { durable: false });

      // amqplib emits 'error' on both objects; unhandled, it takes the process down.
      conn.on("error", (e) => console.error("AMQP connection error:", e.message));
      channel.on("error", (e) => console.error("AMQP channel error:", e.message));
      conn.on("close", () => {
        if (q.conn !== conn) return; // already superseded by a newer connection
        q.conn = null;
        q.channel = null;
        if (closing) return;
        console.warn("AMQP connection closed; reconnecting…");
        reconnect();
      });

      q.conn = conn;
      q.channel = channel;
      if (setup) await setup(channel);
    } catch (e) {
      q.conn = null;
      q.channel = null;
      try { await conn.close(); } catch { /* already closing */ }
      throw e;
    }
  }

  async function reconnect() {
    let wait = delay;
    while (!closing) {
      await sleep(wait);
      if (closing) return;
      try {
        await dial();
        console.log("AMQP reconnected.");
        return;
      } catch (e) {
        wait = Math.min(wait * 2, 30_000);
        console.warn(`AMQP reconnect failed (${e.message}); retrying in ${wait}ms…`);
      }
    }
  }

  async function close() {
    closing = true;
    const { conn, channel } = q;
    q.conn = null;
    q.channel = null;
    try { await channel?.close(); } catch { /* already closing */ }
    try { await conn?.close(); } catch { /* already closing */ }
  }

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await dial();
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      return q;
    } catch (e) {
      lastErr = e;
      console.warn(`AMQP connect failed (${e.message}); retrying in ${delay}ms…`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function publishJob(q, job) {
  if (!q.channel) throw new Error("Message broker unavailable");
  q.channel.sendToQueue(JOBS_QUEUE, Buffer.from(JSON.stringify(job)),
    { persistent: true, headers: injectContext() });
}

// Events are best-effort live UI updates; the client refetches /api/runs anyway.
export function publishEvent(q, event) {
  if (!q.channel) return false;
  q.channel.publish(EVENTS_EXCHANGE, "", Buffer.from(JSON.stringify(event)));
  return true;
}

// Worker side: handler(job, msg, channel) — caller acks/nacks on that channel.
export async function consumeJobs(channel, prefetch, handler) {
  await channel.prefetch(prefetch);
  await channel.consume(JOBS_QUEUE, (msg) => {
    if (!msg) return;
    handler(JSON.parse(msg.content.toString()), msg, channel);
  });
}

// API side: exclusive auto-delete queue bound to the fanout exchange.
export async function consumeEvents(channel, handler) {
  const { queue } = await channel.assertQueue("", { exclusive: true, autoDelete: true });
  await channel.bindQueue(queue, EVENTS_EXCHANGE, "");
  await channel.consume(queue, (msg) => {
    if (!msg) return;
    try { handler(JSON.parse(msg.content.toString())); }
    catch (e) { console.error("Bad event payload:", e.message); }
  }, { noAck: true });
}
