import { nestjsClient } from '../nestjs-client'
import type { ApiResponse, VendorDashboard, EarningReport } from '@/types/nestjs/api'

export const nestjsVendorDashboard = {
  getStats: () =>
    nestjsClient.get<ApiResponse<VendorDashboard>>('/vendor/dashboard/stats'),

  getEarningReport: (params?: { from?: string; to?: string }) => {
    const query = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) query.set(k, String(v))
      })
    }
    return nestjsClient.get<ApiResponse<EarningReport[]>>(`/vendor/dashboard/earning-report?${query}`)
  },

  getExpenseReport: (params?: { from?: string; to?: string }) => {
    const query = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) query.set(k, String(v))
      })
    }
    return nestjsClient.get<ApiResponse<Record<string, unknown>[]>>(`/vendor/dashboard/expense-report?${query}`)
  },

  getTaxReport: (params?: { from?: string; to?: string }) => {
    const query = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) query.set(k, String(v))
      })
    }
    return nestjsClient.get<ApiResponse<Record<string, unknown>[]>>(`/vendor/dashboard/tax-report?${query}`)
  },

  getDisbursementReport: (params?: { from?: string; to?: string }) => {
    const query = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) query.set(k, String(v))
      })
    }
    return nestjsClient.get<ApiResponse<Record<string, unknown>[]>>(`/vendor/dashboard/disbursement-report?${query}`)
  },

  getReviews: (params?: { page?: number; limit?: number }) => {
    const query = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) query.set(k, String(v))
      })
    }
    return nestjsClient.get<ApiResponse<Record<string, unknown>[]>>(`/vendor/reviews?${query}`)
  },
}
