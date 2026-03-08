import { nestjsClient } from '../nestjs-client'
import type { ApiResponse, PaginatedResponse, DeliverySlot, DeliveryAddress, Zone, TrackingData } from '@/types/nestjs/api'

// Routes match PHP Laravel backend (new.mangwale.com) API structure
export const nestjsDelivery = {
  // Addresses — /api/v1/customer/address/*
  getAddresses: () =>
    nestjsClient.get<ApiResponse<DeliveryAddress[]>>('/customer/address/list'),

  addAddress: (data: Omit<DeliveryAddress, 'id'>) =>
    nestjsClient.post<ApiResponse<DeliveryAddress>>('/customer/address/add', data),

  updateAddress: (id: number, data: Partial<DeliveryAddress>) =>
    nestjsClient.put<ApiResponse<DeliveryAddress>>(`/customer/address/update/${id}`, data),

  deleteAddress: (id: number) =>
    nestjsClient.delete<ApiResponse<null>>(`/customer/address/delete?address_id=${id}`),

  // Delivery Slots
  getSlots: (storeId: number, date: string) =>
    nestjsClient.get<ApiResponse<DeliverySlot[]>>(`/customer/order/delivery-slots?store_id=${storeId}&date=${date}`),

  // Tracking
  trackOrder: (orderId: number) =>
    nestjsClient.get<ApiResponse<TrackingData>>(`/customer/order/track?order_id=${orderId}`),

  // Delivery Charges
  getCharges: (storeId: number, lat: number, lng: number) =>
    nestjsClient.get<ApiResponse<{ charge: number; distance: number }>>(`/customer/order/get-delivery-fee?store_id=${storeId}&latitude=${lat}&longitude=${lng}`),

  // Zones (Admin)
  admin: {
    getZones: () =>
      nestjsClient.get<ApiResponse<Zone[]>>('/admin/zone/list'),

    getZone: (id: number) =>
      nestjsClient.get<ApiResponse<Zone>>(`/admin/zone/${id}`),

    createZone: (data: Partial<Zone>) =>
      nestjsClient.post<ApiResponse<Zone>>('/admin/zone/store', data),

    updateZone: (id: number, data: Partial<Zone>) =>
      nestjsClient.put<ApiResponse<Zone>>(`/admin/zone/update/${id}`, data),

    deleteZone: (id: number) =>
      nestjsClient.delete<ApiResponse<null>>(`/admin/zone/delete?id=${id}`),

    getActiveDeliveries: () =>
      nestjsClient.get<PaginatedResponse<TrackingData>>('/admin/order/list?status=picked_up'),
  },

  // Rider — /api/v1/delivery-man/*
  rider: {
    getEarnings: (params?: { page?: number; limit?: number; from?: string; to?: string }) => {
      const query = new URLSearchParams()
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined) query.set(k, String(v))
        })
      }
      return nestjsClient.get<ApiResponse<{ total: number; today: number; transactions: unknown[] }>>(`/delivery-man/earning-report?${query}`)
    },

    getProfile: () =>
      nestjsClient.get<ApiResponse<Record<string, unknown>>>('/delivery-man/profile'),

    updateProfile: (data: Record<string, unknown>) =>
      nestjsClient.put<ApiResponse<Record<string, unknown>>>('/delivery-man/update-profile', data),
  },
}
