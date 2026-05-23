import express, { Application } from "express";
import { FacebookGateway } from "./facebook/FacebookGateway";
import { createWebhookRouter } from "./routes/webhook.route";

export function createApp(gateway: FacebookGateway): Application {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", uptime: process.uptime() });
  });

  app.use("/webhook", createWebhookRouter(gateway));

  return app;
}
