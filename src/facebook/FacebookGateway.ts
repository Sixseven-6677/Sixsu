import { Request, Response }       from "express";
import { WebhookBody }             from "../types";
import { FacebookConnection }      from "./FacebookConnection";
import { FacebookSender }          from "./FacebookSender";
import { FacebookEventNormalizer } from "./FacebookEventNormalizer";
import { ContextBuilder }          from "../context/ContextBuilder";
import { Context }                 from "../context/Context";
import { FBMemberJoinedEvent, FBMemberLeftEvent } from "./types/events";
import { LoggerManager }           from "../logger/LoggerManager";

const log = LoggerManager.getLogger("FacebookGateway");

export type MessageHandler      = (ctx: Context) => Promise<void>;
export type MemberJoinedHandler = (event: FBMemberJoinedEvent) => Promise<void>;
export type MemberLeftHandler   = (event: FBMemberLeftEvent)   => Promise<void>;

export interface GroupHandlers {
  onMemberJoined?: MemberJoinedHandler;
  onMemberLeft?:   MemberLeftHandler;
}

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

  processWebhookBody(
    body:          WebhookBody,
    handler:       MessageHandler,
    groupHandlers: GroupHandlers = {},
  ): void {
    if (body.object !== "page") return;

    for (const entry of body.entry) {
      for (const messagingEntry of entry.messaging) {
        // ── [1] Normalize the raw webhook payload ──────────────────────────
        const event = this.normalizer.normalize(messagingEntry);

        if (event.type === "unknown") {
          log.warn("Skipping unknown event type.", { raw: messagingEntry });
          continue;
        }

        // ── [2] Log every event that enters the pipeline ───────────────────
        log.debug("Event received — starting pipeline.", {
          type:      event.type,
          senderId:  event.senderId,
          pageId:    event.pageId,
          timestamp: event.timestamp,
          ...(event.type === "message"
            ? {
                messageId:   event.messageId,
                text:        event.text?.slice(0, 80),
                attachments: event.attachments.length,
              }
            : event.type === "postback"
              ? { payload: event.payload?.slice(0, 80) }
              : event.type === "member_joined"
                ? { addedByUserId: event.addedByUserId, members: event.members }
                : event.type === "member_left"
                  ? { members: event.members }
                  : {}),
        });

        // ── [3a] Group member events — dispatch directly (no context build) ─
        if (event.type === "member_joined" && groupHandlers.onMemberJoined) {
          groupHandlers.onMemberJoined(event).catch((err: unknown) => {
            log.error("Unhandled error in member_joined handler.", {
              senderId: event.senderId,
              error:    err instanceof Error ? err.message : String(err),
            });
          });
          continue;
        }

        if (event.type === "member_left" && groupHandlers.onMemberLeft) {
          groupHandlers.onMemberLeft(event).catch((err: unknown) => {
            log.error("Unhandled error in member_left handler.", {
              senderId: event.senderId,
              error:    err instanceof Error ? err.message : String(err),
            });
          });
          continue;
        }

        // ── [3b] Message / postback — build context then dispatch ──────────
        const start = Date.now();
        this.contextBuilder
          .build(event)
          .then((ctx) => {
            log.debug("Context built — dispatching to handler.", {
              senderId:  event.senderId,
              buildMs:   Date.now() - start,
              userId:    ctx.user.id,
              role:      ctx.user.role,
              isNewUser: ctx.user.isNew,
            });
            return handler(ctx);
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error("Unhandled error in message pipeline.", {
              senderId: event.senderId,
              error:    msg,
            });
          });
      }
    }
  }
}
