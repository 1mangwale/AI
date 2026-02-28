/**
 * Returns Module Interfaces
 *
 * Core types for return requests, return policies,
 * and refund processing.
 */

export interface ReturnRequest {
  id: string;
  orderId: number;
  userId?: string;
  reason: string;
  status:
    | 'pending'
    | 'under_review'
    | 'approved'
    | 'rejected'
    | 'refund_initiated'
    | 'refund_completed';
  refundAmount?: number;
  refundMethod: 'original' | 'wallet';
  evidenceUrls?: string[];
  adminNotes?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReturnPolicy {
  id: string;
  moduleId: number;
  categoryId?: number;
  returnWindowHours: number;
  autoApproveThreshold: number;
  evidenceRequired: boolean;
  maxRefundAmount?: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateReturnRequestInput {
  orderId: number;
  userId?: string;
  reason: string;
  evidenceUrls?: string[];
  refundAmount?: number;
  refundMethod?: 'original' | 'wallet';
}

export interface ReturnRequestFilters {
  status?: string;
  userId?: string;
  orderId?: number;
}

export interface ReturnStats {
  totalRequests: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  refundInitiatedCount: number;
  refundCompletedCount: number;
  totalRefundAmount: number;
}
