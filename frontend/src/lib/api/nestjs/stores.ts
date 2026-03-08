import { nestjsClient } from '../nestjs-client'
import type { ApiResponse, PaginatedResponse, Store, Module } from '@/types/nestjs/api'

// Routes match PHP Laravel backend (new.mangwale.com) API structure
export const nestjsStores = {
  // Customer endpoints — /api/v1/stores/*
  list: (params?: { module_id?: number; zone_id?: number; page?: number; limit?: number; search?: string; sort?: string }) => {
    const query = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) query.set(k, String(v))
      })
    }
    return nestjsClient.get<PaginatedResponse<Store>>(`/stores/get-stores/all?${query}`)
  },

  get: (id: number) =>
    nestjsClient.get<ApiResponse<Store>>(`/stores/details/${id}`),

  popular: (moduleId?: number) =>
    nestjsClient.get<ApiResponse<Store[]>>(`/stores/popular${moduleId ? `?module_id=${moduleId}` : ''}`),

  nearby: (lat: number, lng: number, radius?: number) =>
    nestjsClient.get<ApiResponse<Store[]>>(`/stores/get-stores/all?latitude=${lat}&longitude=${lng}${radius ? `&radius=${radius}` : ''}`),

  // Modules
  getModules: () =>
    nestjsClient.get<ApiResponse<Module[]>>('/module'),

  // Vendor endpoints
  vendor: {
    myStores: () =>
      nestjsClient.get<ApiResponse<Store[]>>('/vendor/profile'),

    getStore: (id: number) =>
      nestjsClient.get<ApiResponse<Store>>(`/vendor/profile`),

    updateStore: (id: number, data: Partial<Store>) =>
      nestjsClient.put<ApiResponse<Store>>('/vendor/update-profile', data),
  },

  // Admin endpoints
  admin: {
    list: (params?: { page?: number; limit?: number; search?: string; status?: string }) => {
      const query = new URLSearchParams()
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined) query.set(k, String(v))
        })
      }
      return nestjsClient.get<PaginatedResponse<Store>>(`/admin/store/list?${query}`)
    },

    get: (id: number) =>
      nestjsClient.get<ApiResponse<Store>>(`/admin/store/details/${id}`),

    updateStatus: (id: number, status: boolean) =>
      nestjsClient.post<ApiResponse<Store>>(`/admin/store/status`, { id, status: status ? 1 : 0 }),
  },
}
