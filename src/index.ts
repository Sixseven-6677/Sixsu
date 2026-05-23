import { config } from "./config/env";
import { createApp } from "./app";
import { Bot } from "./core/Bot";
import { FacebookConnection } from "./facebook/FacebookConnection";
import { FacebookClient } from "./facebook/FacebookClient";
import { FacebookSender } from "./facebook/FacebookSender";
import { FacebookEventNormalizer } from "./facebook/FacebookEventNormalizer";
import { FacebookGateway } from "./facebook/FacebookGateway";

async function bootstrap(): Promise<void> {
  const bot = new Bot();

  const connection = new FacebookConnection();
  const client = new FacebookClient(connection);
  const sender = new FacebookSender(client);
  const normalizer = new FacebookEventNormalizer();
  const gateway = new FacebookGateway(connection, sender, normalizer);

  connection.connect();

  const app = createApp(gateway);

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
