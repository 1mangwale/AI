'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsPayments } from '@/lib/api/nestjs/payments'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Settlement } from '@/types/nestjs/api'
import {
  ChevronLeft,
  ChevronRight,
  Banknote,
} from 'lucide-react'

const STATUS_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
]

const settlementStatusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
}

export default function AdminCommerceSettlementsPage() {
  const toast = useToast()

  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)

  const fetchSettlements = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsPayments.admin.getSettlements({
        page,
        limit: 15,
        status: statusFilter || undefined,
      })
      if (res.success) {
        setSettlements(res.data)
        setTotalPages(res.meta.totalPages)
        setTotal(res.meta.total)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load settlements'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, toast])

  useEffect(() => {
    fetchSettlements()
  }, [fetchSettlements])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settlement Management</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage vendor payouts and settlements ({total} total)
        </p>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => {
              setStatusFilter(opt.value)
              setPage(1)
            }}
            className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
              statusFilter === opt.value
                ? 'bg-[#059211] text-white border-[#059211]'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner text="Loading settlements..." />
        </div>
      ) : settlements.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <Banknote size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No settlements found</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">ID</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Store</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Period</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">Method</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {settlements.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-gray-900">#{s.id}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-gray-900">
                        {s.store?.name || `Store #${s.store_id}`}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">
                      {s.amount.toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={settlementStatusColors[s.status] || 'bg-gray-100 text-gray-800'}>
                        {s.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 hidden md:table-cell">
                      {new Date(s.period_start).toLocaleDateString()} -{' '}
                      {new Date(s.period_end).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-gray-600 capitalize hidden lg:table-cell">
                      {s.method || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell">
                      {new Date(s.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
            <p className="text-sm text-gray-500">
              Page {page} of {totalPages} ({total} settlements)
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
