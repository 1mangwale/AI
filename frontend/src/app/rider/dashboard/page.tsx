'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { nestjsOrders } from '@/lib/api/nestjs/orders'
import { nestjsDelivery } from '@/lib/api/nestjs/delivery'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { DeliveryCard } from '@/components/rider/DeliveryCard'
import { Card, CardContent } from '@/components/ui/card'
import type { Order } from '@/types/nestjs/api'
import { DollarSign, Package, CheckCircle, RefreshCw } from 'lucide-react'

interface EarningsData {
  total: number
  today: number
  transactions: unknown[]
}

export default function RiderDashboardPage() {
  const router = useRouter()
  const toast = useToast()

  const [assignedOrders, setAssignedOrders] = useState<Order[]>([])
  const [earnings, setEarnings] = useState<EarningsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const completedToday = assignedOrders.filter(
    (o) => o.order_status === 'delivered'
  ).length
  const activeDeliveries = assignedOrders.filter(
    (o) => o.order_status !== 'delivered' && o.order_status !== 'cancelled'
  )

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)

    try {
      const [ordersRes, earningsRes] = await Promise.all([
        nestjsOrders.rider.assigned(),
        nestjsDelivery.rider.getEarnings(),
      ])

      if (ordersRes.success) {
        setAssignedOrders(ordersRes.data)
      }
      if (earningsRes.success && earningsRes.data) {
        setEarnings(earningsRes.data)
      }
    } catch (err: unknown) {
      if (!silent) {
        const message = err instanceof Error ? err.message : 'Failed to load dashboard'
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner text="Loading dashboard..." />
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
        <button
          onClick={() => fetchData(true)}
          disabled={refreshing}
          className="p-2 text-gray-400 hover:text-[#059211] transition-colors"
        >
          <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="bg-gradient-to-br from-[#059211]/10 to-[#059211]/5 border-[#059211]/20">
          <CardContent className="p-3 text-center">
            <DollarSign size={20} className="mx-auto text-[#059211] mb-1" />
            <p className="text-lg font-bold text-gray-900">
              {earnings?.today?.toFixed(0) || '0'}
            </p>
            <p className="text-[10px] text-gray-500">Today&apos;s Earnings</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-blue-50 to-blue-50/50 border-blue-200/50">
          <CardContent className="p-3 text-center">
            <Package size={20} className="mx-auto text-blue-600 mb-1" />
            <p className="text-lg font-bold text-gray-900">
              {activeDeliveries.length}
            </p>
            <p className="text-[10px] text-gray-500">Active</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-green-50 to-green-50/50 border-green-200/50">
          <CardContent className="p-3 text-center">
            <CheckCircle size={20} className="mx-auto text-green-600 mb-1" />
            <p className="text-lg font-bold text-gray-900">{completedToday}</p>
            <p className="text-[10px] text-gray-500">Completed</p>
          </CardContent>
        </Card>
      </div>

      {/* Active Deliveries */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          Active Deliveries ({activeDeliveries.length})
        </h2>
        {activeDeliveries.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center">
              <Package size={40} className="mx-auto text-gray-300 mb-3" />
              <p className="text-sm text-gray-500">No active deliveries</p>
              <button
                onClick={() => router.push('/rider/orders')}
                className="mt-3 text-sm text-[#059211] font-medium hover:underline"
              >
                View Available Orders
              </button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {activeDeliveries.map((order) => (
              <DeliveryCard
                key={order.id}
                order={order}
                onPickup={handlePickup}
                onDeliver={handleDeliver}
                onNavigate={handleNavigate}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
