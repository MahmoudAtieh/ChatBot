export type Language = "ar" | "en";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  createdAt: Date;
  mediaId?: string;
}

export const assistantRoutes = [
  "greeting",
  "product_recommendation",
  "missing_product_information",
  "static_faq",
  "custom_order",
  "bulk_order",
  "order_status",
  "complaint_or_damage",
  "shipping_question",
  "return_refund_or_exchange",
  "cancel_or_change_order",
  "human_handoff",
  "unsupported",
] as const;

export type AssistantRoute = (typeof assistantRoutes)[number];

export interface HandoffDetails {
  reason: string;
  summary: string;
}

export interface AssistantResult {
  reply: string;
  route: AssistantRoute;
  handoff: boolean;
  handoffDetails: HandoffDetails | null;
  factSourceIds: string[];
}

export interface ReplyContext {
  conversationId: string;
  messages: ChatMessage[];
}

export interface ShoppingAssistant {
  reply(context: ReplyContext): Promise<AssistantResult>;
}

export interface IncomingWhatsAppMessage {
  id: string;
  from: string;
  phoneNumberId: string;
  timestamp: string;
  text: string;
  mediaId?: string;
}
