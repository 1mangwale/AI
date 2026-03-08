import { nestjsClient } from '../nestjs-client'
import type { ApiResponse, PaginatedResponse, Item, Category } from '@/types/nestjs/api'

// Routes match PHP Laravel backend (new.mangwale.com) API structure
export const nestjsItems = {
  // Customer endpoints — /api/v1/items/*
  list: (params?: { store_id?: number; category_id?: number; page?: number; limit?: number; search?: string; sort?: string }) => {
    const query = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) query.set(k, String(v))
      })
    }
    return nestjsClient.get<PaginatedResponse<Item>>(`/items/get-products?${query}`)
  },

  get: (id: number) =>
    nestjsClient.get<ApiResponse<Item>>(`/items/details/${id}`),

  popular: (moduleId?: number) =>
    nestjsClient.get<ApiResponse<Item[]>>(`/items/popular${moduleId ? `?module_id=${moduleId}` : ''}`),

  search: (query: string, moduleId?: number) =>
    nestjsClient.get<ApiResponse<Item[]>>(`/items/item-or-store-search?name=${encodeURIComponent(query)}${moduleId ? `&module_id=${moduleId}` : ''}`),

  // Categories
  getCategories: (moduleId?: number) =>
    nestjsClient.get<ApiResponse<Category[]>>(`/categories${moduleId ? `?module_id=${moduleId}` : ''}`),

  // Vendor endpoints — /api/v1/vendor/item/*
  vendor: {
    list: (params?: { store_id?: number; page?: number; limit?: number; search?: string }) => {
      const query = new URLSearchParams()
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined) query.set(k, String(v))
        })
      }
      return nestjsClient.get<PaginatedResponse<Item>>(`/vendor/item/list?${query}`)
    },

    get: (id: number) =>
      nestjsClient.get<ApiResponse<Item>>(`/vendor/item/details/${id}`),

    create: (data: Partial<Item>) =>
      nestjsClient.post<ApiResponse<Item>>('/vendor/item/store', data),

    update: (id: number, data: Partial<Item>) =>
      nestjsClient.put<ApiResponse<Item>>(`/vendor/item/update`, { id, ...data }),

    delete: (id: number) =>
      nestjsClient.delete<ApiResponse<null>>(`/vendor/item/delete?id=${id}`),

    updateStatus: (id: number, status: boolean) =>
      nestjsClient.post<ApiResponse<Item>>('/vendor/item/status', { id, status: status ? 1 : 0 }),
  },

  // Admin endpoints
  admin: {
    list: (params?: { page?: number; limit?: number; search?: string; store_id?: number }) => {
      const query = new URLSearchParams()
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          if (v !== undefined) query.set(k, String(v))
        })
      }
      return nestjsClient.get<PaginatedResponse<Item>>(`/admin/item/list?${query}`)
    },
  },
}
