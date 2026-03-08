'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { nestjsOrders } from '@/lib/api/nestjs/orders'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import type { Order } from '@/types/nestjs/api'
import {
  ArrowLeft,
  MapPin,
  Phone,
  Navigation,
  Package,
  CreditCard,
  Clock,
  CheckCircle,
  Loader2,
} from 'lucide-react'

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  confirmed: 'bg-blue-100 text-blue-800',
  processing: 'bg-indigo-100 text-indigo-800',
  handover: 'bg-purple-100 text-purple-800',
  picked_up: 'bg-orange-100 text-orange-800',
  delivered: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-800',
  failed: 'bg-red-100 text-red-800',
  refunded: 'bg-gray-100 text-gray-800',
}

export default function RiderOrderDetailPage() {
  const params = useParams()
  const router = useRouter()
  const toast = useToast()

  const orderId = Number(params.id)

  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)

  const fetchOrder = useCallback(async () => {
    try {
      const res = await nestjsOrders.rider.get(orderId)
      if (res.success && res.data) {
        setOrder(res.data)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load order'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [orderId, toast])

  useEffect(() => {
    if (orderId) fetchOrder()
  }, [orderId, fetchOrder])

  const handleStatusUpdate = async (status: string) => {
    if (!order) return
    setUpdating(true)
    try {
      const res = await nestjsOrders.rider.updateStatus(order.id, status)
      if (res.success) {
        toast.success(
          status === 'picked_up'
            ? 'Order marked as picked up'
            : 'Order delivered successfully'
        )
        setOrder(res.data)
      }
    } catch {
      toast.error('Failed to update status')
    } finally {
      setUpdating(false)
    }
  }

  const openNavigation = (lat: number, lng: number) => {
    window.open(
      `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
      '_blank'
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner text="Loading order..." />
      </div>
    )
  }

  if (!order) {
    return (
      <div className="p-4 text-center py-20">
        <Package size={40} className="mx-auto text-gray-300 mb-3" />
        <p className="text-gray-500">Order not found</p>
        <button
          onClick={() => router.back()}
          className="mt-3 text-sm text-[#059211] font-medium hover:underline"
        >
          Go back
        </button>
      </div>
    )
  }

  const address = order.delivery_address

  return (
    <div className="p-4 space-y-4">
      {/* Back button + Order ID */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="p-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 transition-colors"
        >
          <ArrowLeft size={18} className="text-gray-600" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-gray-900">Order #{order.id}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            <Badge className={statusColors[order.order_status] || 'bg-gray-100 text-gray-800'}>
              {order.order_status.replace('_', ' ')}
            </Badge>
            <span className="text-xs text-gray-500">
              {new Date(order.created_at).toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* Pickup Store Info */}
      {order.store && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center shrink-0">
                <MapPin size={18} className="text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-blue-600 uppercase tracking-wide mb-0.5">
                  Pickup
                </p>
                <p className="text-sm font-semibold text-gray-900">
                  {order.store.name}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{order.store.address}</p>
                <div className="flex items-center gap-2 mt-2">
                  {order.store.phone && (
                    <a
                      href={`tel:${order.store.phone}`}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
                    >
                      <Phone size={12} /> Call Store
                    </a>
                  )}
                  <button
                    onClick={() => openNavigation(order.store!.latitude, order.store!.longitude)}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
                  >
                    <Navigation size={12} /> Navigate
                  </button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Drop Address */}
      {address && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center shrink-0">
                <MapPin size={18} className="text-green-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-green-600 uppercase tracking-wide mb-0.5">
                  Drop-off
                </p>
                <p className="text-sm font-semibold text-gray-900">
                  {address.contact_person_name}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{address.address}</p>
                {address.house && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    House: {address.house}
                    {address.floor ? `, Floor: ${address.floor}` : ''}
                  </p>
                )}
                <div className="flex items-center gap-2 mt-2">
                  {address.contact_person_number && (
                    <a
                      href={`tel:${address.contact_person_number}`}
                      className="flex items-center gap-1 text-xs text-green-600 hover:underline"
                    >
                      <Phone size={12} /> Call Customer
                    </a>
                  )}
                  <button
                    onClick={() => openNavigation(address.latitude, address.longitude)}
                    className="flex items-center gap-1 text-xs text-green-600 hover:underline"
                  >
                    <Navigation size={12} /> Navigate
                  </button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Items */}
      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <Package size={16} />
            Items ({order.details?.length || 0})
          </h3>
          <div className="space-y-2">
            {order.details?.map((detail) => (
              <div key={detail.id} className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-900 truncate">
                    {detail.item_details?.name || `Item #${detail.item_id}`}
                  </p>
                  <p className="text-xs text-gray-500">Qty: {detail.quantity}</p>
                </div>
                <span className="text-sm font-medium text-gray-900">
                  {(detail.price * detail.quantity).toFixed(0)}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Payment & Amount */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <CreditCard size={14} className="text-gray-400" />
            <span className="text-gray-500">Payment:</span>
            <span className="font-medium text-gray-900 capitalize">
              {order.payment_method.replace('_', ' ')}
            </span>
            <Badge
              className={
                order.payment_status === 'paid'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-yellow-100 text-yellow-700'
              }
            >
              {order.payment_status}
            </Badge>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Clock size={14} className="text-gray-400" />
            <span className="text-gray-500">Type:</span>
            <span className="font-medium text-gray-900 capitalize">
              {order.order_type.replace('_', ' ')}
            </span>
          </div>
          <div className="border-t pt-2 mt-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Subtotal</span>
              <span>{(order.order_amount - order.delivery_charge - order.tax_amount).toFixed(0)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Delivery Charge</span>
              <span>{order.delivery_charge.toFixed(0)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Tax</span>
              <span>{order.tax_amount.toFixed(0)}</span>
            </div>
            <div className="flex justify-between text-sm font-bold mt-1 pt-1 border-t">
              <span>Total</span>
              <span className="text-[#059211]">{order.order_amount.toFixed(0)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="pb-4 space-y-2">
        {order.order_status === 'handover' && (
          <Button
            onClick={() => handleStatusUpdate('picked_up')}
            disabled={updating}
            className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-base font-medium"
          >
            {updating ? (
              <Loader2 className="animate-spin mr-2" size={20} />
            ) : (
              <CheckCircle size={20} className="mr-2" />
            )}
            Mark as Picked Up
          </Button>
        )}
        {order.order_status === 'picked_up' && (
          <Button
            onClick={() => handleStatusUpdate('delivered')}
            disabled={updating}
            className="w-full h-12 bg-[#059211] hover:bg-[#047a0e] text-base font-medium"
          >
            {updating ? (
              <Loader2 className="animate-spin mr-2" size={20} />
            ) : (
              <CheckCircle size={20} className="mr-2" />
            )}
            Mark as Delivered
          </Button>
        )}

        {/* Navigate button always visible for non-completed orders */}
        {order.order_status !== 'delivered' &&
          order.order_status !== 'cancelled' && (
            <Button
              variant="outline"
              onClick={() => {
                if (
                  order.order_status === 'picked_up' &&
                  address
                ) {
                  openNavigation(address.latitude, address.longitude)
                } else if (order.store) {
                  openNavigation(order.store.latitude, order.store.longitude)
                }
              }}
              className="w-full h-12 text-base font-medium"
            >
              <Navigation size={20} className="mr-2" />
              {order.order_status === 'picked_up'
                ? 'Navigate to Customer'
                : 'Navigate to Store'}
            </Button>
          )}
      </div>

      {/* Order Note */}
      {order.order_note && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-gray-500 mb-1">Order Note</p>
            <p className="text-sm text-gray-700">{order.order_note}</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
