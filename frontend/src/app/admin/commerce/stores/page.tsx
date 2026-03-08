'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsStores } from '@/lib/api/nestjs/stores'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Store } from '@/types/nestjs/api'
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Star,
  ToggleLeft,
  ToggleRight,
  Store as StoreIcon,
  Loader2,
} from 'lucide-react'

const STATUS_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Active', value: 'true' },
  { label: 'Inactive', value: 'false' },
]

export default function AdminCommerceStoresPage() {
  const toast = useToast()

  const [stores, setStores] = useState<Store[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [togglingId, setTogglingId] = useState<number | null>(null)

  const fetchStores = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsStores.admin.list({
        page,
        limit: 15,
        search: search || undefined,
        status: statusFilter || undefined,
      })
      if (res.success) {
        setStores(res.data)
        setTotalPages(res.meta.totalPages)
        setTotal(res.meta.total)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load stores'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [page, search, statusFilter, toast])

  useEffect(() => {
    fetchStores()
  }, [fetchStores])

  const handleToggleStatus = async (store: Store) => {
    setTogglingId(store.id)
    try {
      await nestjsStores.admin.updateStatus(store.id, !store.status)
      toast.success(`Store ${!store.status ? 'activated' : 'deactivated'}`)
      fetchStores()
    } catch {
      toast.error('Failed to update store status')
    } finally {
      setTogglingId(null)
    }
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    fetchStores()
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Store Management</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage all stores on the platform ({total} total)
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              placeholder="Search stores..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
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
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner text="Loading stores..." />
        </div>
      ) : stores.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <StoreIcon size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No stores found</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Store</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Owner</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">Rating</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">Zone</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Module</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {stores.map((store) => (
                  <tr key={store.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {store.logo ? (
                          <img
                            src={store.logo}
                            alt={store.name}
                            className="w-9 h-9 rounded-lg object-cover"
                          />
                        ) : (
                          <div className="w-9 h-9 bg-gray-100 rounded-lg flex items-center justify-center">
                            <StoreIcon size={16} className="text-gray-400" />
                          </div>
                        )}
                        <div>
                          <p className="font-medium text-gray-900">{store.name}</p>
                          <p className="text-xs text-gray-500">{store.phone}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                      {store.email}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        className={
                          store.status
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                        }
                      >
                        {store.status ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <div className="flex items-center gap-1">
                        <Star size={14} className="text-yellow-400 fill-yellow-400" />
                        <span className="text-gray-700">{store.avg_rating?.toFixed(1) || '0.0'}</span>
                        <span className="text-xs text-gray-400">({store.rating_count || 0})</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 hidden lg:table-cell">
                      Zone #{store.zone_id}
                    </td>
                    <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                      {store.module?.module_name || `Module #${store.module_id}`}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleToggleStatus(store)}
                        disabled={togglingId === store.id}
                        className="inline-flex items-center gap-1 text-sm hover:text-[#059211] transition-colors disabled:opacity-50"
                        title={store.status ? 'Deactivate' : 'Activate'}
                      >
                        {togglingId === store.id ? (
                          <Loader2 size={18} className="animate-spin text-gray-400" />
                        ) : store.status ? (
                          <ToggleRight size={22} className="text-[#059211]" />
                        ) : (
                          <ToggleLeft size={22} className="text-gray-400" />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
            <p className="text-sm text-gray-500">
              Page {page} of {totalPages} ({total} stores)
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
