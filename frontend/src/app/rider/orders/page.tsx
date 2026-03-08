'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsOrders } from '@/lib/api/nestjs/orders'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { DeliveryCard } from '@/components/rider/DeliveryCard'
import { Card, CardContent } from '@/components/ui/card'
import type { Order } from '@/types/nestjs/api'
import { Package, RefreshCw } from 'lucide-react'

type Tab = 'available' | 'assigned'

export default function RiderOrdersPage() {
  const toast = useToast()

  const [tab, setTab] = useState<Tab>('available')
  const [availableOrders, setAvailableOrders] = useState<Order[]>([])
  const [assignedOrders, setAssignedOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)

    try {
      const [availableRes, assignedRes] = await Promise.all([
        nestjsOrders.rider.available(),
        nestjsOrders.rider.assigned(),
      ])

      if (availableRes.success) setAvailableOrders(availableRes.data)
      if (assignedRes.success) setAssignedOrders(assignedRes.data)
    } catch (err: unknown) {
      if (!silent) {
        const message = err instanceof Error ? err.message : 'Failed to load orders'
        toast.error(message)
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [toast])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Auto-refresh every 15 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchData(true)
    }, 15000)
    return () => clearInterval(interval)
  }, [fetchData])

  const handleAccept = async (orderId: number) => {
    try {
      await nestjsOrders.rider.updateStatus(orderId, 'confirmed')
      toast.success('Delivery accepted')
      fetchData(true)
    } catch {
      toast.error('Failed to accept delivery')
    }
  }

  const handlePickup = async (orderId: number) => {
    try {
      await nestjsOrders.rider.updateStatus(orderId, 'picked_up')
      toast.success('Order marked as picked up')
      fetchData(true)
    } catch {
      toast.error('Failed to update status')
    }
  }

  const handleDeliver = async (orderId: number) => {
    try {
      await nestjsOrders.rider.updateStatus(orderId, 'delivered')
      toast.success('Order delivered successfully')
      fetchData(true)
    } catch {
      toast.error('Failed to update status')
    }
  }

  const handleNavigate = (lat: number, lng: number) => {
    window.open(
      `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
      '_blank'
    )
  }

  const activeOrders = tab === 'available' ? availableOrders : assignedOrders.filter(
    (o) => o.order_status !== 'delivered' && o.order_status !== 'cancelled'
  )

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Orders</h1>
        <button
          onClick={() => fetchData(true)}
          disabled={refreshing}
          className="p-2 text-gray-400 hover:text-[#059211] transition-colors"
        >
          <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Tab Switcher */}
      <div className="flex bg-gray-100 rounded-lg p-1">
        <button
          onClick={() => setTab('available')}
          className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
            tab === 'available'
              ? 'bg-white text-[#059211] shadow-sm'
              : 'text-gray-500'
          }`}
        >
          Available ({availableOrders.length})
        </button>
        <button
          onClick={() => setTab('assigned')}
          className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
            tab === 'assigned'
              ? 'bg-white text-[#059211] shadow-sm'
              : 'text-gray-500'
          }`}
        >
          My Deliveries ({assignedOrders.filter(
            (o) => o.order_status !== 'delivered' && o.order_status !== 'cancelled'
          ).length})
        </button>
      </div>

      {/* Order List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <LoadingSpinner text="Loading orders..." />
        </div>
      ) : activeOrders.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <Package size={40} className="mx-auto text-gray-300 mb-3" />
            <p className="text-sm text-gray-500">
              {tab === 'available'
                ? 'No available deliveries in your zone'
                : 'No active deliveries'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {activeOrders.map((order) => (
            <DeliveryCard
              key={order.id}
              order={order}
              onAccept={tab === 'available' ? handleAccept : undefined}
              onPickup={tab === 'assigned' ? handlePickup : undefined}
              onDeliver={tab === 'assigned' ? handleDeliver : undefined}
              onNavigate={handleNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}
