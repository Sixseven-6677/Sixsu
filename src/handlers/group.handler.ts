import { ISender }            from "../facebook/types/ISender";
import { FBMemberJoinedEvent,
         FBMemberLeftEvent }  from "../facebook/types/events";
import { config }             from "../config/env";
import { LoggerManager }      from "../logger/LoggerManager";

const log = LoggerManager.getLogger("GroupHandler");

let _sender:    ISender | undefined;
let _botUserId: string  = "";

export function setGroupSender(s: ISender):    void { _sender    = s; }
export function setGroupBotUserId(id: string): void { _botUserId = id; }

// ── Helpers ────────────────────────────────────────────────────────────────

function getSender(): ISender {
  if (!_sender) throw new Error("GroupHandler: sender not wired.");
  return _sender;
}

function buildJoinMessage(memberIds: string[], addedByUserId: string): string {
  if (memberIds.length === 1) {
    return (
      `🎉 مرحباً بالعضو الجديد!\n` +
      `👤 المعرف: ${memberIds[0]}\n` +
      `➕ تمت الإضافة بواسطة: ${addedByUserId}\n` +
      `أهلاً وسهلاً في المجموعة! 🌟`
    );
  }

  const list = memberIds.map((id) => `• ${id}`).join("\n");
  return (
    `🎉 مرحباً بالأعضاء الجدد!\n` +
    `${list}\n` +
    `➕ تمت الإضافة بواسطة: ${addedByUserId}\n` +
    `أهلاً وسهلاً بالجميع! 🌟`
  );
}

function buildLeaveMessage(memberIds: string[], removedBySelf: boolean): string {
  if (memberIds.length === 1) {
    return removedBySelf
      ? `👋 ${memberIds[0]} غادر المجموعة. نتمنى له التوفيق!`
      : `🚪 تم إزالة ${memberIds[0]} من المجموعة.`;
  }

  const list = memberIds.map((id) => `• ${id}`).join("\n");
  return removedBySelf
    ? `👋 غادر المجموعة عدة أعضاء:\n${list}`
    : `🚪 تم إزالة عدة أعضاء من المجموعة:\n${list}`;
}

/** Notify all admin IDs that the bot was added to a new group. */
async function notifyAdminBotAdded(
  sender:   ISender,
  threadId: string,
): Promise<void> {
  const adminIds = config.bot.adminIds;

  if (adminIds.length === 0) {
    log.warn(
      "GroupHandler: bot added to group but BOT_ADMIN_IDS is empty — no notification sent.",
      { threadId },
    );
    return;
  }

  const msg =
    `✅ تم إضافة البوت إلى مجموعة جديدة!\n` +
    `📌 معرّف المجموعة: ${threadId}\n` +
    `🤖 البوت يعمل بشكل صحيح ✔️`;

  for (const adminId of adminIds) {
    try {
      await sender.sendText(adminId, msg);
      log.info("GroupHandler: admin notified of bot group add.", { adminId, threadId });
    } catch (err) {
      log.error("GroupHandler: failed to notify admin.", {
        adminId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────

export async function handleMemberJoined(event: FBMemberJoinedEvent): Promise<void> {
  if (event.members.length === 0) {
    log.debug("member_joined event with empty members list — skipping.", {
      senderId: event.senderId,
    });
    return;
  }

  log.info("Member(s) joined group.", {
    threadId:      event.senderId,
    addedByUserId: event.addedByUserId,
    members:       event.members,
  });

  const sender = getSender();

  // ── Detect if the bot itself was added to this group ──────────────────
  const botWasAdded = !!_botUserId && event.members.includes(_botUserId);

  if (botWasAdded) {
    log.info("GroupHandler: bot was added to a new group!", {
      threadId: event.senderId,
      adminIds: config.bot.adminIds,
    });

    // 1. Send welcome message inside the group
    await sender.sendText(
      event.senderId,
      `مرحباً! أنا Sixsu 🤖\nتم إضافتي بنجاح إلى هذه المجموعة.\nاكتب /help لمعرفة الأوامر المتاحة.`,
    );

    // 2. Notify admin privately
    await notifyAdminBotAdded(sender, event.senderId);
    return;
  }

  // ── Regular member join ───────────────────────────────────────────────
  const text = buildJoinMessage(event.members, event.addedByUserId);
  await sender.sendText(event.senderId, text);
}

export async function handleMemberLeft(event: FBMemberLeftEvent): Promise<void> {
  if (event.members.length === 0) {
    log.debug("member_left event with empty members list — skipping.", {
      senderId: event.senderId,
    });
    return;
  }

  log.info("Member(s) left/removed from group.", {
    threadId: event.senderId,
    members:  event.members,
  });

  const sender        = getSender();
  const removedBySelf = event.members.length === 1 && event.members[0] === event.senderId;
  const text          = buildLeaveMessage(event.members, removedBySelf);

  await sender.sendText(event.senderId, text);
}
