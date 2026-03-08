'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsItems } from '@/lib/api/nestjs/items'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Item } from '@/types/nestjs/api'
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Package,
  Star,
} from 'lucide-react'

export default function AdminCommerceItemsPage() {
  const toast = useToast()

  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [storeFilter, setStoreFilter] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsItems.admin.list({
        page,
        limit: 15,
        search: search || undefined,
        store_id: storeFilter ? Number(storeFilter) : undefined,
      })
      if (res.success) {
        setItems(res.data)
        setTotalPages(res.meta.totalPages)
        setTotal(res.meta.total)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load items'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [page, search, storeFilter, toast])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    fetchItems()
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Item Management</h1>
        <p className="text-sm text-gray-500 mt-1">
          Browse all items across stores ({total} total)
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              placeholder="Search items..."
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
          <Input
            type="number"
            placeholder="Store ID"
            value={storeFilter}
            onChange={(e) => {
              setStoreFilter(e.target.value)
              setPage(1)
            }}
            className="w-32"
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner text="Loading items..." />
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <Package size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No items found</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Item</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Store</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">Category</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Price</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Stock</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">Rating</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {item.image ? (
                          <img
                            src={item.image}
                            alt={item.name}
                            className="w-10 h-10 rounded-lg object-cover"
                          />
                        ) : (
                          <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                            <Package size={16} className="text-gray-400" />
                          </div>
                        )}
                        <div>
                          <p className="font-medium text-gray-900 truncate max-w-[200px]">
                            {item.name}
                          </p>
                          {item.veg && (
                            <span className="inline-block w-3 h-3 border border-green-600 rounded-sm mt-0.5">
                              <span className="block w-1.5 h-1.5 bg-green-600 rounded-full m-auto mt-[2px]" />
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                      {item.store?.name || `Store #${item.store_id}`}
                    </td>
                    <td className="px-4 py-3 text-gray-600 hidden lg:table-cell">
                      {item.category?.name || `Cat #${item.category_id}`}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div>
                        <span className="font-medium text-gray-900">
                          {item.price.toFixed(2)}
                        </span>
                        {item.discount > 0 && (
                          <span className="text-xs text-green-600 ml-1">
                            -{item.discount}{item.discount_type === 'percent' ? '%' : ''}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right hidden md:table-cell">
                      <span
                        className={`font-medium ${
                          item.stock <= 0
                            ? 'text-red-600'
                            : item.stock < 10
                            ? 'text-yellow-600'
                            : 'text-gray-900'
                        }`}
                      >
                        {item.stock}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        className={
                          item.status
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                        }
                      >
                        {item.status ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <div className="flex items-center gap-1">
                        <Star size={14} className="text-yellow-400 fill-yellow-400" />
                        <span className="text-gray-700">{item.avg_rating?.toFixed(1) || '0.0'}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
            <p className="text-sm text-gray-500">
              Page {page} of {totalPages} ({total} items)
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
