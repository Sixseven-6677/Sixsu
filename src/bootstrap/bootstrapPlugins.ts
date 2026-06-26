/**
 * bootstrapPlugins
 *
 * Creates the PluginManager, populates the ServiceRegistry with all core
 * services, optionally wires MongoDB repositories, and registers the plugin
 * manager with the Bot lifecycle.
 */
import path                                from "path";
import { config }                          from "../config/env";
import { Bot }                             from "../core/Bot";
import { PluginManager }                   from "../plugins/PluginManager";
import { CommandRegistry }                 from "../commands/CommandRegistry";
import { TaskScheduler }                   from "../scheduler";
import { UserService }                     from "../users/UserService";
import { BanStore }                        from "../middleware/built-in/banned.middleware";
import { LockdownStore }                   from "../middleware/built-in/lockdown.middleware";
import { AdminStore }                      from "../middleware/built-in/admin-store";
import { ApiProvider, MiraiSender }        from "../facebook/mirai/MiraiSender";
import { HumanBehaviorSender }             from "../facebook/HumanBehaviorSender";
import { BotAdminRepository }             from "../database/repositories/botadmin.repository";
import { GroupSettingsRepository }        from "../database/repositories/group-settings.repository";
import { BanRepository }                  from "../database/repositories/ban.repository";
import { BlackConfigRepository }          from "../database/repositories/black-config.repository";
import { BotConfigRepository }            from "../database/repositories/bot-config.repository";
import { CommandStatsRepository }         from "../database/repositories/command-stats.repository";
import { LoggerManager }                  from "../logger/LoggerManager";

const log = LoggerManager.getLogger("Boot.Plugins");

export interface PluginsBootstrap {
  pluginManager:    PluginManager;
  botAdminRepo:     BotAdminRepository     | null;
  groupSettingsRepo:GroupSettingsRepository | null;
  banRepo:          BanRepository           | null;
  botConfigRepo:    BotConfigRepository     | null;
}

export function bootstrapPlugins(
  bot:          Bot,
  registry:     CommandRegistry,
  scheduler:    TaskScheduler,
  userSvc:      UserService,
  banStore:     BanStore,
  lockdownStore: LockdownStore,
  adminStore:   AdminStore,
  transports:   Array<{ label: string; transport: ApiProvider }>,
  mongoEnabled: boolean,
): PluginsBootstrap {
  const pluginManager = new PluginManager({
    commandRegistry: registry,
    scheduler,
    pluginsDir: path.resolve(config.plugins.dir),
    watch:      config.plugins.watch,
  });

  const svcReg = pluginManager.getServiceRegistry();
  svcReg.provide("command-registry", registry,      "core");
  svcReg.provide("ban-store",        banStore,       "core");
  svcReg.provide("lockdown-store",   lockdownStore,  "core");
  svcReg.provide("admin-store",      adminStore,     "core");
  svcReg.provide("user-service",     userSvc,        "core");

  if (transports[0]) {
    svcReg.provide("mirai-transport",  transports[0].transport, "core");
    const primarySender = new HumanBehaviorSender(new MiraiSender(transports[0].transport));
    svcReg.provide("facebook-sender", primarySender,            "core");
  }
  if (transports[1]) {
    svcReg.provide("mirai-transport-secondary", transports[1].transport, "core");
  }

  if (config.facebook.pageAccessToken) {
    svcReg.provide("fb-access-token", config.facebook.pageAccessToken, "core");
  }

  let botAdminRepo:      BotAdminRepository     | null = null;
  let groupSettingsRepo: GroupSettingsRepository | null = null;
  let banRepo:           BanRepository           | null = null;
  let botConfigRepo:     BotConfigRepository     | null = null;

  if (mongoEnabled) {
    botAdminRepo      = new BotAdminRepository();
    groupSettingsRepo = new GroupSettingsRepository();
    banRepo           = new BanRepository();
    const blackConfigRepo  = new BlackConfigRepository();
    botConfigRepo     = new BotConfigRepository();
    const commandStatsRepo = new CommandStatsRepository();

    // Wire MongoDB repos into stores BEFORE bot.start() so plugins can use them
    // during their onLoad lifecycle hook.
    adminStore.setRepository(botAdminRepo);
    lockdownStore.setRepository(groupSettingsRepo);
    banStore.setRepository(banRepo);

    svcReg.provide("group-settings-repo", groupSettingsRepo,  "core");
    svcReg.provide("ban-repo",            banRepo,            "core");
    svcReg.provide("botadmin-repo",       botAdminRepo,       "core");
    svcReg.provide("black-config-repo",   blackConfigRepo,    "core");
    svcReg.provide("bot-config-repo",     botConfigRepo,      "core");
    svcReg.provide("command-stats-repo",  commandStatsRepo,   "core");

    log.info("Plugins: MongoDB repos wired (pre-start).");
  }

  bot.register(pluginManager);
  return { pluginManager, botAdminRepo, groupSettingsRepo, banRepo, botConfigRepo };
}
