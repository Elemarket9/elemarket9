export type PushPlatform = "android" | "ios" | "web";

export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
};

export type PushSendResult = {
  accepted: boolean;
  providerId?: string;
};

export interface PushProviderAdapter {
  readonly key: string;
  sendToToken(token: string, message: PushMessage): Promise<PushSendResult>;
}
