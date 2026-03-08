'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ShoppingCart, DollarSign, Clock, Star } from 'lucide-react';
import { nestjsVendorDashboard } from '@/lib/api/nestjs/vendor-dashboard';
import { nestjsOrders } from '@/lib/api/nestjs/orders';
import { StatCard } from '@/components/vendor/StatCard';
import { OrderCard } from '@/components/vendor/OrderCard';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import type { VendorDashboard, Order } from '@/types/nestjs/api';

export default function VendorDashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<VendorDashboard | null>(null);
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    setLoading(true);
    setError('');
    try {
      const [statsRes, ordersRes] = await Promise.all([
        nestjsVendorDashboard.getStats(),
        nestjsOrders.vendor.list({ page: 1, limit: 10 }),
      ]);
      if (statsRes.success) {
        setStats(statsRes.data);
      }
      if (ordersRes.success) {
        setRecentOrders(ordersRes.data);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load dashboard data.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleAcceptOrder = async (id: number) => {
    try {
      await nestjsOrders.vendor.updateStatus(id, 'confirmed');
      fetchDashboardData();
    } catch {
      // Silently fail; user can retry
    }
  };

  const handleRejectOrder = async (id: number) => {
    try {
      await nestjsOrders.vendor.updateStatus(id, 'cancelled');
      fetchDashboardData();
    } catch {
      // Silently fail
    }
  };

  const handleViewOrder = (id: number) => {
    router.push(`/vendor/orders/${id}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" text="Loading dashboard..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-red-600 text-sm">{error}</p>
        <button
          onClick={fetchDashboardData}
          className="px-4 py-2 bg-[#059211] text-white rounded-lg text-sm hover:bg-[#047a0e] transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Today's Orders"
          value={stats?.today_orders ?? 0}
          icon={ShoppingCart}
          color="blue"
        />
        <StatCard
          title="Today's Earning"
          value={`₹${(stats?.today_earning ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}
          icon={DollarSign}
          color="green"
        />
        <StatCard
          title="Pending Orders"
          value={stats?.pending_orders ?? 0}
          icon={Clock}
          color="yellow"
        />
        <StatCard
          title="Avg Rating"
          value={(stats?.avg_rating ?? 0).toFixed(1)}
          icon={Star}
          color="purple"
        />
      </div>

      {/* Recent Orders */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Recent Orders
          </h2>
          <button
            onClick={() => router.push('/vendor/orders')}
            className="text-sm text-[#059211] hover:underline font-medium"
          >
            View All
          </button>
        </div>

        {recentOrders.length === 0 ? (
          <div className="bg-white rounded-lg border p-8 text-center">
            <ShoppingCart className="mx-auto mb-3 text-gray-300" size={48} />
            <p className="text-gray-500 text-sm">No recent orders</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {recentOrders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                onAccept={handleAcceptOrder}
                onReject={handleRejectOrder}
                onView={handleViewOrder}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
