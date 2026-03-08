'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Minus, Plus, Trash2, ShoppingBag, ArrowRight } from 'lucide-react'
import { nestjsCart } from '@/lib/api/nestjs/cart'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Button } from '@/components/ui/button'
import type { Cart, CartItem } from '@/types/nestjs/api'

export default function CartPage() {
  const router = useRouter()
  const { isAuthenticated } = useNestjsAuth()
  const toast = useToast()

  const [cart, setCart] = useState<Cart | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)

  const fetchCart = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false)
      return
    }
    try {
      const res = await nestjsCart.get()
      if (res.data) setCart(res.data)
    } catch {
      toast.error('Failed to load cart')
    } finally {
      setLoading(false)
    }
  }, [isAuthenticated, toast])

  useEffect(() => {
    fetchCart()
  }, [fetchCart])

  const handleUpdateQuantity = async (cartItem: CartItem, delta: number) => {
    const newQty = cartItem.quantity + delta
    if (newQty < 1) return
    setUpdating(cartItem.id)
    try {
      await nestjsCart.updateQuantity(cartItem.id, newQty)
      await fetchCart()
    } catch {
      toast.error('Failed to update quantity')
    } finally {
      setUpdating(null)
    }
  }

  const handleRemoveItem = async (cartItem: CartItem) => {
    setUpdating(cartItem.id)
    try {
      await nestjsCart.removeItem(cartItem.id)
      toast.success('Item removed from cart')
      await fetchCart()
    } catch {
      toast.error('Failed to remove item')
    } finally {
      setUpdating(null)
    }
  }

  const handleClearCart = async () => {
    try {
      await nestjsCart.clear()
      toast.success('Cart cleared')
      setCart(null)
    } catch {
      toast.error('Failed to clear cart')
    }
  }

  // Group items by store_id
  const groupedItems: Record<number, CartItem[]> = {}
  if (cart?.items) {
    cart.items.forEach((item) => {
      const sid = item.store_id
      if (!groupedItems[sid]) groupedItems[sid] = []
      groupedItems[sid].push(item)
    })
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <ShoppingBag size={48} className="text-gray-300 mb-4" />
        <p className="text-gray-500 mb-4">Please login to view your cart</p>
        <Link href="/shop/login">
          <Button className="bg-[#059211] hover:bg-[#047a0e] text-white">Login</Button>
        </Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <LoadingSpinner size="lg" text="Loading cart..." />
      </div>
    )
  }

  if (!cart || !cart.items || cart.items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <ShoppingBag size={48} className="text-gray-300 mb-4" />
        <h2 className="text-lg font-semibold text-gray-700 mb-1">Your cart is empty</h2>
        <p className="text-sm text-gray-500 mb-6">Add items from stores to get started</p>
        <Link href="/shop/stores">
          <Button className="bg-[#059211] hover:bg-[#047a0e] text-white">Browse Stores</Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="px-4 py-4 pb-44">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-bold text-gray-900">Your Cart</h1>
        <button
          onClick={handleClearCart}
          className="text-xs text-red-500 hover:text-red-600 font-medium"
        >
          Clear All
        </button>
      </div>

      {/* Cart Items grouped by store */}
      <div className="space-y-4">
        {Object.entries(groupedItems).map(([storeId, items]) => {
          const storeName = items[0]?.item?.store?.name || `Store #${storeId}`
          return (
            <div key={storeId} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                <Link
                  href={`/shop/stores/${storeId}`}
                  className="text-sm font-semibold text-gray-800 hover:text-[#059211]"
                >
                  {storeName}
                </Link>
              </div>

              <div className="divide-y divide-gray-50">
                {items.map((cartItem) => (
                  <div key={cartItem.id} className="px-4 py-3 flex gap-3">
                    {/* Image */}
                    <div className="relative w-16 h-16 bg-gray-100 rounded-lg shrink-0 overflow-hidden">
                      {cartItem.item?.image ? (
                        <Image
                          src={cartItem.item.image}
                          alt={cartItem.item.name}
                          fill
                          className="object-cover"
                          sizes="64px"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400 text-[10px]">
                          No img
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-medium text-gray-900 line-clamp-1">
                        {cartItem.item?.name || 'Item'}
                      </h3>
                      {cartItem.variation && cartItem.variation.length > 0 && (
                        <p className="text-xs text-gray-400 mt-0.5 truncate">
                          {cartItem.variation.map((v) => v.label).join(', ')}
                        </p>
                      )}
                      <p className="text-sm font-semibold text-gray-900 mt-1">
                        ₹{(cartItem.price * cartItem.quantity).toFixed(0)}
                      </p>
                    </div>

                    {/* Quantity Controls */}
                    <div className="flex flex-col items-end justify-between shrink-0">
                      <button
                        onClick={() => handleRemoveItem(cartItem)}
                        disabled={updating === cartItem.id}
                        className="text-gray-400 hover:text-red-500 p-1"
                      >
                        <Trash2 size={14} />
                      </button>
                      <div className="flex items-center gap-1 bg-gray-100 rounded-md">
                        <button
                          onClick={() => handleUpdateQuantity(cartItem, -1)}
                          disabled={updating === cartItem.id || cartItem.quantity <= 1}
                          className="w-7 h-7 flex items-center justify-center text-gray-600 hover:bg-gray-200 rounded-md disabled:opacity-40"
                        >
                          <Minus size={12} />
                        </button>
                        <span className="w-6 text-center text-xs font-semibold">
                          {updating === cartItem.id ? (
                            <LoadingSpinner size="sm" />
                          ) : (
                            cartItem.quantity
                          )}
                        </span>
                        <button
                          onClick={() => handleUpdateQuantity(cartItem, 1)}
                          disabled={updating === cartItem.id}
                          className="w-7 h-7 flex items-center justify-center text-gray-600 hover:bg-gray-200 rounded-md disabled:opacity-40"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Order Summary - Fixed Bottom */}
      <div className="fixed bottom-16 left-0 right-0 z-30 bg-white border-t border-gray-200 shadow-[0_-4px_20px_rgba(0,0,0,0.08)]">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="space-y-1 mb-3">
            <div className="flex justify-between text-sm text-gray-600">
              <span>Subtotal</span>
              <span>₹{cart.subtotal.toFixed(2)}</span>
            </div>
            {cart.tax > 0 && (
              <div className="flex justify-between text-sm text-gray-600">
                <span>Tax</span>
                <span>₹{cart.tax.toFixed(2)}</span>
              </div>
            )}
            {cart.delivery_charge > 0 && (
              <div className="flex justify-between text-sm text-gray-600">
                <span>Delivery</span>
                <span>₹{cart.delivery_charge.toFixed(2)}</span>
              </div>
            )}
            {cart.discount > 0 && (
              <div className="flex justify-between text-sm text-green-600">
                <span>Discount</span>
                <span>-₹{cart.discount.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold text-gray-900 pt-1 border-t border-gray-100">
              <span>Total</span>
              <span>₹{cart.total.toFixed(2)}</span>
            </div>
          </div>

          <Button
            onClick={() => router.push('/shop/checkout')}
            className="w-full bg-[#059211] hover:bg-[#047a0e] text-white h-11"
          >
            Proceed to Checkout
            <ArrowRight size={16} className="ml-2" />
          </Button>
        </div>
      </div>
    </div>
  )
}
