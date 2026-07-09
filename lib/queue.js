import amqp from "amqplib";
import { sleep } from "./bfl.js";

export const AMQP_URL = process.env.AMQP_URL || "amqp://localhost";
export const JOBS_QUEUE = "flux.jobs";
export const EVENTS_EXCHANGE = "flux.events";

// Connect with retry — under docker compose the broker may still be booting
// even after its healthcheck passes for the first consumer.
export async function connectQueue({ attempts = 30, delay = 2000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const conn = await amqp.connect(AMQP_URL);
      const channel = await conn.createChannel();
      await channel.assertQueue(JOBS_QUEUE, { durable: true });
      await channel.assertExchange(EVENTS_EXCHANGE, "fanout", { durable: false });

      conn.on("error", (e) => console.error("AMQP connection error:", e.message));

      const close = async () => {
        try { await channel.close(); } catch { /* already closing */ }
        try { await conn.close(); } catch { /* already closing */ }
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);

      return { conn, channel, close };
    } catch (e) {
      lastErr = e;
      console.warn(`AMQP connect failed (${e.message}); retrying in ${delay}ms…`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function publishJob(channel, job) {
  channel.sendToQueue(JOBS_QUEUE, Buffer.from(JSON.stringify(job)), { persistent: true });
}

export function publishEvent(channel, event) {
  channel.publish(EVENTS_EXCHANGE, "", Buffer.from(JSON.stringify(event)));
}

// Worker side: handler(job, msg) — caller acks/nacks via the returned channel.
export async function consumeJobs(channel, prefetch, handler) {
  await channel.prefetch(prefetch);
  await channel.consume(JOBS_QUEUE, (msg) => {
    if (!msg) return;
    handler(JSON.parse(msg.content.toString()), msg);
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
