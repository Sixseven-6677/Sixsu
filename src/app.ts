import express, { Application } from "express";
import webhookRouter from "./routes/webhook.route";

export function createApp(): Application {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", uptime: process.uptime() });
  });

  app.use("/webhook", webhookRouter);

  return app;
}
