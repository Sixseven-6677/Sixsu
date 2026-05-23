import express, { Application } from "express";
import { FacebookGateway } from "./facebook/FacebookGateway";
import { createWebhookRouter } from "./routes/webhook.route";
import { httpErrorHandler, notFoundHandler } from "./errors/handlers/HttpErrorHandler";

export function createApp(gateway: FacebookGateway): Application {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", uptime: process.uptime() });
  });

  app.use("/webhook", createWebhookRouter(gateway));

  app.use(notFoundHandler);
  app.use(httpErrorHandler);

  return app;
}
