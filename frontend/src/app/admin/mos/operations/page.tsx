'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, AlertCircle, Clock, Store, AlertTriangle,
  BarChart3, Calendar, Filter, ArrowUp, ArrowDown,
} from 'lucide-react';
import { mangwaleAIClient } from '@/lib/api/mangwale-ai';
import { formatCurrency } from '@/lib/utils/format';

interface OrderStats {
  totalOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  avgDeliveryTimeMins: number;
  avgPrepTimeMins: number;
  avgTransitTimeMins: number;
  totalGMV: number;
  peakHour: number;
  ordersByModule: { moduleId: number; moduleName: string; count: number }[];
}

interface HourlyVolume {
  hour: number;
  orders: number;
  gmv: number;
}

interface SlowOrder {
  orderId: number;
  storeName: string;
  totalTimeMins: number;
  prepTimeMins: number;
  transitTimeMins: number;
  orderTotal: number;
  status: string;
}

interface StorePerformance {
  storeId: number;
  storeName: string;
  orderCount: number;
  avgDeliveryMins: number;
  avgPrepMins: number;
  completionRate: number;
  totalRevenue: number;
}

interface MonthlyData {
  month: string;
  gmv: number;
  orders: number;
  avgOrderValue: number;
  uniqueCustomers: number;
  newCustomers: number;
}

type Tab = 'overview' | 'slow-orders' | 'stores' | 'monthly';

export default function OperationsIntelPage() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().split('T')[0],
  );
  const [zoneId, setZoneId] = useState<string>('');
  const [threshold, setThreshold] = useState('45');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [orderStats, setOrderStats] = useState<OrderStats | null>(null);
  const [hourlyVolume, setHourlyVolume] = useState<HourlyVolume[]>([]);
  const [slowOrders, setSlowOrders] = useState<SlowOrder[]>([]);
  const [storePerformance, setStorePerformance] = useState<StorePerformance[]>([]);
  const [monthlyData, setMonthlyData] = useState<MonthlyData[]>([]);

  useEffect(() => {
    loadData();
  }, [selectedDate, zoneId, activeTab]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      const zoneParam = zoneId ? `&zoneId=${zoneId}` : '';

      if (activeTab === 'overview') {
        const [stats, hourly] = await Promise.all([
          mangwaleAIClient.get<OrderStats>(
            `/mos/operations/order-stats?date=${selectedDate}${zoneParam}`,
          ).catch(() => null),
          mangwaleAIClient.get<HourlyVolume[]>(
            `/mos/operations/hourly-volume?date=${selectedDate}${zoneParam}`,
          ).catch(() => [] as HourlyVolume[]),
        ]);
        setOrderStats(stats);
        setHourlyVolume(hourly);
      } else if (activeTab === 'slow-orders') {
        const data = await mangwaleAIClient.get<SlowOrder[]>(
          `/mos/operations/slow-orders?date=${selectedDate}&threshold=${threshold}`,
        ).catch(() => [] as SlowOrder[]);
        setSlowOrders(data);
      } else if (activeTab === 'stores') {
        const data = await mangwaleAIClient.get<StorePerformance[]>(
          `/mos/operations/store-performance?date=${selectedDate}&limit=30`,
        ).catch(() => [] as StorePerformance[]);
        setStorePerformance(data);
      } else if (activeTab === 'monthly') {
        const data = await mangwaleAIClient.get<MonthlyData[]>(
          `/mos/operations/monthly?months=6`,
        ).catch(() => [] as MonthlyData[]);
        setMonthlyData(data);
      }
    } catch (err: any) {
      console.error('Failed to load operations data:', err);
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <BarChart3 size={16} /> },
    { id: 'slow-orders', label: 'Slow Orders', icon: <AlertTriangle size={16} /> },
    { id: 'stores', label: 'Store Ranking', icon: <Store size={16} /> },
    { id: 'monthly', label: 'Monthly Trends', icon: <Clock size={16} /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-gray-800 to-gray-900 rounded-2xl p-8 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Operations Intel</h1>
            <p className="text-gray-300">
              Order timing, store performance, and delivery analytics
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-white/10 rounded-lg px-3 py-2">
              <Calendar size={18} />
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-transparent text-white border-none outline-none text-sm"
              />
            </div>
            <div className="flex items-center gap-2 bg-white/10 rounded-lg px-3 py-2">
              <Filter size={18} />
              <input
                type="text"
                placeholder="Zone ID"
                value={zoneId}
                onChange={(e) => setZoneId(e.target.value)}
                className="bg-transparent text-white border-none outline-none text-sm w-20 placeholder-gray-400"
              />
            </div>
            <button
              onClick={loadData}
              className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all"
            >
              <RefreshCw size={20} />
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-200 pb-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-t-lg font-medium text-sm transition-all ${
              activeTab === tab.id
                ? 'bg-white border-2 border-b-0 border-gray-200 text-[#059211]'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border-2 border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="text-red-600" size={20} />
          <span className="text-red-800">{error}</span>
          <button
            onClick={loadData}
            className="ml-auto px-3 py-1 bg-red-600 text-white rounded text-sm hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center h-48">
          <RefreshCw className="animate-spin text-[#059211]" size={32} />
        </div>
      )}

      {/* Tab Content */}
      {!loading && !error && (
        <>
          {activeTab === 'overview' && orderStats && (
            <OverviewTab stats={orderStats} hourly={hourlyVolume} />
          )}
          {activeTab === 'slow-orders' && (
            <SlowOrdersTab
              orders={slowOrders}
              threshold={threshold}
              onThresholdChange={(v) => {
                setThreshold(v);
                // Reload with new threshold
                setTimeout(loadData, 0);
              }}
            />
          )}
          {activeTab === 'stores' && (
            <StoreRankingTab stores={storePerformance} />
          )}
          {activeTab === 'monthly' && (
            <MonthlyTrendsTab data={monthlyData} />
          )}
        </>
      )}
    </div>
  );
}

// ---- Tab Components ----

function OverviewTab({
  stats,
  hourly,
}: {
  stats: OrderStats;
  hourly: HourlyVolume[];
}) {
  const maxOrders = Math.max(...hourly.map((h) => h.orders), 1);

  return (
    <div className="space-y-6">
      {/* Timing Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <MetricCard label="Total Orders" value={String(stats.totalOrders)} />
        <MetricCard label="Delivered" value={String(stats.completedOrders)} color="green" />
        <MetricCard label="Cancelled" value={String(stats.cancelledOrders)} color="red" />
        <MetricCard label="Avg Delivery" value={`${stats.avgDeliveryTimeMins}m`} />
        <MetricCard label="Avg Prep" value={`${stats.avgPrepTimeMins}m`} />
        <MetricCard label="Avg Transit" value={`${stats.avgTransitTimeMins}m`} />
      </div>

      {/* GMV + Peak Hour */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <p className="text-sm text-gray-500">Total GMV</p>
          <p className="text-2xl font-bold text-gray-900">{formatCurrency(stats.totalGMV)}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <p className="text-sm text-gray-500">Peak Hour</p>
          <p className="text-2xl font-bold text-gray-900">{stats.peakHour}:00</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <p className="text-sm text-gray-500">Module Breakdown</p>
          <div className="flex gap-2 mt-1 flex-wrap">
            {stats.ordersByModule.map((m) => (
              <span
                key={m.moduleId}
                className="px-2 py-1 bg-gray-100 rounded text-xs font-medium"
              >
                {m.moduleName}: {m.count}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Hourly Heatmap */}
      <div className="bg-white rounded-xl p-6 shadow-md border-2 border-gray-100">
        <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
          <BarChart3 className="text-[#059211]" size={20} />
          Hourly Order Volume
        </h3>
        <div className="grid grid-cols-24 gap-1">
          {hourly.map((h) => {
            const intensity = maxOrders > 0 ? h.orders / maxOrders : 0;
            return (
              <div key={h.hour} className="group relative">
                <div
                  className="w-full aspect-square rounded cursor-pointer transition-all hover:scale-110"
                  style={{
                    backgroundColor:
                      intensity === 0
                        ? '#f3f4f6'
                        : `rgba(5, 146, 17, ${0.2 + intensity * 0.8})`,
                  }}
                />
                <div className="hidden group-hover:block absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                  {h.hour}:00 -- {h.orders} orders
                </div>
                <p className="text-[8px] text-gray-400 text-center mt-0.5">
                  {h.hour}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SlowOrdersTab({
  orders,
  threshold,
  onThresholdChange,
}: {
  orders: SlowOrder[];
  threshold: string;
  onThresholdChange: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <label className="text-sm text-gray-600">
          Threshold (minutes):
        </label>
        <input
          type="number"
          value={threshold}
          onChange={(e) => onThresholdChange(e.target.value)}
          className="w-20 px-3 py-1 border border-gray-300 rounded-lg text-sm"
        />
        <span className="text-sm text-gray-500">
          {orders.length} orders exceeding {threshold} min
        </span>
      </div>

      <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Order ID</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Store</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Total Time</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Prep</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Transit</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Amount</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  No slow orders found for this date
                </td>
              </tr>
            ) : (
              orders.map((o) => (
                <tr
                  key={o.orderId}
                  className="border-t border-gray-100 hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-mono text-gray-900">
                    #{o.orderId}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{o.storeName}</td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={`font-bold ${
                        o.totalTimeMins > 60
                          ? 'text-red-600'
                          : 'text-orange-600'
                      }`}
                    >
                      {o.totalTimeMins}m
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {o.prepTimeMins}m
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {o.transitTimeMins}m
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    Rs {(o.orderTotal ?? 0).toFixed(0)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StoreRankingTab({ stores }: { stores: StorePerformance[] }) {
  return (
    <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-600">#</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Store</th>
            <th className="px-4 py-3 text-right font-medium text-gray-600">Orders</th>
            <th className="px-4 py-3 text-right font-medium text-gray-600">Avg Delivery</th>
            <th className="px-4 py-3 text-right font-medium text-gray-600">Avg Prep</th>
            <th className="px-4 py-3 text-right font-medium text-gray-600">Completion</th>
            <th className="px-4 py-3 text-right font-medium text-gray-600">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {stores.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                No store data for this date
              </td>
            </tr>
          ) : (
            stores.map((s, i) => (
              <tr
                key={s.storeId}
                className="border-t border-gray-100 hover:bg-gray-50"
              >
                <td className="px-4 py-3 text-gray-400 font-medium">{i + 1}</td>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {s.storeName}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">
                  {s.orderCount}
                </td>
                <td className="px-4 py-3 text-right">
                  <span
                    className={`font-bold ${
                      s.avgDeliveryMins <= 30
                        ? 'text-green-600'
                        : s.avgDeliveryMins <= 45
                          ? 'text-orange-600'
                          : 'text-red-600'
                    }`}
                  >
                    {s.avgDeliveryMins}m
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-gray-600">
                  {s.avgPrepMins}m
                </td>
                <td className="px-4 py-3 text-right">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      s.completionRate >= 90
                        ? 'bg-green-100 text-green-700'
                        : s.completionRate >= 70
                          ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {s.completionRate}%
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-medium text-gray-900">
                  {formatCurrency(s.totalRevenue)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function MonthlyTrendsTab({ data }: { data: MonthlyData[] }) {
  const maxGmv = Math.max(...data.map((d) => d.gmv), 1);

  return (
    <div className="space-y-6">
      {/* Bar chart */}
      <div className="bg-white rounded-xl p-6 shadow-md border-2 border-gray-100">
        <h3 className="text-lg font-bold text-gray-900 mb-4">Monthly GMV</h3>
        <div className="flex items-end gap-4 h-48">
          {data.map((d, i) => {
            const prev = i > 0 ? data[i - 1].gmv : d.gmv;
            const change = prev > 0 ? ((d.gmv - prev) / prev) * 100 : 0;
            return (
              <div key={d.month} className="flex-1 flex flex-col items-center">
                <div className="flex items-center gap-1 mb-1 text-xs">
                  {change >= 0 ? (
                    <ArrowUp size={12} className="text-green-600" />
                  ) : (
                    <ArrowDown size={12} className="text-red-600" />
                  )}
                  <span className={change >= 0 ? 'text-green-600' : 'text-red-600'}>
                    {change >= 0 ? '+' : ''}
                    {Math.round(change)}%
                  </span>
                </div>
                <div
                  className="w-full bg-[#059211]/80 rounded-t transition-all"
                  style={{
                    height: `${(d.gmv / maxGmv) * 100}%`,
                    minHeight: d.gmv > 0 ? '4px' : '0px',
                  }}
                />
                <span className="text-xs text-gray-500 mt-2">{d.month}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Monthly table */}
      <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Month</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">GMV</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Orders</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">AOV</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Customers</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.month} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{d.month}</td>
                <td className="px-4 py-3 text-right text-gray-900 font-bold">
                  {formatCurrency(d.gmv)}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{d.orders}</td>
                <td className="px-4 py-3 text-right text-gray-700">
                  Rs {d.avgOrderValue}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">
                  {d.uniqueCustomers}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Helpers ----

function MetricCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: 'green' | 'red';
}) {
  const textColor =
    color === 'green'
      ? 'text-green-600'
      : color === 'red'
        ? 'text-red-600'
        : 'text-gray-900';

  return (
    <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200 text-center">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${textColor}`}>{value}</p>
    </div>
  );
}

