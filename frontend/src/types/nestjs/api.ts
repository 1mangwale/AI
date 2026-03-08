// NestJS Commerce Backend Types
// Matches the Mangwale NESTJS backend API responses

// ==========================================
// Common
// ==========================================

export interface ApiResponse<T> {
  success: boolean
  data: T
  timestamp: string
}

export interface PaginatedResponse<T> {
  success: boolean
  data: T[]
  meta: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
  timestamp: string
}

export interface ApiError {
  success: false
  statusCode: number
  timestamp: string
  path: string
  method: string
  message: string
  errors?: Record<string, string[]>
}

// ==========================================
// Auth
// ==========================================

export type UserType = 'customer' | 'vendor' | 'delivery_man' | 'admin'

export interface NestjsUser {
  id: number
  f_name: string
  l_name: string
  email: string
  phone: string
  image?: string
  user_type: UserType
  is_active: boolean
  zone_id?: number
  created_at: string
}

export interface LoginResponse {
  success: boolean
  data: {
    token: string
    user: NestjsUser
  }
  timestamp: string
}

export interface OtpResponse {
  success: boolean
  data: { message: string }
  timestamp: string
}

// ==========================================
// Stores
// ==========================================

export interface Store {
  id: number
  name: string
  phone: string
  email: string
  logo: string
  cover_photo?: string
  address: string
  latitude: number
  longitude: number
  zone_id: number
  module_id: number
  module?: Module
  status: boolean
  active: boolean
  delivery: boolean
  take_away: boolean
  schedule_order: boolean
  avg_rating: number
  rating_count: number
  minimum_order: number
  tax: number
  comission: number
  delivery_time: string
  opening_time: string
  closing_time: string
  off_day: string
  free_delivery: boolean
  distance?: number
  created_at: string
}

export interface Module {
  id: number
  module_name: string
  module_type: string
  thumbnail: string
  icon: string
  stores_count: number
}

// ==========================================
// Items
// ==========================================

export interface Item {
  id: number
  name: string
  description: string
  image: string
  images: string[]
  store_id: number
  store?: Store
  category_id: number
  category?: Category
  unit_id?: number
  price: number
  discount: number
  discount_type: 'percent' | 'amount'
  available_time_starts?: string
  available_time_ends?: string
  veg: boolean
  status: boolean
  stock: number
  avg_rating: number
  rating_count: number
  variations: ItemVariation[]
  add_ons: AddOn[]
  tags: string[]
  created_at: string
}

export interface ItemVariation {
  name: string
  type: 'single' | 'multi'
  min: number
  max: number
  required: boolean
  values: ItemVariationOption[]
}

export interface ItemVariationOption {
  label: string
  optionPrice: number
}

export interface AddOn {
  id: number
  name: string
  price: number
  status: boolean
}

export interface Category {
  id: number
  name: string
  image: string
  parent_id?: number
  position: number
  status: boolean
  module_id: number
}

// ==========================================
// Cart
// ==========================================

export interface CartItem {
  id: string // client-side ID
  item_id: number
  item: Item
  store_id: number
  quantity: number
  price: number
  variation: ItemVariationOption[]
  add_ons: { id: number; quantity: number }[]
  special_instructions?: string
}

export interface Cart {
  items: CartItem[]
  store_id: number
  store?: Store
  subtotal: number
  tax: number
  delivery_charge: number
  discount: number
  total: number
}

// ==========================================
// Orders
// ==========================================

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'handover'
  | 'picked_up'
  | 'delivered'
  | 'cancelled'
  | 'failed'
  | 'refunded'

export type PaymentStatus = 'unpaid' | 'paid' | 'partially_paid' | 'refunded'

export interface Order {
  id: number
  user_id: number
  user?: NestjsUser
  store_id: number
  store?: Store
  delivery_man_id?: number
  delivery_man?: NestjsUser
  order_amount: number
  coupon_discount_amount: number
  coupon_discount_title?: string
  payment_status: PaymentStatus
  order_status: OrderStatus
  payment_method: string
  transaction_reference?: string
  delivery_address: DeliveryAddress
  delivery_charge: number
  original_delivery_charge: number
  tax_amount: number
  tax_percentage: number
  order_type: 'delivery' | 'take_away'
  scheduled: boolean
  schedule_at?: string
  otp?: string
  pending?: string
  confirmed?: string
  processing?: string
  handover?: string
  picked_up?: string
  delivered?: string
  cancelled?: string
  cancellation_reason?: string
  order_note?: string
  details: OrderDetail[]
  created_at: string
  updated_at: string
}

export interface OrderDetail {
  id: number
  item_id: number
  item_details: Item
  quantity: number
  price: number
  discount_on_item: number
  tax_amount: number
  variation: string
  add_ons: string
  total_add_on_price: number
}

export interface DeliveryAddress {
  id?: number
  address_type: 'home' | 'office' | 'other'
  contact_person_name: string
  contact_person_number: string
  address: string
  latitude: number
  longitude: number
  road?: string
  house?: string
  floor?: string
  zone_id?: number
}

// ==========================================
// Payments & Wallet
// ==========================================

export interface WalletTransaction {
  id: number
  user_id: number
  transaction_id: string
  credit: number
  debit: number
  balance: number
  transaction_type: string
  reference: string
  created_at: string
}

export interface LoyaltyTransaction {
  id: number
  user_id: number
  transaction_id: string
  credit: number
  debit: number
  balance: number
  transaction_type: string
  reference: string
  created_at: string
}

export interface SavedPaymentMethod {
  id: number
  user_id: number
  payment_method: string
  card_last4?: string
  card_brand?: string
  token: string
  is_default: boolean
  created_at: string
}

// ==========================================
// Delivery
// ==========================================

export interface DeliverySlot {
  id: number
  store_id: number
  date: string
  start_time: string
  end_time: string
  max_orders: number
  booked_orders: number
  available: boolean
}

export interface TrackingData {
  order_id: number
  delivery_man: {
    id: number
    name: string
    phone: string
    image?: string
    latitude: number
    longitude: number
  }
  order_status: OrderStatus
  estimated_delivery_time?: string
}

// ==========================================
// Config
// ==========================================

export interface PlatformConfig {
  business_name: string
  logo: string
  address: string
  phone: string
  email: string
  base_url: string
  currency_symbol: string
  currency_symbol_direction: 'left' | 'right'
  maintenance_mode: boolean
  cash_on_delivery: boolean
  digital_payment: boolean
  free_delivery_over?: number
  loyalty_point_exchange_rate?: number
  minimum_point_to_transfer?: number
  modules: Module[]
  active_payment_methods: string[]
  social_login: { google: boolean; facebook: boolean; apple: boolean }
  toggle_veg_non_veg: boolean
  toggle_dm_registration: boolean
  toggle_store_registration: boolean
}

export interface ContentPage {
  id: number
  key: string
  value: string
}

export interface FAQ {
  id: number
  question: string
  answer: string
  status: boolean
}

// ==========================================
// Vendor Dashboard
// ==========================================

export interface VendorDashboard {
  total_orders: number
  total_earning: number
  total_items: number
  avg_rating: number
  today_orders: number
  today_earning: number
  pending_orders: number
  processing_orders: number
}

export interface EarningReport {
  date: string
  orders: number
  earning: number
  commission: number
  tax: number
  net_earning: number
}

// ==========================================
// Admin
// ==========================================

export interface AdminRole {
  id: number
  name: string
  modules: string[]
  is_active: boolean
  permissions: Permission[]
  created_at: string
}

export interface Permission {
  id: number
  resource: string
  action: string
  role_id: number
}

export interface Subscription {
  id: number
  title: string
  price: number
  validity: number
  max_stores: number
  max_items: number
  max_orders: number
  pos: boolean
  mobile_app: boolean
  chat: boolean
  review: boolean
  self_delivery: boolean
  status: boolean
}

export interface Zone {
  id: number
  name: string
  coordinates: { lat: number; lng: number }[]
  status: boolean
  store_wise_topic?: string
  customer_wise_topic?: string
  deliveryman_wise_topic?: string
  minimum_delivery_charge: number
  maximum_delivery_charge: number
  per_km_delivery_charge: number
}

export interface Settlement {
  id: number
  store_id: number
  store?: Store
  amount: number
  status: 'pending' | 'completed' | 'failed'
  method: string
  reference?: string
  period_start: string
  period_end: string
  created_at: string
}
