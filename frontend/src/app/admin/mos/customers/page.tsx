'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, AlertCircle, Users, TrendingDown, Heart,
  AlertTriangle, Search, ChevronDown, ChevronUp, Loader2,
  ArrowUpRight, ArrowDownRight,
} from 'lucide-react';

interface CustomerHealth {
  id: string;
  userId: number;
  phone: string | null;
  rfmScore: string | null;
  rfmSegment: string | null;
  churnRisk: number;
  ltvPredicted: number;
  healthScore: number;
  recencyDays: number;
  frequency90d: number;
  avgOrderValue: number;
  complaintRate: number;
  lastComputedAt: string;
}

interface SegmentData {
  segment: string;
  count: number;
  avgHealth: number;
}

interface HealthDistribution {
  range: string;
  count: number;
}

const SEGMENT_COLORS: Record<string, string> = {
  champion: 'bg-green-100 text-green-700',
  loyal: 'bg-blue-100 text-blue-700',
  potential_loyalist: 'bg-cyan-100 text-cyan-700',
  new_customer: 'bg-purple-100 text-purple-700',
  promising: 'bg-teal-100 text-teal-700',
  need_attention: 'bg-yellow-100 text-yellow-700',
  about_to_sleep: 'bg-orange-100 text-orange-700',
  at_risk: 'bg-red-100 text-red-700',
  hibernating: 'bg-gray-100 text-gray-600',
  lost: 'bg-gray-200 text-gray-500',
};

export default function CustomerIntelligencePage() {
  const [customers, setCustomers] = useState<CustomerHealth[]>([]);
  const [total, setTotal] = useState(0);
  const [segments, setSegments] = useState<SegmentData[]>([]);
  const [distribution, setDistribution] = useState<HealthDistribution[]>([]);
  const [churnRisk, setChurnRisk] = useState<CustomerHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    segment: '',
    sortBy: 'health_score',
    sortOrder: 'desc',
    page: 0,
  });
  const [expandedUser, setExpandedUser] = useState<number | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (filters.segment) params.set('segment', filters.segment);
      params.set('sortBy', filters.sortBy);
      params.set('sortOrder', filters.sortOrder);
      params.set('limit', '50');
      params.set('offset', String(filters.page * 50));

      const [healthRes, segRes, distRes, churnRes] = await Promise.all([
        fetch(`/api/mos/customers/health?${params}`).then(r => r.json()).catch(() => ({ items: [], total: 0 })),
        fetch('/api/mos/customers/segments').then(r => r.json()).catch(() => []),
        fetch('/api/mos/customers/health-distribution').then(r => r.json()).catch(() => []),
        fetch('/api/mos/customers/churn-risk?threshold=0.4&limit=10').then(r => r.json()).catch(() => []),
      ]);

      setCustomers(healthRes.items || []);
      setTotal(healthRes.total || 0);
      setSegments(segRes || []);
      setDistribution(distRes || []);
      setChurnRisk(churnRes || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [filters]);

  const handleComputeAll = async () => {
    setComputing(true);
    try {
      const res = await fetch('/api/mos/customers/compute-health', { method: 'POST' });
      const data = await res.json();
      alert(`Computed: ${data.computed} scores, ${data.errors} errors`);
      loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setComputing(false);
    }
  };

  const getChurnColor = (risk: number) => {
    if (risk >= 0.7) return 'text-red-600';
    if (risk >= 0.4) return 'text-orange-600';
    return 'text-green-600';
  };

  const getHealthColor = (score: number) => {
    if (score >= 70) return 'text-green-600';
    if (score >= 40) return 'text-yellow-600';
    return 'text-red-600';
  };

  const maxDist = Math.max(...distribution.map(d => d.count), 1);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Customer Intelligence</h1>
          <p className="text-sm text-gray-500 mt-1">
            Health scores, churn prediction, and customer segments
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleComputeAll}
            disabled={computing}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 text-sm"
          >
            {computing ? <Loader2 size={16} className="animate-spin" /> : <Heart size={16} />}
            Compute All Scores
          </button>
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="text-red-500" size={20} />
          <span className="text-red-700">{error}</span>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border p-4">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <Users size={16} /> Total Tracked
          </div>
          <p className="text-2xl font-bold">{total}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="flex items-center gap-2 text-red-500 text-sm mb-1">
            <AlertTriangle size={16} /> High Churn Risk
          </div>
          <p className="text-2xl font-bold text-red-600">{churnRisk.length}</p>
          <p className="text-xs text-gray-400">risk &gt; 0.4</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="flex items-center gap-2 text-green-500 text-sm mb-1">
            <Heart size={16} /> Champions
          </div>
          <p className="text-2xl font-bold text-green-600">
            {segments.find(s => s.segment === 'champion')?.count || 0}
          </p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="flex items-center gap-2 text-orange-500 text-sm mb-1">
            <TrendingDown size={16} /> At Risk
          </div>
          <p className="text-2xl font-bold text-orange-600">
            {segments.find(s => s.segment === 'at_risk')?.count || 0}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Health Distribution */}
        <div className="bg-white rounded-lg border p-6">
          <h2 className="text-lg font-semibold mb-4">Health Score Distribution</h2>
          <div className="space-y-3">
            {distribution.map(d => (
              <div key={d.range} className="flex items-center gap-3">
                <span className="w-16 text-sm text-gray-600 text-right">{d.range}</span>
                <div className="flex-1 bg-gray-100 rounded-full h-6 relative">
                  <div
                    className="bg-blue-500 h-6 rounded-full flex items-center justify-end pr-2"
                    style={{ width: `${Math.max((d.count / maxDist) * 100, 5)}%` }}
                  >
                    <span className="text-xs text-white font-medium">{d.count}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Segment Breakdown */}
        <div className="bg-white rounded-lg border p-6">
          <h2 className="text-lg font-semibold mb-4">Customer Segments</h2>
          <div className="space-y-2">
            {segments.map(s => (
              <div key={s.segment} className="flex items-center justify-between p-2 rounded hover:bg-gray-50">
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SEGMENT_COLORS[s.segment] || 'bg-gray-100'}`}>
                    {(s.segment || '').replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-gray-500">{s.count} users</span>
                  <span className="text-gray-400">avg health: {s.avgHealth}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Churn Risk Alerts */}
      {churnRisk.length > 0 && (
        <div className="bg-white rounded-lg border">
          <div className="p-4 border-b bg-red-50">
            <h2 className="text-lg font-semibold text-red-800 flex items-center gap-2">
              <AlertTriangle size={20} /> Churn Risk Alerts
            </h2>
            <p className="text-sm text-red-600 mt-1">Customers with high churn probability</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">User</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Segment</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Churn Risk</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Health</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Last Order</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Orders (90d)</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">LTV</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {churnRisk.map(c => (
                  <tr key={c.id} className="hover:bg-red-50">
                    <td className="px-4 py-3">
                      <p className="font-medium">User #{c.userId}</p>
                      <p className="text-xs text-gray-400">{c.phone || 'N/A'}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SEGMENT_COLORS[c.rfmSegment || ''] || 'bg-gray-100'}`}>
                        {(c.rfmSegment || 'unknown').replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className={`px-4 py-3 text-right font-bold ${getChurnColor(c.churnRisk)}`}>
                      {((c.churnRisk ?? 0) * 100).toFixed(0)}%
                    </td>
                    <td className={`px-4 py-3 text-right font-bold ${getHealthColor(c.healthScore)}`}>
                      {c.healthScore}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">{c.recencyDays}d ago</td>
                    <td className="px-4 py-3 text-right text-gray-600">{c.frequency90d}</td>
                    <td className="px-4 py-3 text-right text-gray-600">Rs {c.ltvPredicted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Customer Table */}
      <div className="bg-white rounded-lg border">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">All Customers ({total})</h2>
          <div className="flex gap-2">
            <select
              value={filters.segment}
              onChange={e => setFilters({ ...filters, segment: e.target.value, page: 0 })}
              className="border rounded-lg px-3 py-1.5 text-sm bg-white"
            >
              <option value="">All Segments</option>
              {segments.map(s => (
                <option key={s.segment} value={s.segment}>{(s.segment || '').replace(/_/g, ' ')}</option>
              ))}
            </select>
            <select
              value={filters.sortBy}
              onChange={e => setFilters({ ...filters, sortBy: e.target.value, page: 0 })}
              className="border rounded-lg px-3 py-1.5 text-sm bg-white"
            >
              <option value="health_score">Health Score</option>
              <option value="churn_risk">Churn Risk</option>
              <option value="ltv_predicted">LTV</option>
              <option value="recency_days">Recency</option>
              <option value="frequency_90d">Frequency</option>
              <option value="avg_order_value">AOV</option>
            </select>
            <button
              onClick={() => setFilters({ ...filters, sortOrder: filters.sortOrder === 'desc' ? 'asc' : 'desc' })}
              className="border rounded-lg px-3 py-1.5 text-sm bg-white hover:bg-gray-50"
            >
              {filters.sortOrder === 'desc' ? <ArrowDownRight size={16} /> : <ArrowUpRight size={16} />}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">User</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Segment</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">RFM</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Health</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Churn Risk</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">LTV</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">AOV</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Last Order</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Freq (90d)</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {customers.map(c => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium">#{c.userId}</p>
                    <p className="text-xs text-gray-400">{c.phone || 'N/A'}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SEGMENT_COLORS[c.rfmSegment || ''] || 'bg-gray-100'}`}>
                      {(c.rfmSegment || '?').replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-500">{c.rfmScore || '-'}</td>
                  <td className={`px-4 py-3 text-right font-bold ${getHealthColor(c.healthScore)}`}>{c.healthScore}</td>
                  <td className={`px-4 py-3 text-right font-bold ${getChurnColor(c.churnRisk)}`}>{((c.churnRisk ?? 0) * 100).toFixed(0)}%</td>
                  <td className="px-4 py-3 text-right">Rs {c.ltvPredicted}</td>
                  <td className="px-4 py-3 text-right">Rs {(c.avgOrderValue ?? 0).toFixed(0)}</td>
                  <td className="px-4 py-3 text-right">{c.recencyDays}d ago</td>
                  <td className="px-4 py-3 text-right">{c.frequency90d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Pagination */}
        {total > 50 && (
          <div className="p-4 border-t flex justify-between items-center">
            <span className="text-sm text-gray-500">
              Showing {filters.page * 50 + 1}-{Math.min((filters.page + 1) * 50, total)} of {total}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setFilters({ ...filters, page: Math.max(0, filters.page - 1) })}
                disabled={filters.page === 0}
                className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setFilters({ ...filters, page: filters.page + 1 })}
                disabled={(filters.page + 1) * 50 >= total}
                className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
