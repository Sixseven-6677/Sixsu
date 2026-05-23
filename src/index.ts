import { config } from "./config/env";
import { createApp } from "./app";
import { Bot } from "./core/Bot";

async function bootstrap(): Promise<void> {
  const bot = new Bot();

  const app = createApp();

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(config.port, () => {
      console.log(`[Boot] Server on port ${config.port} [${config.nodeEnv}]`);
      resolve();
    });

    server.on("error", (err: Error) => {
      console.error("[Boot] Failed to start server:", err.message);
      reject(err);
    });
  });

  await bot.start();
}

bootstrap().catch((err: unknown) => {
  console.error("[Boot] Fatal error during startup:", err);
  process.exit(1);
});
