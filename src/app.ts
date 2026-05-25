import crypto                         from "crypto";
import express, { Application,
  Request, Response, NextFunction }   from "express";
import { FacebookGateway,
         GroupHandlers }              from "./facebook/FacebookGateway";
import { createWebhookRouter }        from "./routes/webhook.route";
import { httpErrorHandler,
         notFoundHandler }            from "./errors/handlers/HttpErrorHandler";
import { config }                     from "./config/env";
import { LoggerManager }              from "./logger/LoggerManager";

const log = LoggerManager.getLogger("App");

/**
 * Verify the X-Hub-Signature-256 header sent by Facebook on every POST.
 * Requires the raw body to be available; we capture it via express.json's
 * `verify` callback and attach it as `req.rawBody`.
 *
 * If the header is absent or the signature does not match, the request is
 * rejected with 401.  Signature verification is skipped in non-production
 * environments so local testing with tools like ngrok / curl still works.
 */
function verifyFacebookSignature(
  req:  Request,
  res:  Response,
  next: NextFunction
): void {
  const sig = req.headers["x-hub-signature-256"] as string | undefined;

  if (!sig) {
    log.warn("Webhook POST missing X-Hub-Signature-256 — rejecting.");
    res.status(401).json({ error: "Missing signature" });
    return;
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    next();
    return;
  }

  const expected = "sha256=" +
    crypto
      .createHmac("sha256", config.facebook.appSecret)
      .update(rawBody)
      .digest("hex");

  const sigBuffer      = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    log.warn("Webhook POST signature mismatch — rejecting.");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  next();
}

export function createApp(gateway: FacebookGateway, groupHandlers: GroupHandlers = {}): Application {
  const app = express();

  // ── Body parsing ──────────────────────────────────────────────────────────
  // Capture the raw body for HMAC signature verification before JSON parsing.
  // A 1 MB limit protects against excessively large payloads.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // ── Health check ──────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", uptime: process.uptime() });
  });

  // ── Webhook ────────────────────────────────────────────────────────────────
  // Apply signature verification only in production to keep local dev ergonomic.
  const webhookRouter = createWebhookRouter(gateway, groupHandlers);

  if (config.nodeEnv === "production") {
    app.use("/webhook", verifyFacebookSignature, webhookRouter);
  } else {
    app.use("/webhook", webhookRouter);
  }

  // ── Error handling ─────────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(httpErrorHandler);

  return app;
}
