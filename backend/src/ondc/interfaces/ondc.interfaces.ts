/**
 * ONDC / Beckn Protocol v1.1.0 Interfaces
 *
 * Open Network for Digital Commerce (ONDC) uses the Beckn protocol
 * for interoperable commerce transactions. These interfaces define
 * the data structures for BAP (Buyer App) and BPP (Seller App) communication.
 *
 * Reference: https://beckn.network/protocol/specifications
 */

// ============================================
// BECKN CONTEXT
// ============================================

export interface BecknContext {
  domain: string;                    // e.g., 'nic2004:52110' (food), 'nic2004:52200' (retail)
  country: string;                   // ISO 3166-1 alpha-3 country code, e.g., 'IND'
  city: string;                      // City code, e.g., 'std:020' (Nashik)
  action: BecknAction;              // The Beckn API action
  core_version: string;             // Protocol version, '1.1.0'
  bap_id: string;                   // Buyer App subscriber ID
  bap_uri: string;                  // Buyer App callback URI
  bpp_id?: string;                  // Seller App subscriber ID (filled by BPP)
  bpp_uri?: string;                 // Seller App endpoint URI (filled by BPP)
  transaction_id: string;           // Unique transaction ID across the lifecycle
  message_id: string;               // Unique per-message ID
  timestamp: string;                // ISO 8601 timestamp
  ttl?: string;                     // Time-to-live for the request, e.g., 'PT30S'
  key?: string;                     // Encryption key (optional)
}

export type BecknAction =
  | 'search'
  | 'on_search'
  | 'select'
  | 'on_select'
  | 'init'
  | 'on_init'
  | 'confirm'
  | 'on_confirm'
  | 'status'
  | 'on_status'
  | 'cancel'
  | 'on_cancel'
  | 'track'
  | 'on_track'
  | 'support'
  | 'on_support'
  | 'rating'
  | 'on_rating'
  | 'update'
  | 'on_update';

// ============================================
// BECKN MESSAGE
// ============================================

export interface BecknMessage {
  intent?: BecknIntent;
  order?: BecknOrder;
  catalog?: BecknCatalog;
}

export interface BecknIntent {
  item?: {
    descriptor?: {
      name?: string;
    };
    category_id?: string;
    price?: {
      minimum_value?: string;
      maximum_value?: string;
      currency?: string;
    };
  };
  fulfillment?: {
    type?: string;
    end?: {
      location?: {
        gps?: string;                // "lat,lng" format
        address?: {
          area_code?: string;
        };
      };
    };
  };
  payment?: {
    type?: string;                  // 'PRE-FULFILLMENT', 'POST-FULFILLMENT'
  };
  provider?: {
    id?: string;
  };
  category?: {
    id?: string;
  };
  tags?: BecknTag[];
}

// ============================================
// BECKN ORDER
// ============================================

export interface BecknOrder {
  id?: string;
  state?: string;
  provider?: {
    id: string;
    locations?: Array<{ id: string }>;
  };
  items?: BecknOrderItem[];
  billing?: BecknBilling;
  fulfillment?: BecknFulfillment;
  quote?: BecknQuote;
  payment?: BecknPayment;
  created_at?: string;
  updated_at?: string;
  tags?: BecknTag[];
}

export interface BecknOrderItem {
  id: string;
  quantity: {
    count: number;
  };
  fulfillment_id?: string;
}

export interface BecknBilling {
  name: string;
  phone: string;
  email?: string;
  address?: {
    door?: string;
    building?: string;
    street?: string;
    locality?: string;
    city?: string;
    state?: string;
    country?: string;
    area_code?: string;
  };
  created_at?: string;
  updated_at?: string;
}

export interface BecknFulfillment {
  id?: string;
  type?: string;                   // 'Delivery', 'Self-Pickup'
  tracking?: boolean;
  start?: {
    location?: {
      id?: string;
      gps?: string;
      address?: BecknAddress;
    };
    time?: {
      range?: {
        start: string;
        end: string;
      };
    };
    contact?: {
      phone?: string;
      email?: string;
    };
  };
  end?: {
    location?: {
      gps?: string;
      address?: BecknAddress;
    };
    time?: {
      range?: {
        start: string;
        end: string;
      };
    };
    contact?: {
      phone?: string;
      email?: string;
    };
  };
  agent?: {
    name?: string;
    phone?: string;
  };
  vehicle?: {
    registration?: string;
  };
  state?: {
    descriptor?: {
      code?: string;               // 'Pending', 'Packed', 'Order-picked-up', 'Out-for-delivery', 'Order-delivered'
    };
  };
  tags?: BecknTag[];
}

export interface BecknAddress {
  door?: string;
  building?: string;
  street?: string;
  locality?: string;
  ward?: string;
  city?: string;
  state?: string;
  country?: string;
  area_code?: string;
  name?: string;
}

// ============================================
// BECKN QUOTE & PAYMENT
// ============================================

export interface BecknQuote {
  price: {
    currency: string;
    value: string;
  };
  breakup: BecknQuoteBreakup[];
  ttl?: string;
}

export interface BecknQuoteBreakup {
  title: string;
  price: {
    currency: string;
    value: string;
  };
  '@ondc/org/item_id'?: string;
  '@ondc/org/item_quantity'?: {
    count: number;
  };
  '@ondc/org/title_type'?: string;  // 'item', 'delivery', 'packing', 'tax', 'discount'
}

export interface BecknPayment {
  uri?: string;
  type?: string;                    // 'PRE-FULFILLMENT', 'ON-FULFILLMENT', 'POST-FULFILLMENT'
  status?: string;                  // 'PAID', 'NOT-PAID'
  params?: {
    amount?: string;
    currency?: string;
    transaction_id?: string;
  };
  tl_method?: string;              // 'http/get', 'http/post'
  collected_by?: string;           // 'BAP', 'BPP'
  '@ondc/org/buyer_app_finder_fee_type'?: string;
  '@ondc/org/buyer_app_finder_fee_amount'?: string;
  '@ondc/org/settlement_basis'?: string;
  '@ondc/org/settlement_window'?: string;
  '@ondc/org/withholding_amount'?: string;
}

// ============================================
// BECKN CATALOG
// ============================================

export interface BecknCatalog {
  'bpp/descriptor'?: {
    name: string;
    short_desc?: string;
    long_desc?: string;
    images?: string[];
  };
  'bpp/providers'?: BecknProvider[];
  'bpp/fulfillments'?: BecknFulfillment[];
}

export interface BecknProvider {
  id: string;
  descriptor: {
    name: string;
    short_desc?: string;
    long_desc?: string;
    images?: string[];
  };
  locations?: BecknProviderLocation[];
  items?: CatalogItem[];
  categories?: Array<{
    id: string;
    descriptor: {
      name: string;
    };
  }>;
  fulfillments?: BecknFulfillment[];
  tags?: BecknTag[];
  time?: {
    label?: string;
    timestamp?: string;
    range?: {
      start: string;
      end: string;
    };
  };
}

export interface BecknProviderLocation {
  id: string;
  gps: string;
  address?: BecknAddress;
  time?: {
    label?: string;
    range?: {
      start: string;
      end: string;
    };
    days?: string;
    schedule?: {
      holidays?: string[];
    };
  };
}

// ============================================
// CATALOG ITEM
// ============================================

export interface CatalogItem {
  id: string;
  descriptor: {
    name: string;
    short_desc?: string;
    long_desc?: string;
    images?: string[];
    symbol?: string;
    code?: string;
  };
  price: {
    listed_value: string;
    currency: string;
    value?: string;
    maximum_value?: string;
    offered_value?: string;
  };
  category_id: string;
  fulfillment_id: string;
  location_id: string;
  available: boolean;
  quantity?: {
    available: {
      count: number;
    };
    maximum?: {
      count: number;
    };
  };
  tags?: BecknTag[];
  '@ondc/org/returnable'?: boolean;
  '@ondc/org/cancellable'?: boolean;
  '@ondc/org/return_window'?: string;
  '@ondc/org/time_to_ship'?: string;
  '@ondc/org/available_on_cod'?: boolean;
}

// ============================================
// BECKN TAG
// ============================================

export interface BecknTag {
  code?: string;
  list?: Array<{
    code: string;
    value: string;
  }>;
}

// ============================================
// ONDC TRANSACTION (internal tracking)
// ============================================

export type OndcTransactionStatus =
  | 'initiated'
  | 'in_progress'
  | 'completed'
  | 'error'
  | 'timeout';

export interface OndcTransaction {
  id: string;
  transaction_id: string;
  message_id: string;
  action: BecknAction;
  bap_id: string | null;
  bpp_id: string | null;
  request_payload: any;
  response_payload: any;
  status: OndcTransactionStatus;
  created_at: Date;
  updated_at: Date;
}

// ============================================
// REQUEST / RESPONSE WRAPPERS
// ============================================

export interface OndcSearchRequest {
  context: BecknContext;
  message: {
    intent: BecknIntent;
  };
}

export interface OndcSearchResponse {
  context: BecknContext;
  message: {
    catalog: BecknCatalog;
  };
}

export interface OndcOrderRequest {
  context: BecknContext;
  message: {
    order: BecknOrder;
  };
}

export interface OndcOrderResponse {
  context: BecknContext;
  message: {
    order: BecknOrder;
  };
}

export interface OndcAckResponse {
  context: BecknContext;
  message: {
    ack: {
      status: 'ACK' | 'NACK';
    };
  };
  error?: {
    type: string;
    code: string;
    path?: string;
    message?: string;
  };
}
