import express, { Application }   from "express";
import { FacebookGateway,
         GroupHandlers }           from "./facebook/FacebookGateway";
import { createWebhookRouter }     from "./routes/webhook.route";
import { httpErrorHandler,
         notFoundHandler }         from "./errors/handlers/HttpErrorHandler";
import { MiraiTransport }          from "./facebook/mirai/MiraiTransport";

export function createApp(
  gateway: FacebookGateway,
  groupHandlers: GroupHandlers = {},
  miraiTransport: MiraiTransport | null = null,
): Application {
  const app = express();

  app.use(
    express.json({
      limit: "1mb",
    })
  );
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.get(["/health", "/api/health", "/api/healthz"], (_req, res) => {
    const mqttConnected = miraiTransport ? miraiTransport.getApi() !== null : null;
    res.status(200).json({
      status:    "ok",
      uptime:    process.uptime(),
      mqtt:      mqttConnected === null ? "unknown" : mqttConnected ? "connected" : "disconnected",
      botUserId: miraiTransport?.getCurrentUserId() || null,
    });
  });

  const webhookRouter = createWebhookRouter(gateway, groupHandlers);
  app.use("/webhook", webhookRouter);

  app.use(notFoundHandler);
  app.use(httpErrorHandler);

  return app;
}
