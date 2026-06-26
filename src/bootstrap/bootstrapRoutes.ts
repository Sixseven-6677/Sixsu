/**
 * bootstrapRoutes
 *
 * Mounts the webhook router on the Express app and registers the 404 / error
 * handlers. Must be called after all other route registrations so the catch-all
 * handlers are last in the Express chain.
 */
import { Express }                          from "express";
import { config }                           from "../config/env";
import { FacebookConnection }               from "../facebook/FacebookConnection";
import { FacebookEventNormalizer }          from "../facebook/FacebookEventNormalizer";
import { FacebookGateway }                  from "../facebook/FacebookGateway";
import { ApiProvider, MiraiSender }         from "../facebook/mirai/MiraiSender";
import { HumanBehaviorSender }              from "../facebook/HumanBehaviorSender";
import { AdminStore }                       from "../middleware/built-in/admin-store";
import { UserService }                      from "../users/UserService";
import { createWebhookRouter }              from "../routes/webhook.route";
import { httpErrorHandler, notFoundHandler } from "../errors/handlers/HttpErrorHandler";
import { handleMemberJoined, handleMemberLeft } from "../handlers/group.handler";
import { LoggerManager }                    from "../logger/LoggerManager";

const log = LoggerManager.getLogger("Boot.Routes");

export function bootstrapRoutes(
  app:        Express,
  transports: Array<{ label: string; transport: ApiProvider }>,
  adminStore: AdminStore,
  userSvc:    UserService,
): void {
  if (transports[0]) {
    const conn    = new FacebookConnection();
    const gateway = new FacebookGateway(
      conn,
      new HumanBehaviorSender(new MiraiSender(transports[0].transport)),
      new FacebookEventNormalizer(),
      config.bot.ownerIds,
      adminStore,
      userSvc,
    );
    conn.connect();

    app.use("/webhook", createWebhookRouter(gateway, {
      onMemberJoined: (evt) => handleMemberJoined(evt),
      onMemberLeft:   (evt) => handleMemberLeft(evt),
    }));
    log.info("Routes: webhook router mounted.");
  } else {
    log.warn("Routes: no transport available — webhook route not mounted.");
  }

  // 404 + error handlers must come last
  app.use(notFoundHandler);
  app.use(httpErrorHandler);
}
