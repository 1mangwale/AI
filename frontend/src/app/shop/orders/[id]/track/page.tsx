'use client'

import { useState, useEffect, useRef, use } from 'react'
import Link from 'next/link'
import { ArrowLeft, Phone, Clock, User } from 'lucide-react'
import { nestjsOrders } from '@/lib/api/nestjs/orders'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { DeliveryMap } from '@/components/shop/DeliveryMap'
import type { TrackingData, OrderStatus } from '@/types/nestjs/api'

const statusLabels: Record<OrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  processing: 'Preparing',
  handover: 'Ready for Pickup',
  picked_up: 'On the Way',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  failed: 'Failed',
  refunded: 'Refunded',
}

export default function TrackOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { isAuthenticated } = useNestjsAuth()
  const toast = useToast()

  const [tracking, setTracking] = useState<TrackingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch order details for address
  const [deliveryAddress, setDeliveryAddress] = useState<{ latitude: number; longitude: number } | null>(null)
  const [storeLocation, setStoreLocation] = useState<{ latitude: number; longitude: number } | null>(null)

  useEffect(() => {
    if (!isAuthenticated) return

    // Fetch order for addresses
    nestjsOrders.get(Number(id)).then((res) => {
      if (res.data) {
        if (res.data.delivery_address) {
          setDeliveryAddress({
            latitude: res.data.delivery_address.latitude,
            longitude: res.data.delivery_address.longitude,
          })
        }
        if (res.data.store) {
          setStoreLocation({
            latitude: res.data.store.latitude,
            longitude: res.data.store.longitude,
          })
        }
      }
    }).catch(() => {})
  }, [id, isAuthenticated])

  useEffect(() => {
    if (!isAuthenticated) return

    const fetchTracking = async () => {
      try {
        const res = await nestjsOrders.track(Number(id))
        if (res.data) {
          setTracking(res.data)
          setError(false)

          // Stop polling if delivered or cancelled
          if (['delivered', 'cancelled', 'failed', 'refunded'].includes(res.data.order_status)) {
            if (intervalRef.current) {
              clearInterval(intervalRef.current)
              intervalRef.current = null
            }
          }
        }
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }
    }

    fetchTracking()

    // Poll every 10 seconds
    intervalRef.current = setInterval(fetchTracking, 10000)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [id, isAuthenticated])

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <LoadingSpinner size="lg" text="Loading tracking..." />
      </div>
    )
  }

  if (error || !tracking) {
    return (
      <div className="px-4 py-4">
        <div className="flex items-center gap-3 mb-6">
          <Link
            href={`/shop/orders/${id}`}
            className="w-9 h-9 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200"
          >
            <ArrowLeft size={18} className="text-gray-700" />
          </Link>
          <h1 className="text-lg font-bold text-gray-900">Track Order</h1>
        </div>
        <div className="text-center py-12">
          <p className="text-gray-500 text-sm">
            Tracking is not available for this order yet. The delivery partner may not have been assigned.
          </p>
          <Link
            href={`/shop/orders/${id}`}
            className="mt-4 inline-block text-[#059211] hover:underline text-sm"
          >
            Back to order details
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="pb-24">
      {/* Header */}
      <div className="px-4 py-4 flex items-center gap-3">
        <Link
          href={`/shop/orders/${id}`}
          className="w-9 h-9 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200"
        >
          <ArrowLeft size={18} className="text-gray-700" />
        </Link>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-gray-900">Track Order #{id}</h1>
        </div>
        <Badge className="bg-[#059211]/10 text-[#059211] border-none text-xs font-semibold">
          {statusLabels[tracking.order_status] || tracking.order_status}
        </Badge>
      </div>

      {/* Map */}
      {deliveryAddress && (
        <div className="px-4 mb-4">
          <DeliveryMap
            tracking={tracking}
            deliveryAddress={deliveryAddress}
            storeLocation={storeLocation || undefined}
          />
        </div>
      )}

      {/* Status Info Bar */}
      <div className="px-4">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          {/* Delivery Man Info */}
          {tracking.delivery_man && (
            <div className="flex items-center gap-3 mb-4 pb-4 border-b border-gray-100">
              <div className="w-10 h-10 bg-[#059211]/10 rounded-full flex items-center justify-center shrink-0">
                <User size={20} className="text-[#059211]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900">
                  {tracking.delivery_man.name}
                </p>
                <p className="text-xs text-gray-500">Delivery Partner</p>
              </div>
              <a
                href={`tel:${tracking.delivery_man.phone}`}
                className="w-10 h-10 bg-[#059211] rounded-full flex items-center justify-center text-white hover:bg-[#047a0e] transition-colors"
              >
                <Phone size={16} />
              </a>
            </div>
          )}

          {/* ETA */}
          {tracking.estimated_delivery_time && (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-orange-50 rounded-full flex items-center justify-center shrink-0">
                <Clock size={20} className="text-orange-500" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">
                  Estimated Delivery
                </p>
                <p className="text-xs text-gray-500">
                  {tracking.estimated_delivery_time}
                </p>
              </div>
            </div>
          )}

          {/* Live indicator */}
          <div className="flex items-center gap-2 mt-4 pt-4 border-t border-gray-100">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <span className="text-xs text-gray-500">Updating every 10 seconds</span>
          </div>
        </div>
      </div>
    </div>
  )
}
