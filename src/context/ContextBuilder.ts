import { ISender }              from "../facebook/types/ISender";
import {
  FBMessageEvent,
  FBPostbackEvent,
} from "../facebook/types/events";
import { Context }              from "./Context";
import {
  ContextUser,
  ContextThread,
  ContextMessage,
  ContextAttachment,
} from "./types";
import type { IUserService }    from "../users/types/IUserService";
import { LoggerManager }        from "../logger/LoggerManager";

const log = LoggerManager.getLogger("ContextBuilder");

/** Fallback user used when UserService is unavailable or throws. */
const FALLBACK_USER = (id: string): ContextUser => ({
  id,
  role:         "user",
  messageCount: 0,
  lastSeen:     new Date(),
  createdAt:    new Date(),
  preferences:  {},
  isNew:        false,
});

export class ContextBuilder {
  private readonly sender:     ISender;
  private readonly ownerIds:   Set<string>;
  private readonly adminStore: { has(id: string): boolean };
  private userService?:        IUserService;

  /**
   * @param sender      The ISender used to reply to messages.
   * @param ownerIds    User IDs that always get role "owner". Required at
   *                    construction time so no message is ever processed without
   *                    the correct owner list.
   * @param adminStore  Live AdminStore reference. Required at construction time
   *                    so ctx.hasRole("admin") always reflects dynamic admins.
   * @param userService Optional UserService — can be injected later via
   *                    setUserService() if the service is not available yet
   *                    when the gateway is constructed.
   */
  constructor(
    sender:      ISender,
    ownerIds:    string[],
    adminStore:  { has(id: string): boolean },
    userService?: IUserService,
  ) {
    this.sender      = sender;
    this.ownerIds    = new Set(ownerIds);
    this.adminStore  = adminStore;
    this.userService = userService;

    log.info(`ContextBuilder: created with ${ownerIds.length} owner(s).`);
  }

  /** Inject (or replace) the UserService after construction. */
  setUserService(svc: IUserService): void {
    this.userService = svc;
  }

  /**
   * Builds a Context asynchronously.
   *
   * thread.id  = event.senderId  (threadID in FCA — correct reply routing)
   * user lookup = event.senderFbId ?? event.senderId
   *   In group chats (FCA), senderFbId is the real Facebook user ID while
   *   senderId carries the threadID for routing. In DMs they are the same.
   */
  async build(event: FBMessageEvent | FBPostbackEvent): Promise<Context> {

    const buildStart = Date.now();

    const thread:  ContextThread  = { id: event.senderId, pageId: event.pageId };
    const message: ContextMessage = this.buildMessage(event);

    const userLookupId = event.senderFbId ?? event.senderId;

    log.debug("Building context.", {
      threadId:       event.senderId,
      userLookupId,
      eventType:      event.type,
      hasUserService: Boolean(this.userService),
    });

    // ── User resolution ───────────────────────────────────────────────────
    let user:   ContextUser = FALLBACK_USER(userLookupId);
    let source: "db" | "fallback" = "fallback";

    if (this.userService) {
      try {
        log.debug("UserService.findOrCreate — start.", { fbId: userLookupId });
        const t0       = Date.now();
        const record   = await this.userService.findOrCreate(userLookupId);
        const lookupMs = Date.now() - t0;

        user = {
          id:           record.fbId,
          name:         record.name,
          role:         record.role,
          messageCount: record.messageCount,
          lastSeen:     record.lastSeenAt,
          createdAt:    record.createdAt,
          preferences:  record.preferences,
          isNew:        record.isNew,
        };
        source = "db";

        log.debug("UserService.findOrCreate — done.", {
          fbId:         userLookupId,
          role:         user.role,
          isNew:        user.isNew,
          messageCount: user.messageCount,
          lookupMs,
        });
      } catch (err) {
        source = "fallback";
        log.warn("UserService lookup failed — using fallback user.", {
          fbId:  userLookupId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log.debug("No UserService injected — using fallback user.", { fbId: userLookupId });
    }

    // ── Owner override ────────────────────────────────────────────────────
    if (this.ownerIds.has(userLookupId)) {
      log.debug(`ContextBuilder: user ${userLookupId} in ownerIds — elevating to owner.`);
      user = { ...user, role: "owner" };
    }

    // ── Admin store override ──────────────────────────────────────────────
    if (
      this.adminStore.has(userLookupId) &&
      user.role !== "owner" &&
      user.role !== "admin"
    ) {
      log.debug(`ContextBuilder: user ${userLookupId} in AdminStore — elevating to admin.`);
      user = { ...user, role: "admin" };
    }

    const totalMs = Date.now() - buildStart;
    log.debug("Context ready.", {
      threadId: event.senderId,
      userId:   user.id,
      role:     user.role,
      source,
      totalMs,
    });

    return new Context(user, thread, message, this.sender);
  }

  private buildMessage(event: FBMessageEvent | FBPostbackEvent): ContextMessage {
    if (event.type === "postback") {
      return {
        id:              `postback-${event.timestamp}`,
        text:            event.payload,
        attachments:     [],
        timestamp:       event.timestamp,
        isPostback:      true,
        postbackPayload: event.payload,
      };
    }

    const attachments: ContextAttachment[] = event.attachments.map((att) => ({
      type:        att.type,
      url:         att.url,
      coordinates: att.coordinates,
    }));

    return {
      id:          event.messageId,
      text:        event.text,
      attachments,
      timestamp:   event.timestamp,
      isPostback:  false,
    };
  }
}
