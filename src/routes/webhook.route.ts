import { Router, Request, Response } from "express";
import { WebhookBody } from "../types";
import { FacebookGateway, GroupHandlers } from "../facebook/FacebookGateway";
import { handleMessage } from "../handlers/message.handler";

/**
 * Note: Facebook HMAC-SHA256 signature verification (X-Hub-Signature-256) is
 * applied as middleware in app.ts before this router is mounted, so all
 * requests reaching here have already been authenticated in production.
 */
export function createWebhookRouter(
  gateway:       FacebookGateway,
  groupHandlers: GroupHandlers = {},
): Router {
  const router = Router();

  router.get("/", (req: Request, res: Response) => {
    gateway.handleVerification(req, res);
  });

  router.post("/", (req: Request, res: Response) => {
    const body = req.body as WebhookBody;

    if (body.object !== "page") {
      res.status(404).json({ error: "Not a page event" });
      return;
    }

    res.status(200).send("EVENT_RECEIVED");
    gateway.processWebhookBody(body, handleMessage, groupHandlers);
  });

  return router;
}
