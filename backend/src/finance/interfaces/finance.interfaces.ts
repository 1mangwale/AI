/**
 * Finance Module Interfaces
 *
 * Core types for commission calculation, settlement batching,
 * fee breakdowns, and vendor payouts.
 */

export interface CommissionResult {
  orderId: number;
  orderAmount: number;
  commissionRate: number;
  platformFee: number;
  gstOnCommission: number;
  tdsAmount: number;
  netVendorPayout: number;
  breakdown: FeeBreakdown;
}

export interface CommissionRule {
  id: string;
  storeId?: number;
  moduleId: number;
  zoneId?: number;
  commissionRate: number;
  minOrderAmount?: number;
  maxCommission?: number;
  priority: number;
  isActive: boolean;
  createdAt: Date;
}

export interface SettlementBatch {
  id: string;
  storeId: number;
  storeName?: string;
  periodStart: Date;
  periodEnd: Date;
  status: 'draft' | 'confirmed' | 'processing' | 'paid' | 'failed';
  totalOrders: number;
  totalOrderAmount: number;
  totalCommission: number;
  totalDeductions: number;
  netPayoutAmount: number;
  createdAt: Date;
  confirmedAt?: Date;
  paidAt?: Date;
}

export interface FeeBreakdown {
  orderAmount: number;
  platformFee: number;
  deliveryCharge: number;
  packagingCharge: number;
  gstAmount: number;
  cgst: number;
  sgst: number;
  tdsAmount: number;
  totalCustomerPays: number;
  vendorReceives: number;
}

export interface PayoutRecord {
  id: string;
  settlementId: string;
  storeId: number;
  amount: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  paymentReference?: string;
  processedAt?: Date;
}

export interface CommissionStatsResult {
  totalCommissions: number;
  totalPlatformFee: number;
  totalGst: number;
  totalTds: number;
  totalVendorPayout: number;
  orderCount: number;
}

export interface StoreCommissionSummary {
  storeId: number;
  totalOrders: number;
  totalOrderAmount: number;
  totalCommission: number;
  totalGst: number;
  totalTds: number;
  totalVendorPayout: number;
}

export interface FeeCalculationInput {
  orderAmount: number;
  deliveryCharge: number;
  moduleId: number;
  paymentMethod: string;
  couponDiscount?: number;
  packagingCharge?: number;
}

export interface DeliveryChargeInput {
  distanceKm: number;
  moduleId: number;
  surgeMultiplier?: number;
}
