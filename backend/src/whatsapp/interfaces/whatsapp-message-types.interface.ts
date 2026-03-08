/**
 * WhatsApp Cloud API Message Types (v24.0+)
 * 
 * Complete type definitions for WhatsApp Business API
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */

// ============================================
// OUTGOING MESSAGE TYPES
// ============================================

export type WhatsAppMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contacts'
  | 'interactive'
  | 'template'
  | 'reaction';

export type InteractiveType =
  | 'button'          // Reply buttons (max 3)
  | 'list'            // List menu (max 10 items)
  | 'cta_url'         // Call-to-action URL button
  | 'flow'            // WhatsApp Flows
  | 'location_request_message'
  | 'address_message'
  | 'product'         // Single product
  | 'product_list';   // Multiple products

// ============================================
// BASE MESSAGE STRUCTURE
// ============================================

export interface WhatsAppOutgoingMessage {
  messaging_product: 'whatsapp';
  recipient_type?: 'individual' | 'group';
  to: string;
  type: WhatsAppMessageType;
  context?: {
    message_id: string; // Reply to specific message
  };
  biz_opaque_callback_data?: string; // Custom callback data
}

// ============================================
// TEXT MESSAGE
// ============================================

export interface TextMessage extends WhatsAppOutgoingMessage {
  type: 'text';
  text: {
    body: string;        // Max 4096 chars
    preview_url?: boolean; // Enable URL preview
  };
}

// ============================================
// MEDIA MESSAGES
// ============================================

export interface MediaObject {
  id?: string;           // Media ID (uploaded)
  link?: string;         // Media URL (external)
  caption?: string;      // Max 1024 chars for image/video
  filename?: string;     // For documents
}

export interface ImageMessage extends WhatsAppOutgoingMessage {
  type: 'image';
  image: MediaObject;
}

export interface VideoMessage extends WhatsAppOutgoingMessage {
  type: 'video';
  video: MediaObject;    // Max 16MB, MP4/3GPP
}

export interface AudioMessage extends WhatsAppOutgoingMessage {
  type: 'audio';
  audio: MediaObject;    // AAC, AMR, MP3, M4A, OGG
}

export interface DocumentMessage extends WhatsAppOutgoingMessage {
  type: 'document';
  document: MediaObject & {
    filename: string;    // Required for documents
  };
}

export interface StickerMessage extends WhatsAppOutgoingMessage {
  type: 'sticker';
  sticker: {
    id?: string;
    link?: string;       // WebP format, max 100KB static, 500KB animated
  };
}

// ============================================
// LOCATION MESSAGE
// ============================================

export interface LocationMessage extends WhatsAppOutgoingMessage {
  type: 'location';
  location: {
    latitude: number;
    longitude: number;
    name?: string;       // Max 256 chars
    address?: string;    // Max 256 chars
  };
}

// ============================================
// CONTACT MESSAGE
// ============================================

export interface ContactMessage extends WhatsAppOutgoingMessage {
  type: 'contacts';
  contacts: Array<{
    name: {
      formatted_name: string;
      first_name?: string;
      last_name?: string;
      middle_name?: string;
      suffix?: string;
      prefix?: string;
    };
    phones?: Array<{
      phone: string;
      type?: 'CELL' | 'MAIN' | 'IPHONE' | 'HOME' | 'WORK';
      wa_id?: string;
    }>;
    emails?: Array<{
      email: string;
      type?: 'HOME' | 'WORK';
    }>;
    urls?: Array<{
      url: string;
      type?: 'HOME' | 'WORK';
    }>;
    addresses?: Array<{
      street?: string;
      city?: string;
      state?: string;
      zip?: string;
      country?: string;
      country_code?: string;
      type?: 'HOME' | 'WORK';
    }>;
    org?: {
      company?: string;
      department?: string;
      title?: string;
    };
    birthday?: string; // YYYY-MM-DD
  }>;
}

// ============================================
// INTERACTIVE MESSAGES
// ============================================

export interface InteractiveHeader {
  type: 'text' | 'image' | 'video' | 'document';
  text?: string;         // Max 60 chars
  image?: MediaObject;
  video?: MediaObject;
  document?: MediaObject;
}

export interface InteractiveBody {
  text: string;          // Max 1024 chars
}

export interface InteractiveFooter {
  text: string;          // Max 60 chars
}

// Reply Buttons (max 3)
export interface ReplyButton {
  type: 'reply';
  reply: {
    id: string;          // Max 256 chars
    title: string;       // Max 20 chars
  };
}

export interface ButtonInteractive {
  type: 'button';
  header?: InteractiveHeader;
  body: InteractiveBody;
  footer?: InteractiveFooter;
  action: {
    buttons: ReplyButton[];  // Max 3 buttons
  };
}

// List Message (max 10 items)
export interface ListRow {
  id: string;            // Max 200 chars
  title: string;         // Max 24 chars
  description?: string;  // Max 72 chars
}

export interface ListSection {
  title?: string;        // Max 24 chars (required if >1 section)
  rows: ListRow[];       // Max 10 rows per section
}

export interface ListInteractive {
  type: 'list';
  header?: InteractiveHeader;
  body: InteractiveBody;
  footer?: InteractiveFooter;
  action: {
    button: string;      // Max 20 chars - Button text
    sections: ListSection[]; // Max 10 sections
  };
}

// CTA URL Button
export interface CTAUrlInteractive {
  type: 'cta_url';
  header?: InteractiveHeader;
  body: InteractiveBody;
  footer?: InteractiveFooter;
  action: {
    name: 'cta_url';
    parameters: {
      display_text: string;  // Max 20 chars
      url: string;
    };
  };
}

// Location Request
export interface LocationRequestInteractive {
  type: 'location_request_message';
  body: InteractiveBody;
  action: {
    name: 'send_location';
  };
}

// Address Request
export interface AddressInteractive {
  type: 'address_message';
  body: InteractiveBody;
  action: {
    name: 'address_message';
    parameters?: {
      country?: string;
    };
  };
}

// WhatsApp Flow
export interface FlowInteractive {
  type: 'flow';
  header?: InteractiveHeader;
  body: InteractiveBody;
  footer?: InteractiveFooter;
  action: {
    name: 'flow';
    parameters: {
      flow_message_version: '3';
      flow_token: string;
      flow_id: string;
      flow_cta: string;      // Max 20 chars
      flow_action: 'navigate' | 'data_exchange';
      flow_action_payload?: {
        screen: string;
        data?: Record<string, any>;
      };
    };
  };
}

// Single Product Message (SPM) — shows one product with image/price/description
export interface ProductInteractive {
  type: 'product';
  body?: InteractiveBody;
  footer?: InteractiveFooter;
  action: {
    catalog_id: string;
    product_retailer_id: string;
  };
}

// Multi-Product Message (MPM) — up to 30 products grouped in sections
export interface ProductListSection {
  title: string;                          // Section title (max 24 chars)
  product_items: Array<{
    product_retailer_id: string;          // Product SKU in Meta catalog
  }>;
}

export interface ProductListInteractive {
  type: 'product_list';
  header: { type: 'text'; text: string }; // Required for product_list
  body: InteractiveBody;
  footer?: InteractiveFooter;
  action: {
    catalog_id: string;
    sections: ProductListSection[];       // Max 10 sections, 30 products total
  };
}

export type InteractiveContent =
  | ButtonInteractive
  | ListInteractive
  | CTAUrlInteractive
  | LocationRequestInteractive
  | AddressInteractive
  | FlowInteractive
  | ProductInteractive
  | ProductListInteractive;

export interface InteractiveMessage extends WhatsAppOutgoingMessage {
  type: 'interactive';
  interactive: InteractiveContent;
}

// ============================================
// TEMPLATE MESSAGES
// ============================================

export interface TemplateParameter {
  type: 'text' | 'currency' | 'date_time' | 'image' | 'video' | 'document';
  text?: string;
  currency?: {
    fallback_value: string;
    code: string;
    amount_1000: number;
  };
  date_time?: {
    fallback_value: string;
  };
  image?: MediaObject;
  video?: MediaObject;
  document?: MediaObject;
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: 'quick_reply' | 'url' | 'copy_code';
  index?: number;
  parameters?: TemplateParameter[];
}

export interface TemplateMessage extends WhatsAppOutgoingMessage {
  type: 'template';
  template: {
    name: string;
    language: {
      code: string;      // e.g., 'en_US', 'hi'
    };
    components?: TemplateComponent[];
  };
}

// ============================================
// REACTION MESSAGE
// ============================================

export interface ReactionMessage extends WhatsAppOutgoingMessage {
  type: 'reaction';
  reaction: {
    message_id: string;  // Message to react to
    emoji: string;       // Single emoji or empty to remove
  };
}

// ============================================
// STATUS UPDATES (Read receipts, typing)
// ============================================

export interface StatusUpdate {
  messaging_product: 'whatsapp';
  status: 'read';
  message_id: string;
}

export interface TypingIndicator {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'typing';
  typing: {
    state: 'typing_on' | 'typing_off';
  };
}

// ============================================
// INCOMING MESSAGE TYPES (Webhook)
// ============================================

export interface IncomingTextMessage {
  type: 'text';
  text: {
    body: string;
  };
}

export interface IncomingImageMessage {
  type: 'image';
  image: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
}

export interface IncomingVideoMessage {
  type: 'video';
  video: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
}

export interface IncomingAudioMessage {
  type: 'audio';
  audio: {
    id: string;
    mime_type: string;
    sha256: string;
    voice?: boolean;  // true if voice note
  };
}

export interface IncomingDocumentMessage {
  type: 'document';
  document: {
    id: string;
    mime_type: string;
    sha256: string;
    filename: string;
    caption?: string;
  };
}

export interface IncomingLocationMessage {
  type: 'location';
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
    url?: string;
  };
}

export interface IncomingContactMessage {
  type: 'contacts';
  contacts: Array<{
    name: { formatted_name: string };
    phones?: Array<{ phone: string; wa_id?: string }>;
  }>;
}

export interface IncomingInteractiveMessage {
  type: 'interactive';
  interactive: {
    type: 'button_reply' | 'list_reply' | 'nfm_reply';
    button_reply?: {
      id: string;
      title: string;
    };
    list_reply?: {
      id: string;
      title: string;
      description?: string;
    };
    nfm_reply?: {
      response_json: string;  // WhatsApp Flow response
      body: string;
      name: string;
    };
  };
}

export interface IncomingReactionMessage {
  type: 'reaction';
  reaction: {
    message_id: string;
    emoji: string;
  };
}

export interface IncomingStickerMessage {
  type: 'sticker';
  sticker: {
    id: string;
    mime_type: string;
    sha256: string;
    animated: boolean;
  };
}

export interface IncomingOrderMessage {
  type: 'order';
  order: {
    catalog_id: string;
    product_items: Array<{
      product_retailer_id: string;
      quantity: number;
      item_price: number;
      currency: string;
    }>;
    text?: string;
  };
}

export type IncomingMessage =
  | IncomingTextMessage
  | IncomingImageMessage
  | IncomingVideoMessage
  | IncomingAudioMessage
  | IncomingDocumentMessage
  | IncomingLocationMessage
  | IncomingContactMessage
  | IncomingInteractiveMessage
  | IncomingReactionMessage
  | IncomingStickerMessage
  | IncomingOrderMessage;

// ============================================
// WEBHOOK PAYLOAD
// ============================================

export interface WebhookContact {
  profile: {
    name: string;
  };
  wa_id: string;
}

export interface WebhookMessageMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

export interface WebhookStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  conversation?: {
    id: string;
    origin: {
      type: 'business_initiated' | 'user_initiated' | 'referral_conversion';
    };
    expiration_timestamp?: string;
  };
  pricing?: {
    billable: boolean;
    pricing_model: 'CBP';
    category: 'business_initiated' | 'user_initiated' | 'referral_conversion';
  };
  errors?: Array<{
    code: number;
    title: string;
    message: string;
    error_data?: {
      details: string;
    };
  }>;
}

export interface WebhookValue {
  messaging_product: 'whatsapp';
  metadata: WebhookMessageMetadata;
  contacts?: WebhookContact[];
  messages?: Array<{
    id: string;
    from: string;
    timestamp: string;
    type: string;
    context?: {
      from: string;
      id: string;
    };
    referral?: {
      source_url: string;
      source_type: string;
      source_id: string;
      headline: string;
      body: string;
      media_type: string;
      image_url?: string;
      video_url?: string;
      thumbnail_url?: string;
    };
  } & IncomingMessage>;
  statuses?: WebhookStatus[];
  errors?: Array<{
    code: number;
    title: string;
    message: string;
    error_data?: {
      details: string;
    };
  }>;
}

export interface WebhookEntry {
  id: string;
  changes: Array<{
    value: WebhookValue;
    field: 'messages';
  }>;
}

export interface WebhookPayload {
  object: 'whatsapp_business_account';
  entry: WebhookEntry[];
}

// ============================================
// API RESPONSE
// ============================================

export interface MessageResponse {
  messaging_product: 'whatsapp';
  contacts: Array<{
    input: string;
    wa_id: string;
  }>;
  messages: Array<{
    id: string;
    message_status?: 'accepted' | 'held_for_quality_assessment';
  }>;
}

// ============================================
// CHANNEL CAPABILITIES
// ============================================

export interface WhatsAppChannelCapabilities {
  maxTextLength: 4096;
  maxCaptionLength: 1024;
  maxButtonCount: 3;
  maxButtonTitleLength: 20;
  maxListSections: 10;
  maxListRowsPerSection: 10;
  maxListRowTitleLength: 24;
  maxListRowDescriptionLength: 72;
  maxHeaderTextLength: 60;
  maxFooterTextLength: 60;
  supportedMediaTypes: {
    image: ['image/jpeg', 'image/png'];
    video: ['video/mp4', 'video/3gpp'];
    audio: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/ogg'];
    document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    sticker: ['image/webp'];
  };
  features: {
    textMessages: true;
    mediaMessages: true;
    locationMessages: true;
    contactMessages: true;
    interactiveButtons: true;
    interactiveLists: true;
    ctaUrlButtons: true;
    locationRequests: true;
    addressRequests: true;
    templates: true;
    reactions: true;
    voiceMessages: true;
    flows: true;
    catalog: true;
    payments: boolean; // Depends on region
  };
}

export const WHATSAPP_CAPABILITIES: WhatsAppChannelCapabilities = {
  maxTextLength: 4096,
  maxCaptionLength: 1024,
  maxButtonCount: 3,
  maxButtonTitleLength: 20,
  maxListSections: 10,
  maxListRowsPerSection: 10,
  maxListRowTitleLength: 24,
  maxListRowDescriptionLength: 72,
  maxHeaderTextLength: 60,
  maxFooterTextLength: 60,
  supportedMediaTypes: {
    image: ['image/jpeg', 'image/png'],
    video: ['video/mp4', 'video/3gpp'],
    audio: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/ogg'],
    document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    sticker: ['image/webp'],
  },
  features: {
    textMessages: true,
    mediaMessages: true,
    locationMessages: true,
    contactMessages: true,
    interactiveButtons: true,
    interactiveLists: true,
    ctaUrlButtons: true,
    locationRequests: true,
    addressRequests: true,
    templates: true,
    reactions: true,
    voiceMessages: true,
    flows: true,
    catalog: true,
    payments: false, // Enable based on region
  },
};
