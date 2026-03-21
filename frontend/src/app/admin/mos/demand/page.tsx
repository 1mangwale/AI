'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, AlertCircle, Calendar, TrendingUp, Zap,
  Tag, BarChart3, DollarSign, Percent, Gift, Power,
  ChevronDown, ChevronUp, Plus, X, Save, Edit2,
} from 'lucide-react';
import { mangwaleAIClient } from '@/lib/api/mangwale-ai';

// ---- Interfaces ----

interface ForecastPoint {
  hour: number;
  predictedOrders: number;
  confidence: number;
  weatherMultiplier: number;
}

interface ForecastVsActual {
  hour: number;
  predicted: number;
  actual: number;
  accuracy: number;
}

interface PricingRule {
  id: string;
  ruleName: string;
  ruleType: string;
  zoneId: string;
  conditions: Record<string, any>;
  action: Record<string, any>;
  priority: number;
  active: boolean;
}

interface ActiveSurge {
  zoneId: string;
  ruleName: string;
  multiplier: number;
  conditions: Record<string, any>;
}

interface DiscountStats {
  totalIssued: number;
  totalRedeemed: number;
  totalDiscountAmount: number;
  totalRedeemedAmount: number;
  totalOrderRevenue: number;
  redemptionRate: number;
  roi: number;
  byReason: Record<string, { count: number; amount: number }>;
}

type Tab = 'forecast' | 'pricing' | 'discounts';

// ---- Main Page ----

export default function DemandPricingPage() {
  const [activeTab, setActiveTab] = useState<Tab>('forecast');
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().split('T')[0],
  );
  const [zoneId, setZoneId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Forecast data
  const [forecast, setForecast] = useState<ForecastPoint[]>([]);
  const [forecastVsActual, setForecastVsActual] = useState<ForecastVsActual[]>([]);

  // Pricing data
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([]);
  const [surges, setSurges] = useState<ActiveSurge[]>([]);

  // Discount data
  const [discountStats, setDiscountStats] = useState<DiscountStats | null>(null);

  // Rule creation modal
  const [showCreateRule, setShowCreateRule] = useState(false);
  const [editingRule, setEditingRule] = useState<PricingRule | null>(null);

  useEffect(() => {
    loadData();
  }, [selectedDate, zoneId, activeTab]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      const zoneParam = zoneId ? `&zoneId=${zoneId}` : '';

      if (activeTab === 'forecast') {
        const [fc, fva] = await Promise.all([
          mangwaleAIClient.get<ForecastPoint[]>(
            `/mos/demand/forecast?date=${selectedDate}${zoneParam}`,
          ),
          mangwaleAIClient.get<ForecastVsActual[]>(
            `/mos/demand/forecast-vs-actual?date=${selectedDate}${zoneParam}`,
          ),
        ]);
        setForecast(fc);
        setForecastVsActual(fva);
      } else if (activeTab === 'pricing') {
        const [rules, activeSurges] = await Promise.all([
          mangwaleAIClient.get<PricingRule[]>('/mos/demand/pricing-rules'),
          mangwaleAIClient.get<ActiveSurge[]>('/mos/demand/surges'),
        ]);
        setPricingRules(rules);
        setSurges(activeSurges);
      } else if (activeTab === 'discounts') {
        // Default to 30-day window
        const endDate = selectedDate;
        const start = new Date(selectedDate);
        start.setDate(start.getDate() - 30);
        const startDate = start.toISOString().split('T')[0];
        const stats = await mangwaleAIClient.get<DiscountStats>(
          `/mos/demand/discounts?startDate=${startDate}&endDate=${endDate}`,
        );
        setDiscountStats(stats);
      }
    } catch (err: any) {
      console.error('Failed to load demand data:', err);
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleRule = async (rule: PricingRule) => {
    try {
      await mangwaleAIClient.patch(`/mos/demand/pricing-rules/${rule.id}`, {
        active: !rule.active,
      });
      setPricingRules((prev) =>
        prev.map((r) =>
          r.id === rule.id ? { ...r, active: !r.active } : r,
        ),
      );
    } catch (err: any) {
      setError(err.message || 'Failed to toggle rule');
    }
  };

  const handleSaveRule = async (ruleData: Partial<PricingRule>) => {
    try {
      if (editingRule) {
        await mangwaleAIClient.patch(
          `/mos/demand/pricing-rules/${editingRule.id}`,
          ruleData,
        );
      } else {
        await mangwaleAIClient.post('/mos/demand/pricing-rules', ruleData);
      }
      setShowCreateRule(false);
      setEditingRule(null);
      loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to save rule');
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'forecast', label: 'Forecast', icon: <TrendingUp size={16} /> },
    { id: 'pricing', label: 'Pricing Rules', icon: <Tag size={16} /> },
    { id: 'discounts', label: 'Discount ROI', icon: <Gift size={16} /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#059211] to-[#047a0e] rounded-2xl p-8 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Demand & Pricing</h1>
            <p className="text-green-100">
              Demand forecasting, dynamic pricing rules, and discount analytics
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
            <div className="flex items-center gap-2 bg-white/20 rounded-lg px-3 py-2">
              <input
                type="text"
                placeholder="Zone ID"
                value={zoneId}
                onChange={(e) => setZoneId(e.target.value)}
                className="bg-transparent text-white border-none outline-none text-sm w-20 placeholder-green-200"
              />
            </div>
            <button
              onClick={loadData}
              className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all"
            >
              <RefreshCw size={20} />
              Refresh
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
            onClick={() => { setError(null); loadData(); }}
            className="ml-auto px-3 py-1 bg-red-600 text-white rounded text-sm hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center h-48">
          <RefreshCw className="animate-spin text-[#059211]" size={48} />
        </div>
      )}

      {/* Tab Content */}
      {!loading && !error && (
        <>
          {activeTab === 'forecast' && (
            <ForecastTab
              forecast={forecast}
              forecastVsActual={forecastVsActual}
            />
          )}
          {activeTab === 'pricing' && (
            <PricingTab
              rules={pricingRules}
              surges={surges}
              onToggleRule={handleToggleRule}
              onEditRule={(rule) => {
                setEditingRule(rule);
                setShowCreateRule(true);
              }}
              onCreateRule={() => {
                setEditingRule(null);
                setShowCreateRule(true);
              }}
            />
          )}
          {activeTab === 'discounts' && discountStats && (
            <DiscountTab stats={discountStats} />
          )}
        </>
      )}

      {/* Create/Edit Rule Modal */}
      {showCreateRule && (
        <RuleModal
          rule={editingRule}
          onSave={handleSaveRule}
          onClose={() => {
            setShowCreateRule(false);
            setEditingRule(null);
          }}
        />
      )}
    </div>
  );
}

// ---- Forecast Tab ----

function ForecastTab({
  forecast,
  forecastVsActual,
}: {
  forecast: ForecastPoint[];
  forecastVsActual: ForecastVsActual[];
}) {
  const maxPredicted = Math.max(
    ...forecastVsActual.map((h) => Math.max(h.predicted, h.actual)),
    1,
  );
  const avgConfidence =
    forecast.length > 0
      ? forecast.reduce((sum, f) => sum + f.confidence, 0) / forecast.length
      : 0;
  const avgAccuracy =
    forecastVsActual.length > 0
      ? forecastVsActual.reduce((sum, f) => sum + f.accuracy, 0) /
        forecastVsActual.length
      : 0;
  const totalPredicted = forecast.reduce((s, f) => s + f.predictedOrders, 0);
  const totalActual = forecastVsActual.reduce((s, f) => s + f.actual, 0);
  const weatherAffected = forecast.filter((f) => f.weatherMultiplier !== 1.0);

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SmallCard label="Total Predicted" value={String(totalPredicted)} />
        <SmallCard label="Total Actual" value={String(totalActual)} />
        <SmallCard
          label="Avg Confidence"
          value={`${((avgConfidence ?? 0) * 100).toFixed(1)}%`}
        />
        <SmallCard
          label="Avg Accuracy"
          value={`${((avgAccuracy ?? 0) * 100).toFixed(1)}%`}
        />
      </div>

      {/* Weather Alerts */}
      {weatherAffected.length > 0 && (
        <div className="bg-yellow-50 border-2 border-yellow-200 rounded-xl p-4">
          <h4 className="text-sm font-bold text-yellow-800 mb-2">
            Weather Impact Detected
          </h4>
          <div className="flex flex-wrap gap-2">
            {weatherAffected.map((f) => (
              <span
                key={f.hour}
                className="px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-xs font-medium"
              >
                {f.hour}:00 -- {(f.weatherMultiplier ?? 0).toFixed(2)}x
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Forecast vs Actual Chart */}
      <div className="bg-white rounded-xl p-6 shadow-md border-2 border-gray-100 hover:border-[#059211] transition-all">
        <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
          <BarChart3 className="text-[#059211]" size={20} />
          Forecast vs Actual (Hourly)
        </h3>

        {/* Legend */}
        <div className="flex items-center gap-6 mb-4">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded bg-[#059211]" />
            <span className="text-xs text-gray-600">Predicted</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded bg-blue-500" />
            <span className="text-xs text-gray-600">Actual</span>
          </div>
        </div>

        {/* Bar Chart */}
        <div className="flex items-end gap-1 h-52">
          {forecastVsActual.map((h) => {
            const predictedHeight =
              maxPredicted > 0
                ? (h.predicted / maxPredicted) * 100
                : 0;
            const actualHeight =
              maxPredicted > 0
                ? (h.actual / maxPredicted) * 100
                : 0;
            return (
              <div
                key={h.hour}
                className="flex-1 flex items-end gap-[1px] group relative"
              >
                {/* Predicted bar */}
                <div
                  className="flex-1 bg-[#059211]/70 hover:bg-[#059211] rounded-t transition-all cursor-pointer"
                  style={{
                    height: `${predictedHeight}%`,
                    minHeight: h.predicted > 0 ? '2px' : '0px',
                  }}
                />
                {/* Actual bar */}
                <div
                  className="flex-1 bg-blue-500/70 hover:bg-blue-600 rounded-t transition-all cursor-pointer"
                  style={{
                    height: `${actualHeight}%`,
                    minHeight: h.actual > 0 ? '2px' : '0px',
                  }}
                />
                {/* Tooltip */}
                <div className="hidden group-hover:block absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                  {h.hour}:00 -- P:{h.predicted} A:{h.actual} ({((h.accuracy ?? 0) * 100).toFixed(0)}%)
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex justify-between text-xs text-gray-400 mt-2">
          <span>12 AM</span>
          <span>6 AM</span>
          <span>12 PM</span>
          <span>6 PM</span>
          <span>11 PM</span>
        </div>
      </div>

      {/* Hourly Confidence Heatmap */}
      <div className="bg-white rounded-xl p-6 shadow-md border-2 border-gray-100">
        <h3 className="text-lg font-bold text-gray-900 mb-4">
          Hourly Forecast Confidence
        </h3>
        <div className="grid grid-cols-12 sm:grid-cols-24 gap-1">
          {forecast.map((f) => {
            const conf = f.confidence;
            const bg =
              conf >= 0.8
                ? 'bg-green-500'
                : conf >= 0.6
                  ? 'bg-yellow-400'
                  : conf >= 0.4
                    ? 'bg-orange-400'
                    : 'bg-red-400';
            return (
              <div key={f.hour} className="group relative">
                <div
                  className={`w-full aspect-square rounded cursor-pointer transition-all hover:scale-110 ${bg}`}
                  style={{ opacity: 0.4 + conf * 0.6 }}
                />
                <div className="hidden group-hover:block absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                  {f.hour}:00 -- {f.predictedOrders} orders, {((conf ?? 0) * 100).toFixed(0)}% conf
                </div>
                <p className="text-[8px] text-gray-400 text-center mt-0.5">
                  {f.hour}
                </p>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
          <span>Confidence:</span>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-red-400" />
            <span>&lt;40%</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-orange-400" />
            <span>40-60%</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-yellow-400" />
            <span>60-80%</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded bg-green-500" />
            <span>&gt;80%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Pricing Tab ----

function PricingTab({
  rules,
  surges,
  onToggleRule,
  onEditRule,
  onCreateRule,
}: {
  rules: PricingRule[];
  surges: ActiveSurge[];
  onToggleRule: (rule: PricingRule) => void;
  onEditRule: (rule: PricingRule) => void;
  onCreateRule: () => void;
}) {
  const [expandedRule, setExpandedRule] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* Active Surges */}
      {surges.length > 0 && (
        <div>
          <h3 className="text-lg font-bold text-gray-900 mb-3 flex items-center gap-2">
            <Zap className="text-orange-500" size={20} />
            Active Surges
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {surges.map((surge, idx) => (
              <div
                key={`${surge.zoneId}-${idx}`}
                className="bg-orange-50 border-2 border-orange-200 rounded-xl p-5 hover:shadow-md transition-all"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-orange-800">
                    Zone {surge.zoneId}
                  </span>
                  <span className="text-2xl font-bold text-orange-600">
                    {(surge.multiplier ?? 0).toFixed(1)}x
                  </span>
                </div>
                <p className="text-sm font-medium text-gray-900 mb-2">
                  {surge.ruleName}
                </p>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(surge.conditions).map(([key, val]) => (
                    <span
                      key={key}
                      className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded text-xs"
                    >
                      {key}: {String(val)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {surges.length === 0 && (
        <div className="bg-green-50 border-2 border-green-200 rounded-xl p-4 flex items-center gap-3">
          <Zap className="text-green-600" size={20} />
          <span className="text-green-800 font-medium">
            No active surges -- standard pricing in effect
          </span>
        </div>
      )}

      {/* Pricing Rules Table */}
      <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">
            Pricing Rules ({rules.length})
          </h3>
          <button
            onClick={onCreateRule}
            className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all"
          >
            <Plus size={16} />
            New Rule
          </button>
        </div>

        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Rule Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Type</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Zone</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Conditions</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Action</th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">Priority</th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                  No pricing rules configured
                </td>
              </tr>
            ) : (
              rules.map((rule) => (
                <tr
                  key={rule.id}
                  className="border-t border-gray-100 hover:bg-gray-50"
                >
                  <td className="px-4 py-3">
                    <button
                      onClick={() => onToggleRule(rule)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        rule.active ? 'bg-[#059211]' : 'bg-gray-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          rule.active ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {rule.ruleName}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        rule.ruleType === 'surge'
                          ? 'bg-orange-100 text-orange-700'
                          : rule.ruleType === 'discount'
                            ? 'bg-blue-100 text-blue-700'
                            : rule.ruleType === 'delivery_fee'
                              ? 'bg-purple-100 text-purple-700'
                              : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {rule.ruleType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {rule.zoneId || 'All'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {Object.entries(rule.conditions).slice(0, 3).map(([key, val]) => (
                        <span
                          key={key}
                          className="px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-xs"
                        >
                          {key}: {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                        </span>
                      ))}
                      {Object.keys(rule.conditions).length > 3 && (
                        <span className="px-1.5 py-0.5 text-gray-400 text-xs">
                          +{Object.keys(rule.conditions).length - 3} more
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {Object.entries(rule.action).map(([key, val]) => (
                        <span
                          key={key}
                          className="px-1.5 py-0.5 bg-green-50 text-green-700 rounded text-xs font-medium"
                        >
                          {key}: {String(val)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center font-mono text-gray-600">
                    {rule.priority}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => onEditRule(rule)}
                      className="p-1.5 text-gray-400 hover:text-[#059211] hover:bg-green-50 rounded transition-all"
                      title="Edit rule"
                    >
                      <Edit2 size={14} />
                    </button>
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

// ---- Discount Tab ----

function DiscountTab({ stats }: { stats: DiscountStats }) {
  const reasons = Object.entries(stats.byReason || {});
  const maxReasonCount = Math.max(...reasons.map(([, v]) => v.count), 1);

  return (
    <div className="space-y-6">
      {/* ROI Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <VitalCard
          icon={<Gift size={28} />}
          label="Total Issued"
          value={String(stats.totalIssued)}
          sub={`${formatCurrency(stats.totalDiscountAmount)} in value`}
          color="blue"
        />
        <VitalCard
          icon={<DollarSign size={28} />}
          label="Total Redeemed"
          value={String(stats.totalRedeemed)}
          sub={`${formatCurrency(stats.totalRedeemedAmount)} redeemed`}
          color="green"
        />
        <VitalCard
          icon={<Percent size={28} />}
          label="Redemption Rate"
          value={`${((stats.redemptionRate ?? 0) * 100).toFixed(1)}%`}
          sub={`${stats.totalRedeemed} of ${stats.totalIssued} used`}
          color="orange"
        />
        <VitalCard
          icon={<TrendingUp size={28} />}
          label="ROI"
          value={`${((stats.roi ?? 0) * 100).toFixed(1)}%`}
          sub={`Revenue: ${formatCurrency(stats.totalOrderRevenue)}`}
          color="purple"
        />
      </div>

      {/* Revenue Impact */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <p className="text-sm text-gray-500">Discount Spend</p>
          <p className="text-2xl font-bold text-red-600">
            {formatCurrency(stats.totalRedeemedAmount)}
          </p>
          <p className="text-xs text-gray-400 mt-1">Cost of redeemed discounts</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <p className="text-sm text-gray-500">Order Revenue</p>
          <p className="text-2xl font-bold text-green-600">
            {formatCurrency(stats.totalOrderRevenue)}
          </p>
          <p className="text-xs text-gray-400 mt-1">Revenue from discounted orders</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <p className="text-sm text-gray-500">Net Impact</p>
          <p
            className={`text-2xl font-bold ${
              stats.totalOrderRevenue - stats.totalRedeemedAmount >= 0
                ? 'text-green-600'
                : 'text-red-600'
            }`}
          >
            {formatCurrency(stats.totalOrderRevenue - stats.totalRedeemedAmount)}
          </p>
          <p className="text-xs text-gray-400 mt-1">Revenue minus discount cost</p>
        </div>
      </div>

      {/* Breakdown by Reason */}
      {reasons.length > 0 && (
        <div className="bg-white rounded-xl p-6 shadow-md border-2 border-gray-100">
          <h3 className="text-lg font-bold text-gray-900 mb-4">
            Breakdown by Reason
          </h3>
          <div className="space-y-3">
            {reasons.map(([reason, data]) => (
              <div key={reason} className="flex items-center gap-4">
                <span className="w-36 text-sm text-gray-700 font-medium truncate">
                  {reason.replace(/_/g, ' ')}
                </span>
                <div className="flex-1 bg-gray-100 rounded-full h-7 relative overflow-hidden">
                  <div
                    className="bg-[#059211]/70 h-7 rounded-full flex items-center justify-end pr-3 transition-all"
                    style={{
                      width: `${Math.max((data.count / maxReasonCount) * 100, 8)}%`,
                    }}
                  >
                    <span className="text-xs text-white font-medium">
                      {data.count}
                    </span>
                  </div>
                </div>
                <span className="w-24 text-right text-sm text-gray-600 font-medium">
                  {formatCurrency(data.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Rule Creation/Edit Modal ----

function RuleModal({
  rule,
  onSave,
  onClose,
}: {
  rule: PricingRule | null;
  onSave: (data: Partial<PricingRule>) => void;
  onClose: () => void;
}) {
  const [formData, setFormData] = useState({
    ruleName: rule?.ruleName || '',
    ruleType: rule?.ruleType || 'surge',
    zoneId: rule?.zoneId || '',
    conditions: rule ? JSON.stringify(rule.conditions, null, 2) : '{}',
    action: rule ? JSON.stringify(rule.action, null, 2) : '{}',
    priority: rule?.priority || 10,
    active: rule?.active ?? true,
  });
  const [jsonError, setJsonError] = useState<string | null>(null);

  const handleSubmit = () => {
    try {
      const conditions = JSON.parse(formData.conditions);
      const action = JSON.parse(formData.action);
      setJsonError(null);
      onSave({
        ruleName: formData.ruleName,
        ruleType: formData.ruleType,
        zoneId: formData.zoneId,
        conditions,
        action,
        priority: formData.priority,
        active: formData.active,
      });
    } catch (err) {
      setJsonError('Invalid JSON in conditions or action');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">
            {rule ? 'Edit Rule' : 'Create Rule'}
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-all"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Rule Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Rule Name
            </label>
            <input
              type="text"
              value={formData.ruleName}
              onChange={(e) =>
                setFormData({ ...formData, ruleName: e.target.value })
              }
              placeholder="e.g. Peak Hour Surge"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
            />
          </div>

          {/* Rule Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Type
            </label>
            <select
              value={formData.ruleType}
              onChange={(e) =>
                setFormData({ ...formData, ruleType: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
            >
              <option value="surge">Surge</option>
              <option value="discount">Discount</option>
              <option value="delivery_fee">Delivery Fee</option>
              <option value="commission">Commission</option>
            </select>
          </div>

          {/* Zone ID */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Zone ID (blank for all)
            </label>
            <input
              type="text"
              value={formData.zoneId}
              onChange={(e) =>
                setFormData({ ...formData, zoneId: e.target.value })
              }
              placeholder="Leave blank for all zones"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
            />
          </div>

          {/* Priority */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Priority (lower = higher priority)
            </label>
            <input
              type="number"
              value={formData.priority}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  priority: parseInt(e.target.value, 10) || 0,
                })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
            />
          </div>

          {/* Conditions JSON */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Conditions (JSON)
            </label>
            <textarea
              value={formData.conditions}
              onChange={(e) =>
                setFormData({ ...formData, conditions: e.target.value })
              }
              rows={4}
              placeholder='{"hour_range": [11, 14], "min_demand_ratio": 1.5}'
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
            />
          </div>

          {/* Action JSON */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Action (JSON)
            </label>
            <textarea
              value={formData.action}
              onChange={(e) =>
                setFormData({ ...formData, action: e.target.value })
              }
              rows={3}
              placeholder='{"multiplier": 1.5}'
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
            />
          </div>

          {/* Active Toggle */}
          <div className="flex items-center gap-3">
            <button
              onClick={() =>
                setFormData({ ...formData, active: !formData.active })
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                formData.active ? 'bg-[#059211]' : 'bg-gray-300'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  formData.active ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <span className="text-sm text-gray-700">
              {formData.active ? 'Active' : 'Inactive'}
            </span>
          </div>

          {/* JSON Error */}
          {jsonError && (
            <div className="flex items-center gap-2 text-red-600 text-sm">
              <AlertCircle size={14} />
              {jsonError}
            </div>
          )}
        </div>

        <div className="p-6 border-t flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!formData.ruleName}
            className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all disabled:opacity-50"
          >
            <Save size={16} />
            {rule ? 'Update Rule' : 'Create Rule'}
          </button>
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

function formatCurrency(amount: number): string {
  if (amount >= 100000) return `Rs ${(amount / 100000).toFixed(1)}L`;
  if (amount >= 1000) return `Rs ${(amount / 1000).toFixed(1)}K`;
  return `Rs ${(amount ?? 0).toFixed(0)}`;
}
