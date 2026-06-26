import Fastify from "fastify";
import { CORE_VERSION } from "@queuestorm/core";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3000);

export function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  // Tracer-bullet liveness probe. Kept dependency-free so it stays green
  // even before any analysis logic (or Redis) exists.
  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

async function main() {
  const app = buildServer();
  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info({ coreVersion: CORE_VERSION }, "queuestorm api listening");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
