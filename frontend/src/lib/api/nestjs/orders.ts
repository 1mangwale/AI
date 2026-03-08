import { nestjsClient } from '../nestjs-client'
import type { ApiResponse, PaginatedResponse, Order, TrackingData } from '@/types/nestjs/api'

// Routes match PHP Laravel backend (new.mangwale.com) API structure
export const nestjsOrders = {
  // Customer endpoints — /api/v1/customer/order/*
  list: (params?: { page?: number; limit?: number; status?: string }) => {
    const query = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) query.set(k, String(v))
      })
    }
    return nestjsClient.get<PaginatedResponse<Order>>(`/customer/order/list?${query}`)
  },

  get: (id: number) =>
    nestjsClient.get<ApiResponse<Order>>(`/customer/order/details?order_id=${id}`),

  place: (data: {
    store_id: number
    delivery_address_id: number
    payment_method: string
    order_type: 'delivery' | 'take_away'
    order_note?: string
    schedule_at?: string
    delivery_slot_id?: number
    coupon_code?: string
  }) =>
    nestjsClient.post<ApiResponse<Order>>('/customer/order/place', data),

  cancel: (id: number, reason?: string) =>
    nestjsClient.put<ApiResponse<Order>>('/customer/order/cancel', { order_id: id, reason }),

  track: (id: number) =>
    nestjsClient.get<ApiResponse<TrackingData>>(`/customer/order/track?order_id=${id}`),

  reorder: (id: number) =>
    nestjsClient.post<ApiResponse<{ cart_count: number }>>('/customer/order/reorder', { order_id: id }),

  // Vendor endpoints — /api/v1/vendor/*
  vendor: {
    list: (params?: { page?: number; limit?: number; status?: string }) => {
      const query = new URLSearchParams()
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined) query.set(k, String(v))
        })
      }
      return nestjsClient.get<PaginatedResponse<Order>>(`/vendor/all-orders?${query}`)
    },

    get: (id: number) =>
      nestjsClient.get<ApiResponse<Order>>(`/vendor/order/details?order_id=${id}`),

    updateStatus: (id: number, status: string) =>
      nestjsClient.put<ApiResponse<Order>>('/vendor/order/update-status', { order_id: id, order_status: status }),

    assignDeliveryMan: (orderId: number, deliveryManId: number) =>
      nestjsClient.put<ApiResponse<Order>>('/vendor/order/assign-delivery-man', { order_id: orderId, delivery_man_id: deliveryManId }),
  },

  // Rider endpoints — /api/v1/delivery-man/*
  rider: {
    available: () =>
      nestjsClient.get<PaginatedResponse<Order>>('/delivery-man/latest-orders'),

    assigned: () =>
      nestjsClient.get<PaginatedResponse<Order>>('/delivery-man/current-orders'),

    get: (id: number) =>
      nestjsClient.get<ApiResponse<Order>>(`/delivery-man/order?order_id=${id}`),

    updateStatus: (id: number, status: string) =>
      nestjsClient.put<ApiResponse<Order>>('/delivery-man/update-order-status', { order_id: id, order_status: status }),

    updateLocation: (lat: number, lng: number) =>
      nestjsClient.post<ApiResponse<null>>('/delivery-man/record-location-data', { latitude: lat, longitude: lng }),
  },

  // Admin endpoints
  admin: {
    list: (params?: { page?: number; limit?: number; status?: string; store_id?: number; search?: string }) => {
      const query = new URLSearchParams()
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined) query.set(k, String(v))
        })
      }
      return nestjsClient.get<PaginatedResponse<Order>>(`/admin/orders?${query}`)
    },

    get: (id: number) =>
      nestjsClient.get<ApiResponse<Order>>(`/admin/order/details?order_id=${id}`),
  },
}
