import { nestjsClient } from '../nestjs-client'
import type { ApiResponse, PaginatedResponse, WalletTransaction, LoyaltyTransaction, SavedPaymentMethod, Settlement } from '@/types/nestjs/api'

export const nestjsPayments = {
  // Wallet
  // Wallet — PHP uses customer/wallet/* routes
  getWalletBalance: () =>
    nestjsClient.get<ApiResponse<{ balance: number }>>('/customer/info'),

  getWalletTransactions: (params?: { page?: number; limit?: number }) => {
    const query = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) query.set(k, String(v))
      })
    }
    return nestjsClient.get<PaginatedResponse<WalletTransaction>>(`/customer/wallet/transactions?${query}`)
  },

  addFundsToWallet: (amount: number, paymentMethod: string) =>
    nestjsClient.post<ApiResponse<WalletTransaction>>('/customer/wallet/add-fund', { amount, payment_method: paymentMethod }),

  // Loyalty
  getLoyaltyBalance: () =>
    nestjsClient.get<ApiResponse<{ points: number }>>('/customer/info'),

  getLoyaltyTransactions: (params?: { page?: number; limit?: number }) => {
    const query = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) query.set(k, String(v))
      })
    }
    return nestjsClient.get<PaginatedResponse<LoyaltyTransaction>>(`/customer/loyalty-point/transactions?${query}`)
  },

  transferLoyaltyToWallet: (points: number) =>
    nestjsClient.post<ApiResponse<{ wallet_amount: number }>>('/customer/loyalty-point/point-transfer', { point: points }),

  // Saved Payment Methods — PHP uses config for available methods
  getSavedMethods: () =>
    nestjsClient.get<ApiResponse<SavedPaymentMethod[]>>('/config'),

  addPaymentMethod: (data: { payment_method: string; token: string }) =>
    nestjsClient.post<ApiResponse<SavedPaymentMethod>>('/customer/payment-methods', data),

  setDefaultMethod: (id: number) =>
    nestjsClient.patch<ApiResponse<SavedPaymentMethod>>(`/customer/payment-methods/${id}/default`),

  deletePaymentMethod: (id: number) =>
    nestjsClient.delete<ApiResponse<null>>(`/customer/payment-methods/${id}`),

  // Admin: Settlements
  admin: {
    getSettlements: (params?: { page?: number; limit?: number; status?: string; store_id?: number }) => {
      const query = new URLSearchParams()
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined) query.set(k, String(v))
        })
      }
      return nestjsClient.get<PaginatedResponse<Settlement>>(`/admin/settlements?${query}`)
    },

    getPayments: (params?: { page?: number; limit?: number; method?: string }) => {
      const query = new URLSearchParams()
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined) query.set(k, String(v))
        })
      }
      return nestjsClient.get<PaginatedResponse<Record<string, unknown>>>(`/admin/payments?${query}`)
    },

    getOfflinePayments: (params?: { page?: number; limit?: number; status?: string }) => {
      const query = new URLSearchParams()
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined) query.set(k, String(v))
        })
      }
      return nestjsClient.get<PaginatedResponse<Record<string, unknown>>>(`/admin/offline-payments?${query}`)
    },

    verifyOfflinePayment: (id: number, approved: boolean, note?: string) =>
      nestjsClient.put<ApiResponse<Record<string, unknown>>>(`/admin/offline-payments/${id}/verify`, { approved, note }),
  },
}
