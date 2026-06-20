/**
 * bootstrapCommands
 *
 * Builds the command registry, loads command files, constructs the pipeline
 * with all middleware, and wires the MessageHandler singleton so handleMessage
 * routes correctly when invoked by the FCA event adapter.
 */
import path                                 from "path";
import { config }                           from "../config/env";
import { CommandRegistry }                  from "../commands/CommandRegistry";
import { CommandLoader }                    from "../commands/CommandLoader";
import { CommandPipeline }                  from "../commands/CommandPipeline";
import { typingMiddleware }                 from "../commands/middleware/typing.middleware";
import { groupMuteMiddleware }              from "../commands/middleware/groupmute.middleware";
import { MiddlewareManager }                from "../middleware/MiddlewareManager";
import { createLoggingMiddleware }          from "../middleware/built-in/logging.middleware";
import { createCooldownMiddleware }         from "../middleware/built-in/cooldown.middleware";
import { createAntiSpamMiddleware }         from "../middleware/built-in/antispam.middleware";
import { createPermissionsMiddleware }      from "../middleware/built-in/permissions.middleware";
import {
  BanStore, BanEntry, createBannedMiddleware,
} from "../middleware/built-in/banned.middleware";
import { LockdownStore, createLockdownMiddleware } from "../middleware/built-in/lockdown.middleware";
import { AdminStore }                       from "../middleware/built-in/admin-store";
import { TaskScheduler }                    from "../scheduler";
import { ReconnectManager }                 from "../facebook/reconnect/ReconnectManager";
import { BanStore as BanStoreType }         from "../middleware/built-in/banned.middleware";
import { UserService }                      from "../users/UserService";
import { prefixStore }                      from "../prefix/PrefixStore";
import { createMessageHandler }             from "../handlers/message.handler";
import { LoggerManager }                    from "../logger/LoggerManager";

const log = LoggerManager.getLogger("Boot.Commands");

export interface CommandsBootstrap {
  registry: CommandRegistry;
  pipeline: CommandPipeline;
  loader:   CommandLoader;
}

function buildBanMessage(entry: BanEntry): string {
  const expiry = entry.expiresAt
    ? ` ينتهي: ${entry.expiresAt.toLocaleString("ar-SA")}.`
    : "";
  if (entry.reason?.startsWith("[MUTED]"))  return `🔇 تم كتمك من التفاعل مع البوت.${expiry}`;
  if (entry.reason?.startsWith("[KICKED]")) return `👢 تم طردك مؤقتاً.${expiry}`;
  const reason = entry.reason ? ` السبب: ${entry.reason}.` : "";
  const durStr = entry.expiresAt ? expiry : " الحظر دائم.";
  return `🚫 أنت محظور من استخدام البوت.${reason}${durStr}`;
}

export async function bootstrapCommands(
  banStore:     BanStoreType,
  lockdownStore: LockdownStore,
  adminStore:   AdminStore,
  scheduler:    TaskScheduler,
  reconnect:    ReconnectManager,
  userSvc:      UserService,
): Promise<CommandsBootstrap> {
  const registry = new CommandRegistry();
  const loader   = new CommandLoader(registry);
  await loader.load(path.resolve(config.bot.commandsDir));
  loader.watch(path.resolve(config.bot.commandsDir));
  log.info("Commands: registry loaded.", { commandsDir: config.bot.commandsDir });

  const mwManager = new MiddlewareManager()
    .register(createBannedMiddleware({ store: banStore, message: buildBanMessage }))
    .register(createLockdownMiddleware({ store: lockdownStore }))
    .register(createLoggingMiddleware({ logEntry: true }))
    .register(createAntiSpamMiddleware({ maxMessages: 5, windowMs: 10_000 }))
    .register(createCooldownMiddleware({ durationMs: 3_000 }))
    .register(createPermissionsMiddleware({
      adminIds: config.bot.adminIds,
      adminStore,
    }));

  const pipeline = new CommandPipeline(registry, () => prefixStore.get())
    .use(mwManager.fn("banned"))
    .use(mwManager.fn("logging"))
    .use(mwManager.fn("lockdown"))
    .use(groupMuteMiddleware)
    .use(mwManager.fn("antispam"))
    .use(mwManager.fn("cooldown"))
    .use(mwManager.fn("permissions"))
    .use(typingMiddleware)
    .onNotFound(async (ctx) => {
      await ctx.reply(`❓ الأمر "${ctx.commandName}" غير موجود.`);
    });

  // Wire MessageHandler singleton — handleMessage() (exported from the module)
  // calls through to this instance.
  createMessageHandler(pipeline, registry, scheduler, reconnect, banStore, userSvc);
  log.info("Commands: MessageHandler wired.");

  return { registry, pipeline, loader };
}
