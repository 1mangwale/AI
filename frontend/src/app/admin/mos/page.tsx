'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, AlertCircle, TrendingUp, TrendingDown,
  DollarSign, ShoppingCart, Users, Clock, Bike, BarChart3,
  ArrowRight, Calendar,
} from 'lucide-react';
import { mangwaleAIClient } from '@/lib/api/mangwale-ai';
import { formatCurrency } from '@/lib/utils/format';

interface DashboardVitals {
  gmv: number;
  totalOrders: number;
  completedOrders: number;
  avgOrderValue: number;
  activeUsers: number;
  newUsers: number;
  repeatUsers: number;
  repeatRate: number;
  avgDeliveryTimeMins: number;
  revenueEstimate: number;
  activeRiders: number;
}

interface HourlyVolume {
  hour: number;
  orders: number;
  gmv: number;
}

interface RevenueTrend {
  date: string;
  gmv: number;
  orders: number;
  aov: number;
}

interface DashboardData {
  date: string;
  vitals: DashboardVitals;
  hourlyVolume: HourlyVolume[];
  revenueTrend: RevenueTrend[];
}

export default function MosDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().split('T')[0],
  );

  useEffect(() => {
    loadDashboard();
  }, [selectedDate]);

  const loadDashboard = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await mangwaleAIClient.get<DashboardData>(
        `/mos/dashboard?date=${selectedDate}`,
      ).catch(() => null);
      setData(result);
    } catch (err: any) {
      console.error('Failed to load dashboard:', err);
      setError(err.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <RefreshCw className="animate-spin text-[#059211]" size={48} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-red-50 border-2 border-red-200 rounded-lg p-8 text-center">
        <AlertCircle className="mx-auto mb-4 text-red-600" size={48} />
        <h3 className="text-xl font-bold text-red-900 mb-2">
          {error || 'Failed to load dashboard'}
        </h3>
        <button
          onClick={loadDashboard}
          className="mt-4 px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
        >
          Retry
        </button>
      </div>
    );
  }

  const v = data.vitals;

  // Find max hourly orders for bar scaling
  const maxHourlyOrders = Math.max(...data.hourlyVolume.map((h) => h.orders), 1);

  // Revenue trend: compute day-over-day change
  const trendLen = data.revenueTrend.length;
  const gmvChange =
    trendLen >= 2
      ? data.revenueTrend[trendLen - 1].gmv - data.revenueTrend[trendLen - 2].gmv
      : 0;
  const gmvChangePercent =
    trendLen >= 2 && data.revenueTrend[trendLen - 2].gmv > 0
      ? Math.round(
          (gmvChange / data.revenueTrend[trendLen - 2].gmv) * 100,
        )
      : 0;
  const maxTrendGmv = Math.max(...data.revenueTrend.map((t) => t.gmv), 1);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#059211] to-[#047a0e] rounded-2xl p-8 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">The Vitals</h1>
            <p className="text-green-100">
              Mangwale Operations System -- CEO Dashboard
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-white/20 rounded-lg px-3 py-2">
              <Calendar size={18} />
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-transparent text-white border-none outline-none text-sm"
              />
            </div>
            <button
              onClick={loadDashboard}
              className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all"
            >
              <RefreshCw size={20} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Primary Vitals -- 4 big cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <VitalCard
          icon={<DollarSign size={28} />}
          label="Today's GMV"
          value={formatCurrency(v.gmv)}
          sub={`Est. revenue: ${formatCurrency(v.revenueEstimate)}`}
          color="green"
        />
        <VitalCard
          icon={<ShoppingCart size={28} />}
          label="Total Orders"
          value={String(v.totalOrders)}
          sub={`${v.completedOrders} delivered, ${v.totalOrders - v.completedOrders} other`}
          color="blue"
        />
        <VitalCard
          icon={<Bike size={28} />}
          label="Active Riders"
          value={String(v.activeRiders)}
          sub="On duty today"
          color="orange"
        />
        <VitalCard
          icon={<Clock size={28} />}
          label="Avg Delivery"
          value={`${v.avgDeliveryTimeMins} min`}
          sub="Order to doorstep"
          color="purple"
        />
      </div>

      {/* Secondary metrics -- 4 smaller cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SmallCard label="AOV" value={formatCurrency(v.avgOrderValue)} />
        <SmallCard label="New Customers" value={String(v.newUsers)} />
        <SmallCard label="Repeat Rate" value={`${v.repeatRate}%`} />
        <SmallCard label="Active Users" value={String(v.activeUsers)} />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Hourly Order Volume */}
        <div className="bg-white rounded-xl p-6 shadow-md border-2 border-gray-100 hover:border-[#059211] transition-all">
          <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <BarChart3 className="text-[#059211]" size={20} />
            Hourly Order Volume
          </h3>
          <div className="flex items-end gap-1 h-40">
            {data.hourlyVolume.map((h) => (
              <div
                key={h.hour}
                className="flex-1 flex flex-col items-center group relative"
              >
                <div
                  className="w-full bg-[#059211]/80 hover:bg-[#059211] rounded-t transition-all cursor-pointer"
                  style={{
                    height: `${(h.orders / maxHourlyOrders) * 100}%`,
                    minHeight: h.orders > 0 ? '4px' : '0px',
                  }}
                >
                  <div className="hidden group-hover:block absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                    {h.hour}:00 - {h.orders} orders ({formatCurrency(h.gmv)})
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-between text-xs text-gray-400 mt-2">
            <span>12 AM</span>
            <span>6 AM</span>
            <span>12 PM</span>
            <span>6 PM</span>
            <span>11 PM</span>
          </div>
        </div>

        {/* Revenue Trend */}
        <div className="bg-white rounded-xl p-6 shadow-md border-2 border-gray-100 hover:border-[#059211] transition-all">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <TrendingUp className="text-[#059211]" size={20} />
              Revenue Trend (7 Days)
            </h3>
            <div className="flex items-center gap-1 text-sm">
              {gmvChange >= 0 ? (
                <TrendingUp size={16} className="text-green-600" />
              ) : (
                <TrendingDown size={16} className="text-red-600" />
              )}
              <span
                className={gmvChange >= 0 ? 'text-green-600' : 'text-red-600'}
              >
                {gmvChangePercent > 0 ? '+' : ''}
                {gmvChangePercent}%
              </span>
            </div>
          </div>
          <div className="flex items-end gap-2 h-40">
            {data.revenueTrend.map((t) => (
              <div
                key={t.date}
                className="flex-1 flex flex-col items-center group relative"
              >
                <div
                  className="w-full bg-blue-500/80 hover:bg-blue-600 rounded-t transition-all cursor-pointer"
                  style={{
                    height: `${(t.gmv / maxTrendGmv) * 100}%`,
                    minHeight: t.gmv > 0 ? '4px' : '0px',
                  }}
                >
                  <div className="hidden group-hover:block absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                    {t.date}: {formatCurrency(t.gmv)} ({t.orders} orders)
                  </div>
                </div>
                <span className="text-[10px] text-gray-400 mt-1 truncate w-full text-center">
                  {t.date.slice(5)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Quick Links */}
      <div className="bg-white rounded-xl p-6 shadow-md border-2 border-gray-100">
        <h3 className="text-lg font-bold text-gray-900 mb-4">Quick Actions</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <a
            href="/admin/mos/operations"
            className="flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-green-50 hover:border-[#059211] border-2 border-transparent transition-all"
          >
            <span className="font-medium text-gray-900">Operations Intel</span>
            <ArrowRight size={18} className="text-gray-400" />
          </a>
          <a
            href="/admin/analytics"
            className="flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-green-50 hover:border-[#059211] border-2 border-transparent transition-all"
          >
            <span className="font-medium text-gray-900">AI Analytics</span>
            <ArrowRight size={18} className="text-gray-400" />
          </a>
          <a
            href="/admin/dashboard"
            className="flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-green-50 hover:border-[#059211] border-2 border-transparent transition-all"
          >
            <span className="font-medium text-gray-900">Admin Dashboard</span>
            <ArrowRight size={18} className="text-gray-400" />
          </a>
        </div>
      </div>
    </div>
  );
}

// ---- Helper Components ----

function VitalCard({
  icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  color: 'green' | 'blue' | 'orange' | 'purple';
}) {
  const colors = {
    green: 'bg-green-50 text-green-700 border-green-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    orange: 'bg-orange-50 text-orange-700 border-orange-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
  };
  const iconBg = {
    green: 'bg-green-100 text-green-600',
    blue: 'bg-blue-100 text-blue-600',
    orange: 'bg-orange-100 text-orange-600',
    purple: 'bg-purple-100 text-purple-600',
  };

  return (
    <div
      className={`rounded-xl p-5 border-2 shadow-md ${colors[color]} hover:shadow-lg transition-all`}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2 rounded-lg ${iconBg[color]}`}>{icon}</div>
        <span className="text-sm font-medium opacity-80">{label}</span>
      </div>
      <p className="text-2xl font-bold mb-1">{value}</p>
      <p className="text-xs opacity-60">{sub}</p>
    </div>
  );
}

function SmallCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200 text-center">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

