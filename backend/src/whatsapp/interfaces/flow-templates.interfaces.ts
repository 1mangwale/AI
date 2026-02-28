/**
 * WhatsApp Flow Template Interfaces
 *
 * Type definitions for WhatsApp Cloud API interactive message templates.
 * Used by WhatsAppFlowTemplateService to build structured messages
 * for order tracking, returns, feedback, and reordering.
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages#interactive-object
 */

// ============================================
// FLOW TEMPLATE TYPES
// ============================================

export type FlowTemplateType =
  | 'order_tracking'
  | 'return_request'
  | 'feedback'
  | 'reorder';

// ============================================
// INTERACTIVE MESSAGE STRUCTURE
// ============================================

export interface WhatsAppInteractiveMessage {
  type: 'button' | 'list';
  header?: WhatsAppInteractiveHeader;
  body: WhatsAppInteractiveBody;
  footer?: WhatsAppInteractiveFooter;
  action: WhatsAppButtonAction | WhatsAppListAction;
}

export interface WhatsAppInteractiveHeader {
  type: 'text' | 'image' | 'video' | 'document';
  text?: string;
  image?: {
    id?: string;
    link?: string;
  };
}

export interface WhatsAppInteractiveBody {
  text: string;
}

export interface WhatsAppInteractiveFooter {
  text: string;
}

// ============================================
// BUTTON ACTION
// ============================================

export interface WhatsAppButtonAction {
  buttons: WhatsAppButton[];
}

export interface WhatsAppButton {
  type: 'reply';
  reply: {
    id: string;
    title: string;
  };
}

// ============================================
// LIST ACTION
// ============================================

export interface WhatsAppListAction {
  button: string;
  sections: WhatsAppListSection[];
}

export interface WhatsAppListSection {
  title: string;
  rows: WhatsAppListRow[];
}

export interface WhatsAppListRow {
  id: string;
  title: string;
  description?: string;
}

// ============================================
// TEMPLATE DATA INPUTS
// ============================================

export interface OrderTrackingData {
  orderId: number;
  status: string;
  eta?: string;
  storeName?: string;
  riderName?: string;
  riderPhone?: string;
  items?: Array<{ name: string; qty: number }>;
}

export interface ReturnRequestData {
  orderId: number;
  items: Array<{
    id: number;
    name: string;
    quantity: number;
    price: number;
  }>;
  storeName?: string;
}

export interface FeedbackData {
  orderId: number;
  storeName: string;
  deliveryTime?: string;
}

export interface ReorderData {
  lastOrder: {
    id: number;
    storeName: string;
    items: Array<{
      id: number;
      name: string;
      quantity: number;
      price: number;
    }>;
    total: number;
    orderedAt: string;
  };
}

// ============================================
// RETURN REASONS
// ============================================

export type ReturnReason =
  | 'wrong_item'
  | 'damaged'
  | 'quality_issue'
  | 'missing_item'
  | 'not_as_described'
  | 'other';

export const RETURN_REASONS: Record<ReturnReason, string> = {
  wrong_item: 'Wrong item received',
  damaged: 'Item was damaged',
  quality_issue: 'Quality not satisfactory',
  missing_item: 'Item missing from order',
  not_as_described: 'Not as described',
  other: 'Other reason',
};
