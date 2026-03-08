'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsStores } from '@/lib/api/nestjs/stores'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { StoreCard } from '@/components/shop/StoreCard'
import { Input } from '@/components/ui/input'
import { Search, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Module, Store } from '@/types/nestjs/api'

export default function StoresPage() {
  const toast = useToast()

  const [modules, setModules] = useState<Module[]>([])
  const [activeModule, setActiveModule] = useState<number | undefined>(undefined)
  const [stores, setStores] = useState<Store[]>([])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    nestjsStores
      .getModules()
      .then((res) => {
        if (res.data) setModules(res.data)
      })
      .catch(() => {})
  }, [])

  const fetchStores = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsStores.list({
        module_id: activeModule,
        search: search || undefined,
        page,
        limit: 12,
      })
      setStores(res.data)
      setTotalPages(res.meta?.totalPages ?? 1)
    } catch {
      toast.error('Failed to load stores')
    } finally {
      setLoading(false)
    }
  }, [activeModule, search, page, toast])

  useEffect(() => {
    fetchStores()
  }, [fetchStores])

  const handleModuleChange = (moduleId: number | undefined) => {
    setActiveModule(moduleId)
    setPage(1)
  }

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    fetchStores()
  }

  return (
    <div className="px-4 py-4 pb-24">
      {/* Search */}
      <form onSubmit={handleSearchSubmit} className="mb-4">
        <div className="relative">
          <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            placeholder="Search stores..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
      </form>

      {/* Module Filter Tabs */}
      {modules.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-3 mb-4 scrollbar-hide">
          <button
            onClick={() => handleModuleChange(undefined)}
            className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              activeModule === undefined
                ? 'bg-[#059211] text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            All
          </button>
          {modules.map((mod) => (
            <button
              key={mod.id}
              onClick={() => handleModuleChange(mod.id)}
              className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                activeModule === mod.id
                  ? 'bg-[#059211] text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {mod.module_name}
              {mod.stores_count > 0 && (
                <span className="ml-1 text-xs opacity-75">({mod.stores_count})</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Stores Grid */}
      {loading ? (
        <div className="flex justify-center py-20">
          <LoadingSpinner size="lg" text="Loading stores..." />
        </div>
      ) : stores.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-500 text-sm">No stores found.</p>
          {search && (
            <button
              onClick={() => {
                setSearch('')
                setPage(1)
              }}
              className="mt-2 text-[#059211] text-sm hover:underline"
            >
              Clear search
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {stores.map((store) => (
              <StoreCard key={store.id} store={store} />
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
