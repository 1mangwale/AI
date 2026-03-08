'use client'

import { MapPin, Phone, Navigation, Clock } from 'lucide-react'
import type { Order } from '@/types/nestjs/api'

interface DeliveryCardProps {
  order: Order
  onAccept?: (id: number) => void
  onPickup?: (id: number) => void
  onDeliver?: (id: number) => void
  onNavigate?: (lat: number, lng: number) => void
}

export function DeliveryCard({ order, onAccept, onPickup, onDeliver, onNavigate }: DeliveryCardProps) {
  const address = order.delivery_address

  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-gray-900">Order #{order.id}</span>
        <span className="text-sm font-semibold text-primary">₹{order.order_amount.toFixed(0)}</span>
      </div>

      {/* Store info */}
      <div className="bg-blue-50 rounded-lg p-2.5 mb-2">
        <div className="flex items-start gap-2">
          <MapPin size={14} className="text-blue-500 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-blue-700">Pickup: {order.store?.name}</p>
            <p className="text-xs text-blue-500 truncate">{order.store?.address}</p>
          </div>
          {order.store && onNavigate && (
            <button
              onClick={() => onNavigate(order.store!.latitude, order.store!.longitude)}
              className="shrink-0 text-blue-500 hover:text-blue-700"
            >
              <Navigation size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Delivery address */}
      <div className="bg-green-50 rounded-lg p-2.5 mb-3">
        <div className="flex items-start gap-2">
          <MapPin size={14} className="text-green-500 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-green-700">
              Drop: {address?.contact_person_name}
            </p>
            <p className="text-xs text-green-500 truncate">{address?.address}</p>
          </div>
          {address && onNavigate && (
            <button
              onClick={() => onNavigate(address.latitude, address.longitude)}
              className="shrink-0 text-green-500 hover:text-green-700"
            >
              <Navigation size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-gray-500 mb-3">
        <div className="flex items-center gap-1">
          <Clock size={12} />
          <span>{new Date(order.created_at).toLocaleTimeString()}</span>
        </div>
        <span>{order.details?.length || 0} items</span>
        <span className="capitalize">{order.payment_method.replace('_', ' ')}</span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {address?.contact_person_number && (
          <a
            href={`tel:${address.contact_person_number}`}
            className="w-9 h-9 border rounded-lg flex items-center justify-center text-gray-400 hover:text-primary hover:border-primary transition-colors"
          >
            <Phone size={16} />
          </a>
        )}

        {order.order_status === 'handover' && onPickup && (
          <button
            onClick={() => onPickup(order.id)}
            className="flex-1 py-2 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Picked Up
          </button>
        )}
        {order.order_status === 'picked_up' && onDeliver && (
          <button
            onClick={() => onDeliver(order.id)}
            className="flex-1 py-2 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
          >
            Delivered
          </button>
        )}
        {!order.delivery_man_id && onAccept && (
          <button
            onClick={() => onAccept(order.id)}
            className="flex-1 py-2 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
          >
            Accept Delivery
          </button>
        )}
      </div>
    </div>
  )
}
