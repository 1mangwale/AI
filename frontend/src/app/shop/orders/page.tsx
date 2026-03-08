'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronRight, ChevronLeft, Package, ShoppingBag } from 'lucide-react'
import { nestjsOrders } from '@/lib/api/nestjs/orders'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

export default function OrdersPage() {
  const router = useRouter()
  const { isAuthenticated } = useNestjsAuth()
  const toast = useToast()

  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)

  const fetchOrders = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const res = await nestjsOrders.list({
        page,
        limit: 10,
        status: statusFilter,
      })
      setOrders(res.data)
      setTotalPages(res.meta?.totalPages ?? 1)
    } catch {
      toast.error('Failed to load orders')
    } finally {
      setLoading(false)
    }
  }, [isAuthenticated, page, statusFilter, toast])

  useEffect(() => {
    fetchOrders()
  }, [fetchOrders])

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <Package size={48} className="text-gray-300 mb-4" />
        <p className="text-gray-500 mb-4">Please login to view your orders</p>
        <Link href="/shop/login">
          <Button className="bg-[#059211] hover:bg-[#047a0e] text-white">Login</Button>
        </Link>
      </div>
    )
  }

  const statusFilters: { label: string; value: string | undefined }[] = [
    { label: 'All', value: undefined },
    { label: 'Active', value: 'active' },
    { label: 'Delivered', value: 'delivered' },
    { label: 'Cancelled', value: 'cancelled' },
  ]

  return (
    <div className="px-4 py-4 pb-24">
      <h1 className="text-lg font-bold text-gray-900 mb-4">My Orders</h1>

      {/* Status Filter */}
      <div className="flex gap-2 mb-4 overflow-x-auto scrollbar-hide">
        {statusFilters.map((f) => (
          <button
            key={f.label}
            onClick={() => {
              setStatusFilter(f.value)
              setPage(1)
            }}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              statusFilter === f.value
                ? 'bg-[#059211] text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" text="Loading orders..." />
        </div>
      ) : orders.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <ShoppingBag size={48} className="text-gray-300 mb-4" />
          <p className="text-gray-500 text-sm mb-4">No orders found</p>
          <Link href="/shop/stores">
            <Button variant="outline" className="text-sm">Browse Stores</Button>
          </Link>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {orders.map((order) => (
              <button
                key={order.id}
                onClick={() => router.push(`/shop/orders/${order.id}`)}
                className="w-full bg-white rounded-xl border border-gray-100 shadow-sm p-4 text-left hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Order #{order.id}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {order.store?.name || `Store #${order.store_id}`}
                    </p>
                  </div>
                  <Badge
                    className={`${statusColors[order.order_status]} border-none text-[10px] font-semibold`}
                  >
                    {statusLabels[order.order_status]}
                  </Badge>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span>₹{order.order_amount.toFixed(0)}</span>
                    <span>{new Date(order.created_at).toLocaleDateString()}</span>
                    {order.details && (
                      <span>{order.details.length} item{order.details.length !== 1 ? 's' : ''}</span>
                    )}
                  </div>
                  <ChevronRight size={16} className="text-gray-400" />
                </div>
              </button>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-6">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
