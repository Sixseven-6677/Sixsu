import { MessagingEntry } from "../types";
import { messengerService } from "../services/messenger.service";

export async function handleMessage(event: MessagingEntry): Promise<void> {
  const senderId = event.sender.id;

  if (event.message?.text) {
    await handleTextMessage(senderId, event.message.text);
    return;
  }

  if (event.message?.attachments) {
    await messengerService.sendText(senderId, "تم استقبال المرفق.");
    return;
  }

  if (event.postback) {
    await handlePostback(senderId, event.postback.payload);
    return;
  }
}

async function handleTextMessage(
  senderId: string,
  text: string
): Promise<void> {
  await messengerService.sendTypingOn(senderId);
  await messengerService.sendText(senderId, `استقبلت: ${text}`);
}

async function handlePostback(
  senderId: string,
  payload: string
): Promise<void> {
  await messengerService.sendText(senderId, `Postback: ${payload}`);
}
