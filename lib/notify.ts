// Outbound delivery channels (SMS/WhatsApp/push). No-op for now; real adapters land in Phase 4.
export type OutboundMessage = { userId: string; title: string; body: string };
export interface NotificationChannel { send(m: OutboundMessage): Promise<void>; }
export const consoleChannel: NotificationChannel = {
  async send(m) { console.log('[notify:noop]', m.userId, m.title); },
};
export async function notify(m: OutboundMessage) { await consoleChannel.send(m); }
