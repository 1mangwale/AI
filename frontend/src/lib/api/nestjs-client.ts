// API Client for NestJS Commerce Backend
// Pattern from admin-backend.ts — singleton class with typed methods

import { useNestjsAuthStore } from '@/store/nestjsAuthStore'

const NESTJS_BASE_URL = '/napi/v1'

class NestjsClient {
  private baseUrl: string

  constructor() {
    this.baseUrl = NESTJS_BASE_URL
  }

  private getAuthHeaders(): Record<string, string> {
    const token = useNestjsAuthStore.getState().token
    if (token) {
      return { Authorization: `Bearer ${token}` }
    }
    return {}
  }

  async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.getAuthHeaders(),
      ...(options.headers as Record<string, string>),
    }

    const response = await fetch(url, {
      ...options,
      headers,
    })

    if (response.status === 401) {
      useNestjsAuthStore.getState().clearAuth()
      if (typeof window !== 'undefined') {
        const path = window.location.pathname
        if (path.startsWith('/vendor')) {
          window.location.href = '/vendor/login'
        } else if (path.startsWith('/rider')) {
          window.location.href = '/rider/login'
        } else {
          window.location.href = '/shop/login'
        }
      }
      throw new Error('Session expired. Please log in again.')
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.message || `API Error: ${response.statusText}`)
    }

    return response.json()
  }

  async requestFormData<T>(
    endpoint: string,
    formData: FormData
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`
    const headers: Record<string, string> = {
      ...this.getAuthHeaders(),
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    })

    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.message || `Upload failed: ${response.statusText}`)
    }

    return response.json()
  }

  get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint)
  }

  post<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  put<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  patch<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' })
  }
}

export const nestjsClient = new NestjsClient()
