export interface ISender {
  sendText(recipientId: string, text: string): Promise<void>;
  sendTyping(recipientId: string): Promise<void>;
  sendReaction(messageId: string, recipientId: string, emoji: string): Promise<void>;
}
