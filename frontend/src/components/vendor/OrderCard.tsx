'use client'

import { Clock, Package, User } from 'lucide-react'
import type { Order } from '@/types/nestjs/api'

interface OrderCardProps {
  order: Order
  onAccept?: (id: number) => void
  onReject?: (id: number) => void
  onView?: (id: number) => void
}

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  confirmed: 'bg-blue-100 text-blue-700',
  processing: 'bg-purple-100 text-purple-700',
  handover: 'bg-indigo-100 text-indigo-700',
  picked_up: 'bg-cyan-100 text-cyan-700',
  delivered: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

export function OrderCard({ order, onAccept, onReject, onView }: OrderCardProps) {
  return (
    <div className="bg-white rounded-lg border p-4 hover:shadow-sm transition-shadow">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900">
            #{order.id}
          </span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[order.order_status] || 'bg-gray-100 text-gray-600'}`}>
            {order.order_status.replace('_', ' ')}
          </span>
        </div>
        <span className="text-sm font-semibold text-gray-900">
          ₹{order.order_amount.toFixed(2)}
        </span>
      </div>

      <div className="space-y-1.5 mb-3">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <User size={12} />
          <span>{order.delivery_address?.contact_person_name || 'Customer'}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Package size={12} />
          <span>{order.details?.length || 0} items - {order.order_type}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Clock size={12} />
          <span>{new Date(order.created_at).toLocaleString()}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {order.order_status === 'pending' && onAccept && (
          <button
            onClick={() => onAccept(order.id)}
            className="flex-1 py-1.5 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
          >
            Accept
          </button>
        )}
        {order.order_status === 'pending' && onReject && (
          <button
            onClick={() => onReject(order.id)}
            className="flex-1 py-1.5 text-xs font-medium bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors"
          >
            Reject
          </button>
        )}
        {onView && (
          <button
            onClick={() => onView(order.id)}
            className="flex-1 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
          >
            View Details
          </button>
        )}
      </div>
    </div>
  )
}
