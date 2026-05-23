import { Router, Request, Response } from "express";
import { WebhookBody } from "../types";
import { FacebookGateway } from "../facebook/FacebookGateway";
import { handleMessage } from "../handlers/message.handler";

export function createWebhookRouter(gateway: FacebookGateway): Router {
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
    gateway.processWebhookBody(body, handleMessage);
  });

  return router;
}
