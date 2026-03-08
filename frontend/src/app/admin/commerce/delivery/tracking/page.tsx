'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsDelivery } from '@/lib/api/nestjs/delivery'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import type { TrackingData } from '@/types/nestjs/api'
import {
  Truck,
  RefreshCw,
  MapPin,
  User,
  Package,
} from 'lucide-react'

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  confirmed: 'bg-blue-100 text-blue-800',
  processing: 'bg-indigo-100 text-indigo-800',
  handover: 'bg-purple-100 text-purple-800',
  picked_up: 'bg-orange-100 text-orange-800',
  delivered: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-800',
}

export default function AdminCommerceDeliveryTrackingPage() {
  const toast = useToast()

  const [deliveries, setDeliveries] = useState<TrackingData[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchDeliveries = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)

    try {
      const res = await nestjsDelivery.admin.getActiveDeliveries()
      if (res.success) {
        setDeliveries(res.data)
      }
    } catch (err: unknown) {
      if (!silent) {
        const message = err instanceof Error ? err.message : 'Failed to load deliveries'
        toast.error(message)
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [toast])

  useEffect(() => {
    fetchDeliveries()
  }, [fetchDeliveries])

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchDeliveries(true)
    }, 30000)
    return () => clearInterval(interval)
  }, [fetchDeliveries])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Live Delivery Tracking</h1>
          <p className="text-sm text-gray-500 mt-1">
            {deliveries.length} active {deliveries.length === 1 ? 'delivery' : 'deliveries'}
          </p>
        </div>
        <button
          onClick={() => fetchDeliveries(true)}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border bg-white text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-gradient-to-br from-blue-50 to-blue-50/50 border-blue-200/50">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
              <Truck size={24} className="text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{deliveries.length}</p>
              <p className="text-sm text-gray-500">Active Deliveries</p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-orange-50 to-orange-50/50 border-orange-200/50">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-12 h-12 bg-orange-100 rounded-xl flex items-center justify-center">
              <Package size={24} className="text-orange-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">
                {deliveries.filter((d) => d.order_status === 'picked_up').length}
              </p>
              <p className="text-sm text-gray-500">In Transit</p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-purple-50 to-purple-50/50 border-purple-200/50">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
              <MapPin size={24} className="text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">
                {deliveries.filter((d) => d.order_status === 'handover' || d.order_status === 'confirmed').length}
              </p>
              <p className="text-sm text-gray-500">Awaiting Pickup</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Delivery List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner text="Loading active deliveries..." />
        </div>
      ) : deliveries.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <Truck size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No active deliveries at the moment</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Rider</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Order</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">ETA</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">Location</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {deliveries.map((delivery) => (
                  <tr key={delivery.order_id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {delivery.delivery_man.image ? (
                          <img
                            src={delivery.delivery_man.image}
                            alt={delivery.delivery_man.name}
                            className="w-9 h-9 rounded-full object-cover"
                          />
                        ) : (
                          <div className="w-9 h-9 bg-gray-100 rounded-full flex items-center justify-center">
                            <User size={16} className="text-gray-400" />
                          </div>
                        )}
                        <div>
                          <p className="font-medium text-gray-900">
                            {delivery.delivery_man.name}
                          </p>
                          <p className="text-xs text-gray-500">
                            {delivery.delivery_man.phone}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono font-medium text-gray-900">
                        #{delivery.order_id}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={statusColors[delivery.order_status] || 'bg-gray-100 text-gray-800'}>
                        {delivery.order_status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                      {delivery.estimated_delivery_time
                        ? delivery.estimated_delivery_time
                        : '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs font-mono hidden lg:table-cell">
                      {delivery.delivery_man.latitude.toFixed(4)},{' '}
                      {delivery.delivery_man.longitude.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Future map placeholder */}
      <Card className="border-dashed border-2 border-gray-200">
        <CardContent className="p-8 text-center">
          <MapPin size={40} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm text-gray-400">
            Map integration coming soon - riders will be shown on a live map
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
