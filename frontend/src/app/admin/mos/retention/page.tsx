'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, AlertCircle, Users, Repeat, CreditCard,
  Clock, Sun, Sunset, Moon, CloudMoon, BarChart3,
  TrendingUp, Loader2, ArrowRight, IndianRupee,
} from 'lucide-react';
import { mangwaleAIClient } from '@/lib/api/mangwale-ai';

// ---- Types ----

interface RetentionOverview {
  reorderSuggestionsSent: number;
  reorderSentToday: number;
  refundsProcessed: number;
  refundAmount: number;
  avgRefundAmount: number;
  cohortCount: number;
  timingDistribution: Array<{ timeOfDay: string; userCount: number; percentage: number }>;
}

interface CohortData {
  cohort: string;
  totalUsers: number;
  retentionByMonth: Record<number, number>;
}

interface RetentionCurvePoint {
  month: number;
  retentionPct: number;
}

interface ReorderStats {
  totalSent: number;
  sentToday: number;
  pendingToday: number;
  topItems: Array<{ itemName: string; storeName: string; count: number }>;
  recentSuggestions: Array<{
    userId: number;
    itemName: string;
    storeName: string;
    daysSince: number;
    sentAt: string;
  }>;
}

interface RefundStats {
  totalRefunds: number;
  totalAmount: number;
  avgAmount: number;
  autoApproved: number;
  manualApproved: number;
  byReason: Array<{ reason: string; count: number; totalAmount: number }>;
}

interface TimingStats {
  distribution: Array<{ timeOfDay: string; userCount: number; percentage: number }>;
  totalUsers: number;
}

// ---- Constants ----

const TIMING_COLORS: Record<string, string> = {
  morning: '#f59e0b',
  afternoon: '#ef4444',
  evening: '#8b5cf6',
  night: '#3b82f6',
};

const TIMING_BG: Record<string, string> = {
  morning: 'bg-amber-50 border-amber-200',
  afternoon: 'bg-red-50 border-red-200',
  evening: 'bg-purple-50 border-purple-200',
  night: 'bg-blue-50 border-blue-200',
};

const TIMING_ICONS: Record<string, React.ReactNode> = {
  morning: <Sun size={20} className="text-amber-500" />,
  afternoon: <Sunset size={20} className="text-red-500" />,
  evening: <CloudMoon size={20} className="text-purple-500" />,
  night: <Moon size={20} className="text-blue-500" />,
};

const TIMING_LABELS: Record<string, string> = {
  morning: '5 AM - 12 PM',
  afternoon: '12 PM - 5 PM',
  evening: '5 PM - 9 PM',
  night: '9 PM - 5 AM',
};

const RETENTION_MONTHS = [0, 1, 2, 3, 6, 12];

const REASON_LABELS: Record<string, string> = {
  late_delivery: 'Late Delivery',
  cancelled_after_accept: 'Cancelled After Accept',
  missing_items: 'Missing Items',
  wrong_order: 'Wrong Order',
  quality_issue: 'Quality Issue',
};

// ---- Page Component ----

export default function RetentionIntelligencePage() {
  const [overview, setOverview] = useState<RetentionOverview | null>(null);
  const [cohorts, setCohorts] = useState<CohortData[]>([]);
  const [retentionCurve, setRetentionCurve] = useState<RetentionCurvePoint[]>([]);
  const [reorderStats, setReorderStats] = useState<ReorderStats | null>(null);
  const [refundStats, setRefundStats] = useState<RefundStats | null>(null);
  const [timingStats, setTimingStats] = useState<TimingStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      const [overviewRes, cohortsRes, curveRes, reorderRes, refundRes, timingRes] =
        await Promise.all([
          mangwaleAIClient.get<RetentionOverview>('/mos/retention/overview'),
          mangwaleAIClient.get<CohortData[]>('/mos/retention/cohorts?months=6'),
          mangwaleAIClient.get<RetentionCurvePoint[]>('/mos/retention/retention-curve'),
          mangwaleAIClient.get<ReorderStats>('/mos/retention/reorder-stats'),
          mangwaleAIClient.get<RefundStats>('/mos/retention/refund-stats'),
          mangwaleAIClient.get<TimingStats>('/mos/retention/timing-stats'),
        ]);

      setOverview(overviewRes);
      setCohorts(cohortsRes);
      setRetentionCurve(curveRes);
      setReorderStats(reorderRes);
      setRefundStats(refundRes);
      setTimingStats(timingRes);
    } catch (err: any) {
      console.error('Failed to load retention data:', err);
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleComputeCohorts = async () => {
    setComputing(true);
    try {
      const result = await mangwaleAIClient.post<{ computed: number; errors: number }>(
        '/mos/retention/compute-cohorts',
        {},
      );
      alert(`Computed ${result.computed} cohort records, ${result.errors} errors`);
      loadData();
    } catch (err: any) {
      setError(err.message || 'Cohort computation failed');
    } finally {
      setComputing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#059211] to-[#047a0e] rounded-2xl p-8 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Retention Intelligence</h1>
            <p className="text-green-100">
              Cohort retention, reorder nudges, auto-refunds, and notification timing
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleComputeCohorts}
              disabled={computing}
              className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all text-sm disabled:opacity-50"
            >
              {computing ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <TrendingUp size={18} />
              )}
              Compute Cohorts
            </button>
            <button
              onClick={loadData}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all"
            >
              <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
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

      {!loading && !error && (
        <>
          {/* Overview Cards */}
          {overview && <OverviewCards overview={overview} />}

          {/* Cohort Retention Table */}
          {cohorts.length > 0 && <CohortTable cohorts={cohorts} />}

          {/* Retention Curve + Timing Distribution */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {retentionCurve.length > 0 && <RetentionCurveChart data={retentionCurve} />}
            {timingStats && timingStats.distribution.length > 0 && (
              <TimingDistribution stats={timingStats} />
            )}
          </div>

          {/* Refund Breakdown */}
          {refundStats && refundStats.byReason.length > 0 && (
            <RefundBreakdown stats={refundStats} />
          )}

          {/* Reorder Top Items */}
          {reorderStats && reorderStats.topItems.length > 0 && (
            <ReorderTopItems stats={reorderStats} />
          )}
        </>
      )}
    </div>
  );
}

// ---- Sub-Components ----

function OverviewCards({ overview }: { overview: RetentionOverview }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
        <div className="flex items-center gap-2 text-gray-500 text-sm mb-2">
          <Repeat size={16} className="text-[#059211]" />
          Reorder Nudges
        </div>
        <p className="text-2xl font-bold text-gray-900">{overview.reorderSuggestionsSent}</p>
        <p className="text-xs text-gray-400 mt-1">
          {overview.reorderSentToday} sent today
        </p>
      </div>

      <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
        <div className="flex items-center gap-2 text-gray-500 text-sm mb-2">
          <CreditCard size={16} className="text-orange-500" />
          Refunds Processed
        </div>
        <p className="text-2xl font-bold text-gray-900">{overview.refundsProcessed}</p>
        <p className="text-xs text-gray-400 mt-1">
          Avg Rs {overview.avgRefundAmount}
        </p>
      </div>

      <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
        <div className="flex items-center gap-2 text-gray-500 text-sm mb-2">
          <IndianRupee size={16} className="text-red-500" />
          Total Refund Amount
        </div>
        <p className="text-2xl font-bold text-gray-900">{formatCurrency(overview.refundAmount)}</p>
        <p className="text-xs text-gray-400 mt-1">last 30 days</p>
      </div>

      <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
        <div className="flex items-center gap-2 text-gray-500 text-sm mb-2">
          <Users size={16} className="text-blue-500" />
          Tracked Cohorts
        </div>
        <p className="text-2xl font-bold text-gray-900">{overview.cohortCount}</p>
        <p className="text-xs text-gray-400 mt-1">monthly groups</p>
      </div>
    </div>
  );
}

function CohortTable({ cohorts }: { cohorts: CohortData[] }) {
  const getRetentionColor = (pct: number): string => {
    if (pct === 0) return 'bg-gray-50 text-gray-400';
    if (pct >= 60) return 'bg-green-100 text-green-800';
    if (pct >= 40) return 'bg-green-50 text-green-700';
    if (pct >= 20) return 'bg-yellow-50 text-yellow-700';
    if (pct >= 10) return 'bg-orange-50 text-orange-700';
    return 'bg-red-50 text-red-700';
  };

  return (
    <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
      <div className="p-5 border-b border-gray-100">
        <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
          <BarChart3 className="text-[#059211]" size={20} />
          Cohort Retention Table
        </h3>
        <p className="text-sm text-gray-500 mt-1">
          Percentage of users retained by month after signup
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Cohort</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Users</th>
              {RETENTION_MONTHS.map((m) => (
                <th key={m} className="px-4 py-3 text-center font-medium text-gray-600">
                  M{m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.cohort} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{c.cohort}</td>
                <td className="px-4 py-3 text-right text-gray-600">{c.totalUsers}</td>
                {RETENTION_MONTHS.map((m) => {
                  const pct = c.retentionByMonth[m] ?? 0;
                  return (
                    <td key={m} className="px-3 py-3 text-center">
                      <span
                        className={`inline-block px-2 py-1 rounded text-xs font-bold min-w-[40px] ${getRetentionColor(pct)}`}
                      >
                        {pct}%
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
            {cohorts.length === 0 && (
              <tr>
                <td colSpan={2 + RETENTION_MONTHS.length} className="px-4 py-8 text-center text-gray-400">
                  No cohort data. Click "Compute Cohorts" to generate.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RetentionCurveChart({ data }: { data: RetentionCurvePoint[] }) {
  const maxPct = Math.max(...data.map((d) => d.retentionPct), 1);

  return (
    <div className="bg-white rounded-xl p-6 shadow-md border-2 border-gray-100">
      <h3 className="text-lg font-bold text-gray-900 mb-1 flex items-center gap-2">
        <TrendingUp className="text-[#059211]" size={20} />
        Average Retention Curve
      </h3>
      <p className="text-sm text-gray-500 mb-4">
        Average retention across all cohorts by month
      </p>
      <div className="flex items-end gap-4 h-48">
        {data.map((d) => (
          <div key={d.month} className="flex-1 flex flex-col items-center">
            <span className="text-sm font-bold text-gray-700 mb-1">
              {d.retentionPct}%
            </span>
            <div
              className="w-full rounded-t transition-all"
              style={{
                height: `${maxPct > 0 ? (d.retentionPct / maxPct) * 100 : 0}%`,
                minHeight: d.retentionPct > 0 ? '4px' : '0px',
                backgroundColor: `rgba(5, 146, 17, ${0.3 + (d.retentionPct / Math.max(maxPct, 1)) * 0.7})`,
              }}
            />
            <span className="text-xs text-gray-500 mt-2 font-medium">M{d.month}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TimingDistribution({ stats }: { stats: TimingStats }) {
  const orderedSlots = ['morning', 'afternoon', 'evening', 'night'];
  const sortedDist = orderedSlots
    .map((slot) => stats.distribution.find((d) => d.timeOfDay === slot))
    .filter(Boolean) as TimingStats['distribution'];

  return (
    <div className="bg-white rounded-xl p-6 shadow-md border-2 border-gray-100">
      <h3 className="text-lg font-bold text-gray-900 mb-1 flex items-center gap-2">
        <Clock className="text-[#059211]" size={20} />
        Peak Order Timing
      </h3>
      <p className="text-sm text-gray-500 mb-4">
        When users typically order ({stats.totalUsers} users analyzed)
      </p>
      <div className="grid grid-cols-2 gap-3">
        {sortedDist.map((d) => (
          <div
            key={d.timeOfDay}
            className={`rounded-xl p-4 border-2 ${TIMING_BG[d.timeOfDay] || 'bg-gray-50 border-gray-200'}`}
          >
            <div className="flex items-center gap-2 mb-2">
              {TIMING_ICONS[d.timeOfDay]}
              <span className="font-semibold text-gray-800 capitalize">{d.timeOfDay}</span>
            </div>
            <p className="text-xs text-gray-500 mb-2">
              {TIMING_LABELS[d.timeOfDay] || ''}
            </p>
            {/* Progress bar */}
            <div className="w-full bg-white/50 rounded-full h-3 mb-1">
              <div
                className="h-3 rounded-full transition-all"
                style={{
                  width: `${d.percentage}%`,
                  backgroundColor: TIMING_COLORS[d.timeOfDay] || '#6b7280',
                }}
              />
            </div>
            <div className="flex justify-between items-center mt-1">
              <span className="text-lg font-bold text-gray-900">{d.userCount}</span>
              <span className="text-sm font-semibold" style={{ color: TIMING_COLORS[d.timeOfDay] || '#6b7280' }}>
                {d.percentage}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RefundBreakdown({ stats }: { stats: RefundStats }) {
  const maxCount = Math.max(...stats.byReason.map((r) => r.count), 1);

  return (
    <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
      <div className="p-5 border-b border-gray-100">
        <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
          <CreditCard className="text-[#059211]" size={20} />
          Refund Breakdown by Reason
        </h3>
        <p className="text-sm text-gray-500 mt-1">
          {stats.totalRefunds} refunds totaling Rs {stats.totalAmount} | Auto: {stats.autoApproved} | Manual: {stats.manualApproved}
        </p>
      </div>
      <div className="p-5 space-y-3">
        {stats.byReason.map((r) => (
          <div key={r.reason} className="flex items-center gap-4">
            <div className="w-40 text-sm font-medium text-gray-700 truncate">
              {REASON_LABELS[r.reason] || r.reason}
            </div>
            <div className="flex-1">
              <div className="bg-gray-100 rounded-full h-6 relative">
                <div
                  className="bg-[#059211]/70 h-6 rounded-full flex items-center justify-end pr-2 transition-all"
                  style={{ width: `${Math.max((r.count / maxCount) * 100, 8)}%` }}
                >
                  <span className="text-xs text-white font-medium">{r.count}</span>
                </div>
              </div>
            </div>
            <div className="w-24 text-right text-sm font-medium text-gray-600">
              {formatCurrency(r.totalAmount)}
            </div>
          </div>
        ))}
        {stats.byReason.length === 0 && (
          <p className="text-center text-gray-400 py-4">No refund data available</p>
        )}
      </div>
    </div>
  );
}

function ReorderTopItems({ stats }: { stats: ReorderStats }) {
  return (
    <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
      <div className="p-5 border-b border-gray-100">
        <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
          <Repeat className="text-[#059211]" size={20} />
          Top Reorder Items
        </h3>
        <p className="text-sm text-gray-500 mt-1">
          {stats.totalSent} total nudges sent | {stats.sentToday} today | {stats.pendingToday} pending
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">#</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Item</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Store</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Nudges Sent</th>
            </tr>
          </thead>
          <tbody>
            {stats.topItems.map((item, i) => (
              <tr key={`${item.itemName}-${item.storeName}`} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-400 font-medium">{i + 1}</td>
                <td className="px-4 py-3 font-medium text-gray-900">{item.itemName}</td>
                <td className="px-4 py-3 text-gray-600">{item.storeName}</td>
                <td className="px-4 py-3 text-right">
                  <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs font-bold">
                    {item.count}
                  </span>
                </td>
              </tr>
            ))}
            {stats.topItems.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                  No reorder suggestions sent yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Helpers ----

function formatCurrency(amount: number): string {
  if (amount >= 100000) return `Rs ${(amount / 100000).toFixed(1)}L`;
  if (amount >= 1000) return `Rs ${(amount / 1000).toFixed(1)}K`;
  return `Rs ${(amount ?? 0).toFixed(0)}`;
}
