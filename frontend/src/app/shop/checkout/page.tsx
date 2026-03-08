'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Tag, Clock, ShoppingBag } from 'lucide-react'
import { nestjsCart } from '@/lib/api/nestjs/cart'
import { nestjsOrders } from '@/lib/api/nestjs/orders'
import { nestjsDelivery } from '@/lib/api/nestjs/delivery'
import { nestjsPayments } from '@/lib/api/nestjs/payments'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useRazorpay } from '@/hooks/useRazorpay'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AddressSelector } from '@/components/shop/AddressSelector'
import { PaymentMethodSelector } from '@/components/shop/PaymentMethodSelector'
import type { Cart, DeliveryAddress, DeliverySlot } from '@/types/nestjs/api'

export default function CheckoutPage() {
  const router = useRouter()
  const { user, isAuthenticated } = useNestjsAuth()
  const { initiatePayment, isLoaded: razorpayLoaded } = useRazorpay()
  const toast = useToast()

  const [cart, setCart] = useState<Cart | null>(null)
  const [loading, setLoading] = useState(true)
  const [placing, setPlacing] = useState(false)

  // Checkout selections
  const [selectedAddress, setSelectedAddress] = useState<DeliveryAddress | null>(null)
  const [paymentMethod, setPaymentMethod] = useState('cash_on_delivery')
  const [walletBalance, setWalletBalance] = useState(0)
  const [couponCode, setCouponCode] = useState('')
  const [couponApplied, setCouponApplied] = useState(false)
  const [orderNote, setOrderNote] = useState('')

  // Delivery slots
  const [deliverySlots, setDeliverySlots] = useState<DeliverySlot[]>([])
  const [selectedSlot, setSelectedSlot] = useState<number | undefined>(undefined)

  // Load cart data
  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/shop/login')
      return
    }
    setLoading(true)
    Promise.all([
      nestjsCart.get(),
      nestjsPayments.getWalletBalance(),
    ])
      .then(([cartRes, walletRes]) => {
        if (cartRes.data) setCart(cartRes.data)
        if (walletRes.data) setWalletBalance(walletRes.data.balance)
      })
      .catch(() => toast.error('Failed to load checkout data'))
      .finally(() => setLoading(false))
  }, [isAuthenticated, router, toast])

  // Load delivery slots when address is selected
  useEffect(() => {
    if (!cart?.store_id || !selectedAddress) return
    const today = new Date().toISOString().split('T')[0]
    nestjsDelivery
      .getSlots(cart.store_id, today)
      .then((res) => {
        if (res.data) setDeliverySlots(res.data.filter((s) => s.available))
      })
      .catch(() => {})
  }, [cart?.store_id, selectedAddress])

  const handleApplyCoupon = useCallback(async () => {
    if (!couponCode.trim()) return
    try {
      const res = await nestjsCart.applyCoupon(couponCode.trim())
      if (res.data) {
        setCart(res.data)
        setCouponApplied(true)
        toast.success('Coupon applied!')
      }
    } catch {
      toast.error('Invalid or expired coupon')
    }
  }, [couponCode, toast])

  const handleRemoveCoupon = useCallback(async () => {
    try {
      const res = await nestjsCart.removeCoupon()
      if (res.data) {
        setCart(res.data)
        setCouponApplied(false)
        setCouponCode('')
        toast.info('Coupon removed')
      }
    } catch {
      toast.error('Failed to remove coupon')
    }
  }, [toast])

  const handlePlaceOrder = useCallback(async () => {
    if (!cart) return
    if (!selectedAddress?.id) {
      toast.warning('Please select a delivery address')
      return
    }

    setPlacing(true)
    try {
      const res = await nestjsOrders.place({
        store_id: cart.store_id,
        delivery_address_id: selectedAddress.id,
        payment_method: paymentMethod,
        order_type: 'delivery',
        order_note: orderNote || undefined,
        delivery_slot_id: selectedSlot,
        coupon_code: couponApplied ? couponCode : undefined,
      })

      if (!res.data) {
        toast.error('Failed to place order')
        return
      }

      const order = res.data

      // Handle Razorpay payment
      if (paymentMethod === 'digital_payment' && order.transaction_reference) {
        if (!razorpayLoaded) {
          toast.error('Payment gateway is loading, please try again')
          setPlacing(false)
          return
        }
        try {
          await initiatePayment({
            key: process.env.NEXT_PUBLIC_RAZORPAY_KEY || '',
            amount: Math.round(order.order_amount * 100),
            currency: 'INR',
            name: 'Mangwale',
            description: `Order #${order.id}`,
            order_id: order.transaction_reference,
            prefill: {
              name: user ? `${user.f_name} ${user.l_name}` : '',
              email: user?.email || '',
              contact: user?.phone || '',
            },
            theme: { color: '#059211' },
          })
          toast.success('Payment successful! Order placed.')
        } catch {
          toast.warning('Payment was not completed. Your order is saved.')
        }
      } else {
        toast.success('Order placed successfully!')
      }

      router.push(`/shop/orders/${order.id}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to place order'
      toast.error(message)
    } finally {
      setPlacing(false)
    }
  }, [
    cart, selectedAddress, paymentMethod, orderNote, selectedSlot,
    couponApplied, couponCode, razorpayLoaded, initiatePayment, user, toast, router,
  ])

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <LoadingSpinner size="lg" text="Loading checkout..." />
      </div>
    )
  }

  if (!cart || !cart.items || cart.items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <ShoppingBag size={48} className="text-gray-300 mb-4" />
        <p className="text-gray-500 mb-4">Your cart is empty</p>
        <Link href="/shop/stores">
          <Button className="bg-[#059211] hover:bg-[#047a0e] text-white">Browse Stores</Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="px-4 py-4 pb-44">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/shop/cart"
          className="w-9 h-9 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200"
        >
          <ArrowLeft size={18} className="text-gray-700" />
        </Link>
        <h1 className="text-lg font-bold text-gray-900">Checkout</h1>
      </div>

      {/* Delivery Address */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Delivery Address</h2>
        <AddressSelector
          selectedId={selectedAddress?.id}
          onSelect={setSelectedAddress}
          onAddNew={() => router.push('/shop/addresses')}
        />
      </section>

      {/* Delivery Slots */}
      {deliverySlots.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">Delivery Slot</h2>
          <div className="grid grid-cols-2 gap-2">
            {deliverySlots.map((slot) => (
              <button
                key={slot.id}
                onClick={() => setSelectedSlot(slot.id === selectedSlot ? undefined : slot.id)}
                className={`p-3 rounded-lg border text-sm text-left transition-colors ${
                  selectedSlot === slot.id
                    ? 'border-[#059211] bg-[#059211]/5'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex items-center gap-1 text-gray-700 font-medium">
                  <Clock size={12} />
                  <span>{slot.start_time} - {slot.end_time}</span>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {slot.max_orders - slot.booked_orders} slots left
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Payment Method */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Payment Method</h2>
        <PaymentMethodSelector
          selected={paymentMethod}
          onSelect={setPaymentMethod}
          walletBalance={walletBalance}
        />
      </section>

      {/* Coupon */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Coupon Code</h2>
        {couponApplied ? (
          <div className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg">
            <div className="flex items-center gap-2">
              <Tag size={16} className="text-green-600" />
              <span className="text-sm font-medium text-green-700">{couponCode}</span>
            </div>
            <button
              onClick={handleRemoveCoupon}
              className="text-xs text-red-500 hover:underline"
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              placeholder="Enter coupon code"
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
              className="flex-1"
            />
            <Button
              onClick={handleApplyCoupon}
              variant="outline"
              disabled={!couponCode.trim()}
            >
              Apply
            </Button>
          </div>
        )}
      </section>

      {/* Order Note */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Order Note (Optional)</h2>
        <Input
          placeholder="Any special instructions..."
          value={orderNote}
          onChange={(e) => setOrderNote(e.target.value)}
        />
      </section>

      {/* Order Summary */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Order Summary</h2>
        <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-2">
          <div className="flex justify-between text-sm text-gray-600">
            <span>Subtotal ({cart.items.length} items)</span>
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
              <span>Delivery Charge</span>
              <span>₹{cart.delivery_charge.toFixed(2)}</span>
            </div>
          )}
          {cart.discount > 0 && (
            <div className="flex justify-between text-sm text-green-600">
              <span>Discount</span>
              <span>-₹{cart.discount.toFixed(2)}</span>
            </div>
          )}
          <div className="flex justify-between text-base font-bold text-gray-900 pt-2 border-t border-gray-100">
            <span>Total</span>
            <span>₹{cart.total.toFixed(2)}</span>
          </div>
        </div>
      </section>

      {/* Place Order - Fixed Bottom */}
      <div className="fixed bottom-16 left-0 right-0 z-30 bg-white border-t border-gray-200 shadow-[0_-4px_20px_rgba(0,0,0,0.08)]">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-600">Total</span>
            <span className="text-lg font-bold text-gray-900">₹{cart.total.toFixed(2)}</span>
          </div>
          <Button
            onClick={handlePlaceOrder}
            disabled={placing || !selectedAddress}
            className="w-full bg-[#059211] hover:bg-[#047a0e] text-white h-12 text-base"
          >
            {placing ? (
              <LoadingSpinner size="sm" />
            ) : (
              'Place Order'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
