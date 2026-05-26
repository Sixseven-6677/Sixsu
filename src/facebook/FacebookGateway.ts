import { Request, Response }       from "express";
import { WebhookBody }             from "../types";
import { FacebookConnection }      from "./FacebookConnection";
import { FacebookEventNormalizer } from "./FacebookEventNormalizer";
import { ISender }                 from "./types/ISender";
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
    sender:     ISender,
    normalizer: FacebookEventNormalizer
  ) {
    this.connection     = connection;
    this.normalizer     = normalizer;
    this.contextBuilder = new ContextBuilder(sender);
  }

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
        // ── [1] Normalize raw webhook payload ──────────────────────────────
        const event = this.normalizer.normalize(messagingEntry);

        if (event.type === "unknown") {
          log.warn("Skipping unknown event type.", { raw: messagingEntry });
          continue;
        }

        // ── [2] Log every event entering the pipeline ───────────────────────
        // [DEBUG-3] Event received — starting pipeline
        log.info("Gateway: event received — starting pipeline.", {
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

        // ── [3a] Group member events ─────────────────────────────────────────
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
        if (event.type !== "message" && event.type !== "postback") continue;

        const start = Date.now();
        this.contextBuilder
          .build(event)
          .then((ctx) => {
            // ── [DEBUG-4] Context created — middleware chain starting ──────
            log.info("Gateway: context created — dispatching to handler.", {
              senderId:  event.senderId,
              buildMs:   Date.now() - start,
              userId:    ctx.user.id,
              role:      ctx.user.role,
              isNewUser: ctx.user.isNew,
              text:      event.type === "message" ? event.text?.slice(0, 80) : undefined,
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
