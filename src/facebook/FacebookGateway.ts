import { Request, Response }       from "express";
import { WebhookBody }             from "../types";
import { FacebookConnection }      from "./FacebookConnection";
import { FacebookSender }          from "./FacebookSender";
import { FacebookEventNormalizer } from "./FacebookEventNormalizer";
import { ContextBuilder }          from "../context/ContextBuilder";
import { Context }                 from "../context/Context";
import { LoggerManager }           from "../logger/LoggerManager";

const log = LoggerManager.getLogger("FacebookGateway");

export type MessageHandler = (ctx: Context) => Promise<void>;

export class FacebookGateway {
  private readonly connection:     FacebookConnection;
  private readonly normalizer:     FacebookEventNormalizer;
  private readonly contextBuilder: ContextBuilder;

  constructor(
    connection: FacebookConnection,
    sender:     FacebookSender,
    normalizer: FacebookEventNormalizer
  ) {
    this.connection     = connection;
    this.normalizer     = normalizer;
    this.contextBuilder = new ContextBuilder(sender);
  }

  /**
   * Returns the ContextBuilder so that bootstrap can inject services
   * (e.g. UserService) after construction.
   */
  getContextBuilder(): ContextBuilder {
    return this.contextBuilder;
  }

  handleVerification(req: Request, res: Response): void {
    const {
      "hub.mode":         mode,
      "hub.verify_token": token,
      "hub.challenge":    challenge,
    } = req.query;

    const result = this.connection.verifyWebhookChallenge(mode, token, challenge);

    if (result !== null) {
      log.info("Webhook verified.");
      res.status(200).send(result);
      return;
    }

    log.warn("Webhook verification failed.", { mode, token });
    res.status(403).json({ error: "Forbidden" });
  }

  processWebhookBody(body: WebhookBody, handler: MessageHandler): void {
    if (body.object !== "page") return;

    for (const entry of body.entry) {
      for (const messagingEntry of entry.messaging) {
        const event = this.normalizer.normalize(messagingEntry);

        if (event.type === "unknown") {
          log.warn("Skipping unknown event type.");
          continue;
        }

        // Build context asynchronously (includes UserService DB/cache lookup),
        // then dispatch to the handler — errors are logged and never surface to Facebook.
        this.contextBuilder
          .build(event)
          .then((ctx) => handler(ctx))
          .catch((err: unknown) => {
            log.error("Unhandled error in message handler.", err);
          });
      }
    }
  }
}
