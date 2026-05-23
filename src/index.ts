import path from "path";
import { config } from "./config/env";
import { createApp } from "./app";
import { Bot } from "./core/Bot";
import { FacebookConnection } from "./facebook/FacebookConnection";
import { FacebookClient } from "./facebook/FacebookClient";
import { FacebookSender } from "./facebook/FacebookSender";
import { FacebookEventNormalizer } from "./facebook/FacebookEventNormalizer";
import { FacebookGateway } from "./facebook/FacebookGateway";
import { CommandRegistry } from "./commands/CommandRegistry";
import { CommandLoader } from "./commands/CommandLoader";
import { CommandPipeline } from "./commands/CommandPipeline";
import { typingMiddleware } from "./commands/middleware/typing.middleware";
import { MiddlewareManager } from "./middleware/MiddlewareManager";
import { createLoggingMiddleware } from "./middleware/built-in/logging.middleware";
import { createCooldownMiddleware } from "./middleware/built-in/cooldown.middleware";
import { createAntiSpamMiddleware } from "./middleware/built-in/antispam.middleware";
import { createPermissionsMiddleware } from "./middleware/built-in/permissions.middleware";
import { DatabaseManager } from "./database/DatabaseManager";
import { setCommandPipeline } from "./handlers/message.handler";

async function bootstrap(): Promise<void> {
  const bot = new Bot();

  const db = new DatabaseManager();
  bot.register(db);

  const connection = new FacebookConnection();
  const client = new FacebookClient(connection);
  const sender = new FacebookSender(client);
  const normalizer = new FacebookEventNormalizer();
  const gateway = new FacebookGateway(connection, sender, normalizer);

  connection.connect();

  const registry = new CommandRegistry();
  const loader = new CommandLoader(registry);
  const commandsDir = path.resolve(config.bot.commandsDir);

  await loader.load(commandsDir);
  loader.watch(commandsDir);

  const mwManager = new MiddlewareManager()
    .register(createLoggingMiddleware())
    .register(createAntiSpamMiddleware({ maxMessages: 5, windowMs: 10_000 }))
    .register(createCooldownMiddleware({ durationMs: 3_000 }))
    .register(createPermissionsMiddleware({ blocklist: [] }));

  const pipeline = new CommandPipeline(registry, config.bot.prefix)
    .use(mwManager.fn("logging"))
    .use(mwManager.fn("antispam"))
    .use(mwManager.fn("cooldown"))
    .use(mwManager.fn("permissions"))
    .use(typingMiddleware)
    .onNotFound(async (ctx) => {
      await ctx.reply(`❓ الأمر "${ctx.commandName}" غير موجود.`);
    });

  setCommandPipeline(pipeline);

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
