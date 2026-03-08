'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ShoppingCart, RefreshCw } from 'lucide-react';
import { nestjsOrders } from '@/lib/api/nestjs/orders';
import { useToast } from '@/components/shared/Toast';
import { OrderCard } from '@/components/vendor/OrderCard';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import type { Order, OrderStatus } from '@/types/nestjs/api';

const tabs: { label: string; value: string }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'pending' },
  { label: 'Processing', value: 'processing' },
  { label: 'Delivered', value: 'delivered' },
  { label: 'Cancelled', value: 'cancelled' },
];

export default function VendorOrdersPage() {
  const router = useRouter();
  const toast = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const refreshInterval = useRef<NodeJS.Timeout | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const params: Record<string, unknown> = { page, limit: 20 };
      if (activeTab !== 'all') {
        params.status = activeTab;
      }
      const res = await nestjsOrders.vendor.list(
        params as Parameters<typeof nestjsOrders.vendor.list>[0]
      );
      if (res.success) {
        setOrders(res.data);
        setTotalPages(res.meta?.totalPages ?? 1);
      }
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders.');
    } finally {
      setLoading(false);
    }
  }, [page, activeTab]);

  useEffect(() => {
    setLoading(true);
    fetchOrders();
  }, [fetchOrders]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    refreshInterval.current = setInterval(() => {
      fetchOrders();
    }, 30000);
    return () => {
      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
      }
    };
  }, [fetchOrders]);

  const handleAccept = async (id: number) => {
    try {
      await nestjsOrders.vendor.updateStatus(id, 'confirmed');
      toast.success(`Order #${id} accepted`);
      fetchOrders();
    } catch (err) {
      toast.error('Failed to accept order.');
    }
  };

  const handleReject = async (id: number) => {
    try {
      await nestjsOrders.vendor.updateStatus(id, 'cancelled');
      toast.success(`Order #${id} rejected`);
      fetchOrders();
    } catch (err) {
      toast.error('Failed to reject order.');
    }
  };

  const handleView = (id: number) => {
    router.push(`/vendor/orders/${id}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
        <button
          onClick={() => {
            setLoading(true);
            fetchOrders();
          }}
          className="inline-flex items-center gap-2 px-3 py-2 border rounded-lg text-sm text-gray-700 hover:bg-gray-100 transition-colors"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => {
              setActiveTab(tab.value);
              setPage(1);
            }}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === tab.value
                ? 'border-[#059211] text-[#059211]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center min-h-[300px]">
          <LoadingSpinner size="lg" text="Loading orders..." />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center min-h-[300px] gap-4">
          <p className="text-red-600 text-sm">{error}</p>
          <button
            onClick={fetchOrders}
            className="px-4 py-2 bg-[#059211] text-white rounded-lg text-sm hover:bg-[#047a0e] transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && orders.length === 0 && (
        <div className="bg-white rounded-lg border p-12 text-center">
          <ShoppingCart className="mx-auto mb-3 text-gray-300" size={48} />
          <p className="text-gray-500 text-sm">No orders found</p>
        </div>
      )}

      {/* Order cards */}
      {!loading && !error && orders.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {orders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                onAccept={handleAccept}
                onReject={handleReject}
                onView={handleView}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 pt-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {/* Auto-refresh indicator */}
      <p className="text-center text-xs text-gray-400">
        Auto-refreshes every 30 seconds
      </p>
    </div>
  );
}
