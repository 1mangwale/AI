import { nestjsClient } from '../nestjs-client'
import type { ApiResponse, PaginatedResponse, AdminRole, Subscription, NestjsUser } from '@/types/nestjs/api'

export const nestjsAdmin = {
  // Roles & Permissions
  getRoles: () =>
    nestjsClient.get<ApiResponse<AdminRole[]>>('/admin/roles'),

  createRole: (data: { name: string; modules: string[] }) =>
    nestjsClient.post<ApiResponse<AdminRole>>('/admin/roles', data),

  updateRole: (id: number, data: Partial<AdminRole>) =>
    nestjsClient.put<ApiResponse<AdminRole>>(`/admin/roles/${id}`, data),

  deleteRole: (id: number) =>
    nestjsClient.delete<ApiResponse<null>>(`/admin/roles/${id}`),

  // Users
  getUsers: (params?: { page?: number; limit?: number; search?: string; user_type?: string }) => {
    const query = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) query.set(k, String(v))
      })
    }
    return nestjsClient.get<PaginatedResponse<NestjsUser>>(`/admin/users?${query}`)
  },

  getUser: (id: number) =>
    nestjsClient.get<ApiResponse<NestjsUser>>(`/admin/users/${id}`),

  updateUserStatus: (id: number, status: boolean) =>
    nestjsClient.patch<ApiResponse<NestjsUser>>(`/admin/users/${id}/status`, { is_active: status }),

  // Subscriptions
  getSubscriptions: () =>
    nestjsClient.get<ApiResponse<Subscription[]>>('/admin/subscriptions'),

  createSubscription: (data: Partial<Subscription>) =>
    nestjsClient.post<ApiResponse<Subscription>>('/admin/subscriptions', data),

  updateSubscription: (id: number, data: Partial<Subscription>) =>
    nestjsClient.put<ApiResponse<Subscription>>(`/admin/subscriptions/${id}`, data),

  // Settings
  getSettings: () =>
    nestjsClient.get<ApiResponse<Record<string, string>>>('/admin/settings'),

  updateSettings: (settings: Record<string, string>) =>
    nestjsClient.put<ApiResponse<Record<string, string>>>('/admin/settings', settings),
}
