'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Package,
  Search,
  Plus,
  ChevronLeft,
  ChevronRight,
  Eye,
  Pencil,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { nestjsItems } from '@/lib/api/nestjs/items';
import { useToast } from '@/components/shared/Toast';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import type { Item } from '@/types/nestjs/api';

export default function VendorItemsPage() {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const limit = 12;

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, unknown> = { page, limit };
      if (search.trim()) params.search = search.trim();
      const res = await nestjsItems.vendor.list(params as Parameters<typeof nestjsItems.vendor.list>[0]);
      if (res.success) {
        let filtered = res.data;
        if (statusFilter === 'active') {
          filtered = filtered.filter((i) => i.status);
        } else if (statusFilter === 'inactive') {
          filtered = filtered.filter((i) => !i.status);
        }
        setItems(filtered);
        setTotalPages(res.meta?.totalPages ?? 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load items.');
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleToggleStatus = async (item: Item) => {
    try {
      await nestjsItems.vendor.updateStatus(item.id, !item.status);
      toast.success(
        `${item.name} ${!item.status ? 'activated' : 'deactivated'}`
      );
      fetchItems();
    } catch (err) {
      toast.error('Failed to update item status.');
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchItems();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">Items</h1>
        <button
          onClick={() => router.push('/vendor/items/new')}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg text-sm font-semibold hover:bg-[#047a0e] transition-colors"
        >
          <Plus size={16} />
          Add New Item
        </button>
      </div>

      {/* Search + Filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <form onSubmit={handleSearchSubmit} className="flex-1 relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items..."
            className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
          />
        </form>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center min-h-[300px]">
          <LoadingSpinner size="lg" text="Loading items..." />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center min-h-[300px] gap-4">
          <p className="text-red-600 text-sm">{error}</p>
          <button
            onClick={fetchItems}
            className="px-4 py-2 bg-[#059211] text-white rounded-lg text-sm hover:bg-[#047a0e] transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Items Grid */}
      {!loading && !error && items.length === 0 && (
        <div className="bg-white rounded-lg border p-12 text-center">
          <Package className="mx-auto mb-3 text-gray-300" size={48} />
          <p className="text-gray-500 text-sm">No items found</p>
          <button
            onClick={() => router.push('/vendor/items/new')}
            className="mt-4 text-sm text-[#059211] hover:underline font-medium"
          >
            Create your first item
          </button>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {items.map((item) => (
              <div
                key={item.id}
                className="bg-white rounded-lg border overflow-hidden hover:shadow-sm transition-shadow"
              >
                {/* Image */}
                <div className="h-36 bg-gray-100 relative">
                  {item.image ? (
                    <img
                      src={item.image}
                      alt={item.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full">
                      <Package className="text-gray-300" size={32} />
                    </div>
                  )}
                  <span
                    className={`absolute top-2 right-2 text-xs px-2 py-0.5 rounded-full font-medium ${
                      item.status
                        ? 'bg-green-100 text-green-700'
                        : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {item.status ? 'Active' : 'Inactive'}
                  </span>
                </div>

                <div className="p-3">
                  <h3 className="text-sm font-semibold text-gray-900 truncate">
                    {item.name}
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                    {item.category?.name || 'Uncategorized'}
                  </p>

                  <div className="flex items-center justify-between mt-2">
                    <div>
                      <span className="text-sm font-bold text-gray-900">
                        ₹{item.price.toFixed(2)}
                      </span>
                      {item.discount > 0 && (
                        <span className="ml-1 text-xs text-red-500">
                          -{item.discount}
                          {item.discount_type === 'percent' ? '%' : '₹'}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-gray-500">
                      Stock: {item.stock}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 mt-3 pt-3 border-t">
                    <button
                      onClick={() =>
                        router.push(`/vendor/items/${item.id}`)
                      }
                      className="flex-1 flex items-center justify-center gap-1 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
                    >
                      <Pencil size={12} />
                      Edit
                    </button>
                    <button
                      onClick={() => handleToggleStatus(item)}
                      className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-xs font-medium rounded transition-colors ${
                        item.status
                          ? 'bg-red-50 text-red-600 hover:bg-red-100'
                          : 'bg-green-50 text-green-600 hover:bg-green-100'
                      }`}
                    >
                      {item.status ? (
                        <ToggleRight size={12} />
                      ) : (
                        <ToggleLeft size={12} />
                      )}
                      {item.status ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-2 rounded-lg border hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-2 rounded-lg border hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
