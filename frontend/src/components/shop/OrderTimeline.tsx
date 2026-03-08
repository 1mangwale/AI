'use client'

import { Check, Clock } from 'lucide-react'
import type { Order, OrderStatus } from '@/types/nestjs/api'

interface OrderTimelineProps {
  order: Order
}

const statusSteps: { key: OrderStatus; label: string }[] = [
  { key: 'pending', label: 'Order Placed' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'processing', label: 'Preparing' },
  { key: 'handover', label: 'Ready' },
  { key: 'picked_up', label: 'Picked Up' },
  { key: 'delivered', label: 'Delivered' },
]

const statusIndex: Record<string, number> = {}
statusSteps.forEach((s, i) => {
  statusIndex[s.key] = i
})

export function OrderTimeline({ order }: OrderTimelineProps) {
  const currentIndex = statusIndex[order.order_status] ?? -1
  const isCancelled = order.order_status === 'cancelled'

  if (isCancelled) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-sm font-medium text-red-700">Order Cancelled</p>
        {order.cancellation_reason && (
          <p className="text-xs text-red-500 mt-1">{order.cancellation_reason}</p>
        )}
        {order.cancelled && (
          <p className="text-xs text-red-400 mt-1">
            {new Date(order.cancelled).toLocaleString()}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-0">
      {statusSteps.map((step, index) => {
        const isCompleted = index <= currentIndex
        const isCurrent = index === currentIndex
        const timestamp = order[step.key as keyof Order] as string | undefined

        return (
          <div key={step.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                  isCompleted
                    ? 'bg-primary text-white'
                    : 'bg-gray-200 text-gray-400'
                }`}
              >
                {isCompleted ? <Check size={14} /> : <Clock size={14} />}
              </div>
              {index < statusSteps.length - 1 && (
                <div
                  className={`w-0.5 h-8 ${
                    index < currentIndex ? 'bg-primary' : 'bg-gray-200'
                  }`}
                />
              )}
            </div>
            <div className="pb-6">
              <p
                className={`text-sm font-medium ${
                  isCurrent ? 'text-primary' : isCompleted ? 'text-gray-900' : 'text-gray-400'
                }`}
              >
                {step.label}
              </p>
              {timestamp && (
                <p className="text-xs text-gray-400">
                  {new Date(timestamp).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
