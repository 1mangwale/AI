'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsOrders } from '@/lib/api/nestjs/orders'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Order, OrderStatus } from '@/types/nestjs/api'
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ShoppingBag,
} from 'lucide-react'

const ORDER_STATUSES: { label: string; value: string }[] = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Confirmed', value: 'confirmed' },
  { label: 'Processing', value: 'processing' },
  { label: 'Picked Up', value: 'picked_up' },
  { label: 'Delivered', value: 'delivered' },
  { label: 'Cancelled', value: 'cancelled' },
]

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

export default function AdminCommerceOrdersPage() {
  const toast = useToast()

  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)

  const fetchOrders = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsOrders.admin.list({
        page,
        limit: 15,
        search: search || undefined,
        status: statusFilter || undefined,
      })
      if (res.success) {
        setOrders(res.data)
        setTotalPages(res.meta.totalPages)
        setTotal(res.meta.total)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load orders'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [page, search, statusFilter, toast])

  useEffect(() => {
    fetchOrders()
  }, [fetchOrders])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    fetchOrders()
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Order Management</h1>
        <p className="text-sm text-gray-500 mt-1">
          View and manage all platform orders ({total} total)
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              placeholder="Search by order ID, customer..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        <div className="flex gap-1 overflow-x-auto pb-1">
          {ORDER_STATUSES.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setStatusFilter(opt.value)
                setPage(1)
              }}
              className={`px-3 py-2 text-xs rounded-lg border whitespace-nowrap transition-colors ${
                statusFilter === opt.value
                  ? 'bg-[#059211] text-white border-[#059211]'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner text="Loading orders..." />
        </div>
      ) : orders.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <ShoppingBag size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No orders found</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Order ID</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Customer</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Store</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">Payment</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {orders.map((order) => (
                  <tr key={order.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-mono font-medium text-gray-900">#{order.id}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-gray-900">
                          {order.user?.f_name} {order.user?.l_name}
                        </p>
                        <p className="text-xs text-gray-500">{order.user?.phone}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                      {order.store?.name || `Store #${order.store_id}`}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {order.order_amount.toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={statusColors[order.order_status] || 'bg-gray-100 text-gray-800'}>
                        {order.order_status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <div className="flex items-center gap-2">
                        <span className="capitalize text-gray-600 text-xs">
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
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell">
                      {new Date(order.created_at).toLocaleDateString()}
                      <br />
                      {new Date(order.created_at).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
            <p className="text-sm text-gray-500">
              Page {page} of {totalPages} ({total} orders)
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft size={16} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
