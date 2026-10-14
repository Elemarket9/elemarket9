export type EmailWebhookResult = {
  accepted: true;
  eventId: string | null;
};

export interface EmailWebhookAdapter {
  readonly key: string;
  handle(rawBody: string, headers: Headers): Promise<EmailWebhookResult>;
}
