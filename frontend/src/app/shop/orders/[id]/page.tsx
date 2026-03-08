'use client'

import { useState, useEffect, use, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { ArrowLeft, MapPin, Navigation, RotateCcw, XCircle } from 'lucide-react'
import { nestjsOrders } from '@/lib/api/nestjs/orders'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { OrderTimeline } from '@/components/shop/OrderTimeline'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { Order, OrderStatus } from '@/types/nestjs/api'

const statusColors: Record<OrderStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  confirmed: 'bg-blue-100 text-blue-800',
  processing: 'bg-indigo-100 text-indigo-800',
  handover: 'bg-purple-100 text-purple-800',
  picked_up: 'bg-cyan-100 text-cyan-800',
  delivered: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-800',
  failed: 'bg-red-100 text-red-800',
  refunded: 'bg-gray-100 text-gray-800',
}

const statusLabels: Record<OrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  processing: 'Preparing',
  handover: 'Ready',
  picked_up: 'Picked Up',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  failed: 'Failed',
  refunded: 'Refunded',
}

const canCancel = (status: OrderStatus) =>
  ['pending', 'confirmed'].includes(status)

const canTrack = (status: OrderStatus) =>
  ['processing', 'handover', 'picked_up'].includes(status)

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { isAuthenticated } = useNestjsAuth()
  const toast = useToast()

  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [cancelReason, setCancelReason] = useState('')

  useEffect(() => {
    if (!isAuthenticated) return
    setLoading(true)
    nestjsOrders
      .get(Number(id))
      .then((res) => {
        if (res.data) setOrder(res.data)
      })
      .catch(() => toast.error('Failed to load order'))
      .finally(() => setLoading(false))
  }, [id, isAuthenticated, toast])

  const handleCancel = useCallback(async () => {
    setCancelling(true)
    try {
      const res = await nestjsOrders.cancel(Number(id), cancelReason || undefined)
      if (res.data) {
        setOrder(res.data)
        toast.success('Order cancelled')
      }
    } catch {
      toast.error('Failed to cancel order')
    } finally {
      setCancelling(false)
      setShowCancelDialog(false)
      setCancelReason('')
    }
  }, [id, cancelReason, toast])

  const handleReorder = useCallback(async () => {
    setReordering(true)
    try {
      await nestjsOrders.reorder(Number(id))
      toast.success('Items added to cart!')
      router.push('/shop/cart')
    } catch {
      toast.error('Failed to reorder')
    } finally {
      setReordering(false)
    }
  }, [id, toast, router])

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <LoadingSpinner size="lg" text="Loading order..." />
      </div>
    )
  }

  if (!order) {
    return (
      <div className="text-center py-20 px-4">
        <p className="text-gray-500 mb-4">Order not found</p>
        <Link href="/shop/orders" className="text-[#059211] hover:underline text-sm">
          View all orders
        </Link>
      </div>
    )
  }

  return (
    <div className="px-4 py-4 pb-24">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/shop/orders"
          className="w-9 h-9 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200"
        >
          <ArrowLeft size={18} className="text-gray-700" />
        </Link>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-gray-900">Order #{order.id}</h1>
          <p className="text-xs text-gray-500">
            {new Date(order.created_at).toLocaleString()}
          </p>
        </div>
        <Badge
          className={`${statusColors[order.order_status]} border-none text-xs font-semibold`}
        >
          {statusLabels[order.order_status]}
        </Badge>
      </div>

      {/* Order Timeline */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Order Status</h2>
        <OrderTimeline order={order} />
      </section>

      {/* Track / Actions */}
      <div className="flex gap-2 mb-6">
        {canTrack(order.order_status) && (
          <Button
            onClick={() => router.push(`/shop/orders/${order.id}/track`)}
            className="flex-1 bg-[#059211] hover:bg-[#047a0e] text-white"
          >
            <Navigation size={16} className="mr-2" />
            Track Order
          </Button>
        )}
        {canCancel(order.order_status) && (
          <Button
            onClick={() => setShowCancelDialog(true)}
            variant="destructive"
            className="flex-1"
          >
            <XCircle size={16} className="mr-2" />
            Cancel
          </Button>
        )}
        <Button
          onClick={handleReorder}
          disabled={reordering}
          variant="outline"
          className="flex-1"
        >
          {reordering ? (
            <LoadingSpinner size="sm" />
          ) : (
            <>
              <RotateCcw size={16} className="mr-2" />
              Reorder
            </>
          )}
        </Button>
      </div>

      {/* Order Items */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">
          Items ({order.details?.length ?? 0})
        </h2>
        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50 overflow-hidden">
          {order.details?.map((detail) => (
            <div key={detail.id} className="p-3 flex gap-3">
              <div className="relative w-12 h-12 bg-gray-100 rounded-lg shrink-0 overflow-hidden">
                {detail.item_details?.image ? (
                  <Image
                    src={detail.item_details.image}
                    alt={detail.item_details.name}
                    fill
                    className="object-cover"
                    sizes="48px"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-300 text-[8px]">
                    N/A
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 line-clamp-1">
                  {detail.item_details?.name || `Item #${detail.item_id}`}
                </p>
                <p className="text-xs text-gray-500">
                  ₹{detail.price} x {detail.quantity}
                </p>
              </div>
              <span className="text-sm font-semibold text-gray-900 shrink-0">
                ₹{(detail.price * detail.quantity).toFixed(0)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Payment Info */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Payment Details</h2>
        <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-2">
          <div className="flex justify-between text-sm text-gray-600">
            <span>Payment Method</span>
            <span className="font-medium capitalize">
              {order.payment_method.replace(/_/g, ' ')}
            </span>
          </div>
          <div className="flex justify-between text-sm text-gray-600">
            <span>Subtotal</span>
            <span>₹{(order.order_amount - order.tax_amount - order.delivery_charge + order.coupon_discount_amount).toFixed(2)}</span>
          </div>
          {order.tax_amount > 0 && (
            <div className="flex justify-between text-sm text-gray-600">
              <span>Tax ({order.tax_percentage}%)</span>
              <span>₹{order.tax_amount.toFixed(2)}</span>
            </div>
          )}
          {order.delivery_charge > 0 && (
            <div className="flex justify-between text-sm text-gray-600">
              <span>Delivery Charge</span>
              <span>₹{order.delivery_charge.toFixed(2)}</span>
            </div>
          )}
          {order.coupon_discount_amount > 0 && (
            <div className="flex justify-between text-sm text-green-600">
              <span>Coupon Discount</span>
              <span>-₹{order.coupon_discount_amount.toFixed(2)}</span>
            </div>
          )}
          <div className="flex justify-between text-base font-bold text-gray-900 pt-2 border-t border-gray-100">
            <span>Total</span>
            <span>₹{order.order_amount.toFixed(2)}</span>
          </div>
        </div>
      </section>

      {/* Delivery Address */}
      {order.delivery_address && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Delivery Address</h2>
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <div className="flex items-start gap-3">
              <MapPin size={16} className="text-gray-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-gray-900 capitalize">
                  {order.delivery_address.address_type}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {order.delivery_address.address}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {order.delivery_address.contact_person_name} - {order.delivery_address.contact_person_number}
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Order Note */}
      {order.order_note && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">Note</h2>
          <p className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">{order.order_note}</p>
        </section>
      )}

      {/* Cancel Dialog */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Order</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel this order? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Reason (optional)
            </label>
            <Input
              placeholder="Why are you cancelling?"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancelDialog(false)}>
              Keep Order
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancel}
              disabled={cancelling}
            >
              {cancelling ? <LoadingSpinner size="sm" /> : 'Cancel Order'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
