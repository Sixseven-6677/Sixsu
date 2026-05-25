import { ISender }            from "../facebook/types/ISender";
import { FBMemberJoinedEvent,
         FBMemberLeftEvent }  from "../facebook/types/events";
import { LoggerManager }      from "../logger/LoggerManager";

const log = LoggerManager.getLogger("GroupHandler");

let _sender: ISender | undefined;

export function setGroupSender(s: ISender): void {
  _sender = s;
}

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

// ── Handlers ───────────────────────────────────────────────────────────────

export async function handleMemberJoined(event: FBMemberJoinedEvent): Promise<void> {
  if (event.members.length === 0) {
    log.debug("member_joined event with empty members list — skipping.", {
      senderId: event.senderId,
    });
    return;
  }

  log.info("Member(s) joined group.", {
    threadId:      event.pageId,
    addedByUserId: event.addedByUserId,
    members:       event.members,
  });

  const sender = getSender();
  const text   = buildJoinMessage(event.members, event.addedByUserId);

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
    threadId: event.pageId,
    members:  event.members,
  });

  const sender       = getSender();
  const removedBySelf = event.members.length === 1 && event.members[0] === event.senderId;
  const text          = buildLeaveMessage(event.members, removedBySelf);

  await sender.sendText(event.senderId, text);
}
