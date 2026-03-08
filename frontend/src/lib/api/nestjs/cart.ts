import { nestjsClient } from '../nestjs-client'
import type { ApiResponse, Cart, CartItem } from '@/types/nestjs/api'

// Routes match PHP Laravel backend (new.mangwale.com) API structure
export const nestjsCart = {
  get: () =>
    nestjsClient.get<ApiResponse<Cart>>('/customer/cart/list'),

  addItem: (data: {
    item_id: number
    quantity: number
    variation?: { name: string; optionPrice: number }[]
    add_ons?: { id: number; quantity: number }[]
    special_instructions?: string
  }) =>
    nestjsClient.post<ApiResponse<CartItem>>('/customer/cart/add', data),

  updateQuantity: (cartItemId: string, quantity: number) =>
    nestjsClient.post<ApiResponse<CartItem>>('/customer/cart/update', { cart_id: cartItemId, quantity }),

  removeItem: (cartItemId: string) =>
    nestjsClient.delete<ApiResponse<null>>(`/customer/cart/remove?cart_id=${cartItemId}`),

  clear: () =>
    nestjsClient.delete<ApiResponse<null>>('/customer/cart/remove'),

  applyCoupon: (code: string) =>
    nestjsClient.post<ApiResponse<Cart>>('/customer/coupon/apply', { code }),

  removeCoupon: () =>
    nestjsClient.delete<ApiResponse<Cart>>('/customer/coupon/remove'),
}
