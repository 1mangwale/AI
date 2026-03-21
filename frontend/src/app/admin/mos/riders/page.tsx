'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, AlertCircle, Trophy, Shield, MapPin, Clock,
  Bike, Star, Target, Award, Flame, Users, TrendingUp,
  ChevronUp, ChevronDown, Zap,
} from 'lucide-react';
import { mangwaleAIClient } from '@/lib/api/mangwale-ai';

// ---- Interfaces ----

interface Quest {
  id: string;
  questType: string;
  title: string;
  description: string;
  targetCount: number;
  rewardAmount: number;
  zoneId: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  active: boolean;
}

interface QuestStats {
  totalActiveQuests: number;
  totalCompletions: number;
  totalRewards: number;
  avgCompletionRate: number;
}

interface QuestLeaderboardEntry {
  riderId: number;
  riderName: string;
  questsCompleted: number;
  totalReward: number;
}

interface TierDistribution {
  bronze: number;
  silver: number;
  gold: number;
  total: number;
}

interface TierLeaderboardEntry {
  riderId: number;
  tier: string;
  score: number;
  deliveries7d: number;
  avgRating7d: number;
  onTimePct7d: number;
  cancelRate7d: number;
  earnings7d: number;
}

interface ZoneDensity {
  zoneId: string;
  zoneName: string;
  orderCount: number;
  avgDeliveryTimeMins: number;
  demandLevel: string;
}

interface ZoneHotspot {
  zoneId: string;
  zoneName: string;
  orderCount: number;
  avgOrderValue: number;
}

interface ZonePositioning {
  zoneId: string;
  zoneName: string;
  activeRiders: number;
  pendingOrders: number;
  ridersNeeded: number;
}

interface SlowKitchen {
  storeId: number;
  storeName: string;
  avgPrepTime: number;
  p90PrepTime: number;
  sampleCount: number;
  rank: number;
}

interface PrepTimeStats {
  avgPrepTime: number;
  medianPrepTime: number;
  p90PrepTime: number;
  totalStores: number;
  slowKitchenCount: number;
}

type Tab = 'quests' | 'tiers' | 'zones' | 'prep-time';

// ---- Main Page ----

export default function RiderCommandCenterPage() {
  const [activeTab, setActiveTab] = useState<Tab>('quests');
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().split('T')[0],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Quests data
  const [quests, setQuests] = useState<Quest[]>([]);
  const [questStats, setQuestStats] = useState<QuestStats | null>(null);
  const [questLeaderboard, setQuestLeaderboard] = useState<QuestLeaderboardEntry[]>([]);

  // Tiers data
  const [tierDistribution, setTierDistribution] = useState<TierDistribution | null>(null);
  const [tierLeaderboard, setTierLeaderboard] = useState<TierLeaderboardEntry[]>([]);
  const [selectedTier, setSelectedTier] = useState<string>('');

  // Zones data
  const [zoneDensity, setZoneDensity] = useState<ZoneDensity[]>([]);
  const [zoneHotspots, setZoneHotspots] = useState<ZoneHotspot[]>([]);
  const [zonePositioning, setZonePositioning] = useState<ZonePositioning[]>([]);

  // Prep time data
  const [slowKitchens, setSlowKitchens] = useState<SlowKitchen[]>([]);
  const [prepTimeStats, setPrepTimeStats] = useState<PrepTimeStats | null>(null);
  const [prepThreshold, setPrepThreshold] = useState('20');

  useEffect(() => {
    loadData();
  }, [selectedDate, activeTab, selectedTier, prepThreshold]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      if (activeTab === 'quests') {
        const [questsList, stats, leaderboard] = await Promise.all([
          mangwaleAIClient.get<Quest[]>('/mos/riders/quests'),
          mangwaleAIClient.get<QuestStats>(`/mos/riders/quests/stats?date=${selectedDate}`),
          mangwaleAIClient.get<QuestLeaderboardEntry[]>(
            `/mos/riders/quests/leaderboard?date=${selectedDate}&limit=10`,
          ),
        ]);
        setQuests(questsList);
        setQuestStats(stats);
        setQuestLeaderboard(leaderboard);
      } else if (activeTab === 'tiers') {
        const tierParam = selectedTier ? `?tier=${selectedTier}&limit=20` : '?limit=20';
        const [distribution, leaderboard] = await Promise.all([
          mangwaleAIClient.get<TierDistribution>('/mos/riders/tiers/distribution'),
          mangwaleAIClient.get<TierLeaderboardEntry[]>(
            `/mos/riders/tiers/leaderboard${tierParam}`,
          ),
        ]);
        setTierDistribution(distribution);
        setTierLeaderboard(leaderboard);
      } else if (activeTab === 'zones') {
        const [density, hotspots, positioning] = await Promise.all([
          mangwaleAIClient.get<ZoneDensity[]>('/mos/riders/zones/density?hours=2'),
          mangwaleAIClient.get<ZoneHotspot[]>('/mos/riders/zones/hotspots?limit=10'),
          mangwaleAIClient.get<{ zones: ZonePositioning[] }>('/mos/riders/zones/positioning'),
        ]);
        setZoneDensity(density);
        setZoneHotspots(hotspots);
        setZonePositioning(positioning.zones);
      } else if (activeTab === 'prep-time') {
        const [kitchens, stats] = await Promise.all([
          mangwaleAIClient.get<SlowKitchen[]>(
            `/mos/riders/prep-time/slow-kitchens?threshold=${prepThreshold}`,
          ),
          mangwaleAIClient.get<PrepTimeStats>('/mos/riders/prep-time/stats'),
        ]);
        setSlowKitchens(kitchens);
        setPrepTimeStats(stats);
      }
    } catch (err: any) {
      console.error('Failed to load rider data:', err);
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'quests', label: 'Quests', icon: <Target size={16} /> },
    { id: 'tiers', label: 'Tiers', icon: <Shield size={16} /> },
    { id: 'zones', label: 'Zone Heat Map', icon: <MapPin size={16} /> },
    { id: 'prep-time', label: 'Prep Time', icon: <Clock size={16} /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#059211] to-[#047a0e] rounded-2xl p-8 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Rider Command Center</h1>
            <p className="text-green-100">
              Quest management, tier rankings, zone demand, and kitchen prep analytics
            </p>
          </div>
          <div className="flex items-center gap-3">
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
          {activeTab === 'quests' && questStats && (
            <QuestsTab
              quests={quests}
              stats={questStats}
              leaderboard={questLeaderboard}
            />
          )}
          {activeTab === 'tiers' && tierDistribution && (
            <TiersTab
              distribution={tierDistribution}
              leaderboard={tierLeaderboard}
              selectedTier={selectedTier}
              onTierChange={setSelectedTier}
            />
          )}
          {activeTab === 'zones' && (
            <ZonesTab
              density={zoneDensity}
              hotspots={zoneHotspots}
              positioning={zonePositioning}
            />
          )}
          {activeTab === 'prep-time' && prepTimeStats && (
            <PrepTimeTab
              stats={prepTimeStats}
              kitchens={slowKitchens}
              threshold={prepThreshold}
              onThresholdChange={(v) => setPrepThreshold(v)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---- Quests Tab ----

function QuestsTab({
  quests,
  stats,
  leaderboard,
}: {
  quests: Quest[];
  stats: QuestStats;
  leaderboard: QuestLeaderboardEntry[];
}) {
  const questTypeBadge = (type: string) => {
    const styles: Record<string, string> = {
      delivery: 'bg-blue-100 text-blue-700',
      streak: 'bg-purple-100 text-purple-700',
      rating: 'bg-yellow-100 text-yellow-700',
      zone: 'bg-green-100 text-green-700',
      peak_hour: 'bg-orange-100 text-orange-700',
      referral: 'bg-pink-100 text-pink-700',
    };
    return styles[type] || 'bg-gray-100 text-gray-700';
  };

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          icon={<Target size={24} />}
          label="Active Quests"
          value={String(stats.totalActiveQuests)}
          color="green"
        />
        <StatCard
          icon={<Trophy size={24} />}
          label="Completions"
          value={String(stats.totalCompletions)}
          color="blue"
        />
        <StatCard
          icon={<Award size={24} />}
          label="Total Rewards"
          value={formatCurrency(stats.totalRewards)}
          color="orange"
        />
        <StatCard
          icon={<TrendingUp size={24} />}
          label="Avg Completion Rate"
          value={`${((stats.avgCompletionRate ?? 0) * 100).toFixed(1)}%`}
          color="purple"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Quest Leaderboard */}
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
          <div className="p-4 border-b bg-gray-50">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Trophy className="text-[#059211]" size={20} />
              Quest Leaderboard
            </h3>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Rank</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Rider</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Quests</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Rewards</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                    No quest completions for this date
                  </td>
                </tr>
              ) : (
                leaderboard.map((entry, i) => (
                  <tr
                    key={entry.riderId}
                    className="border-t border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3">
                      {i < 3 ? (
                        <span
                          className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold text-white ${
                            i === 0
                              ? 'bg-yellow-500'
                              : i === 1
                                ? 'bg-gray-400'
                                : 'bg-amber-700'
                          }`}
                        >
                          {i + 1}
                        </span>
                      ) : (
                        <span className="text-gray-400 font-medium pl-2">
                          {i + 1}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {entry.riderName}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-[#059211]">
                      {entry.questsCompleted}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      Rs {entry.totalReward.toFixed(0)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Active Quests List */}
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
          <div className="p-4 border-b bg-gray-50">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Flame className="text-orange-500" size={20} />
              Active Quests ({quests.filter((q) => q.active).length})
            </h3>
          </div>
          <div className="divide-y divide-gray-100 max-h-[480px] overflow-y-auto">
            {quests.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-400">
                No quests configured
              </div>
            ) : (
              quests.map((quest) => (
                <div
                  key={quest.id}
                  className={`p-4 hover:bg-gray-50 transition-all ${
                    !quest.active ? 'opacity-50' : ''
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${questTypeBadge(quest.questType)}`}
                      >
                        {quest.questType.replace(/_/g, ' ')}
                      </span>
                      {!quest.active && (
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-600">
                          Inactive
                        </span>
                      )}
                    </div>
                    <span className="text-sm font-bold text-[#059211]">
                      Rs {quest.rewardAmount}
                    </span>
                  </div>
                  <h4 className="font-medium text-gray-900 mb-1">{quest.title}</h4>
                  <p className="text-sm text-gray-500 mb-2">{quest.description}</p>
                  <div className="flex items-center gap-3 text-xs text-gray-400">
                    <span className="flex items-center gap-1">
                      <Target size={12} />
                      Target: {quest.targetCount}
                    </span>
                    {quest.zoneId && (
                      <span className="flex items-center gap-1">
                        <MapPin size={12} />
                        Zone {quest.zoneId}
                      </span>
                    )}
                    {quest.dayOfWeek && (
                      <span>{quest.dayOfWeek}</span>
                    )}
                    {quest.startTime && quest.endTime && (
                      <span className="flex items-center gap-1">
                        <Clock size={12} />
                        {quest.startTime} - {quest.endTime}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Tiers Tab ----

function TiersTab({
  distribution,
  leaderboard,
  selectedTier,
  onTierChange,
}: {
  distribution: TierDistribution;
  leaderboard: TierLeaderboardEntry[];
  selectedTier: string;
  onTierChange: (tier: string) => void;
}) {
  const tierConfig: Record<string, { color: string; bg: string; border: string; textColor: string; icon: React.ReactNode }> = {
    bronze: {
      color: '#cd7f32',
      bg: 'bg-[#cd7f32]/10',
      border: 'border-[#cd7f32]/30',
      textColor: 'text-[#cd7f32]',
      icon: <Shield size={28} style={{ color: '#cd7f32' }} />,
    },
    silver: {
      color: '#c0c0c0',
      bg: 'bg-[#c0c0c0]/10',
      border: 'border-[#c0c0c0]/40',
      textColor: 'text-gray-500',
      icon: <Shield size={28} style={{ color: '#c0c0c0' }} />,
    },
    gold: {
      color: '#ffd700',
      bg: 'bg-[#ffd700]/10',
      border: 'border-[#ffd700]/40',
      textColor: 'text-yellow-600',
      icon: <Shield size={28} style={{ color: '#ffd700' }} />,
    },
  };

  const tierBadge = (tier: string) => {
    const styles: Record<string, string> = {
      bronze: 'bg-[#cd7f32]/20 text-[#cd7f32]',
      silver: 'bg-gray-200 text-gray-600',
      gold: 'bg-yellow-100 text-yellow-700',
    };
    return styles[tier.toLowerCase()] || 'bg-gray-100 text-gray-700';
  };

  return (
    <div className="space-y-6">
      {/* Tier Distribution Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {(['bronze', 'silver', 'gold'] as const).map((tier) => {
          const count = distribution[tier];
          const pct = distribution.total > 0
            ? ((count / distribution.total) * 100).toFixed(1)
            : '0.0';
          const config = tierConfig[tier];
          const isSelected = selectedTier === tier;

          return (
            <button
              key={tier}
              onClick={() => onTierChange(selectedTier === tier ? '' : tier)}
              className={`rounded-xl p-6 border-2 shadow-md hover:shadow-lg transition-all text-left ${config.bg} ${config.border} ${
                isSelected ? 'ring-2 ring-offset-2' : ''
              }`}
              style={isSelected ? { ['--tw-ring-color' as string]: config.color } as React.CSSProperties : undefined}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  {config.icon}
                  <span className="text-lg font-bold text-gray-900 capitalize">
                    {tier}
                  </span>
                </div>
                {isSelected && (
                  <span className="px-2 py-0.5 bg-[#059211] text-white text-xs rounded font-medium">
                    Filtered
                  </span>
                )}
              </div>
              <p className="text-3xl font-bold text-gray-900 mb-1">{count}</p>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">{pct}% of riders</span>
                <span className="text-sm font-medium text-gray-400">
                  / {distribution.total}
                </span>
              </div>
              {/* Progress bar */}
              <div className="mt-3 bg-gray-200 rounded-full h-2 overflow-hidden">
                <div
                  className="h-2 rounded-full transition-all"
                  style={{
                    width: `${parseFloat(pct)}%`,
                    backgroundColor: config.color,
                  }}
                />
              </div>
            </button>
          );
        })}
      </div>

      {/* Tier Leaderboard Table */}
      <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
        <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Users className="text-[#059211]" size={20} />
            Tier Leaderboard
            {selectedTier && (
              <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${tierBadge(selectedTier)}`}>
                {selectedTier}
              </span>
            )}
          </h3>
          {selectedTier && (
            <button
              onClick={() => onTierChange('')}
              className="text-sm text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100"
            >
              Clear filter
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">#</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Rider</th>
                <th className="px-4 py-3 text-center font-medium text-gray-600">Tier</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Score</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Deliveries (7d)</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Rating</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">On-Time %</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Cancel %</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Earnings (7d)</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                    No rider data available
                  </td>
                </tr>
              ) : (
                leaderboard.map((rider, i) => (
                  <tr
                    key={rider.riderId}
                    className="border-t border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3 text-gray-400 font-medium">{i + 1}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">
                      Rider #{rider.riderId}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${tierBadge(rider.tier)}`}
                      >
                        {rider.tier}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-gray-900">
                      {(rider.score ?? 0).toFixed(0)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {rider.deliveries7d}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="flex items-center justify-end gap-1">
                        <Star
                          size={14}
                          className={
                            rider.avgRating7d >= 4.5
                              ? 'text-yellow-500'
                              : rider.avgRating7d >= 4.0
                                ? 'text-yellow-400'
                                : 'text-gray-400'
                          }
                          fill={rider.avgRating7d >= 4.0 ? 'currentColor' : 'none'}
                        />
                        {(rider.avgRating7d ?? 0).toFixed(1)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={`font-medium ${
                          rider.onTimePct7d >= 90
                            ? 'text-green-600'
                            : rider.onTimePct7d >= 75
                              ? 'text-yellow-600'
                              : 'text-red-600'
                        }`}
                      >
                        {(rider.onTimePct7d ?? 0).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={`font-medium ${
                          rider.cancelRate7d <= 5
                            ? 'text-green-600'
                            : rider.cancelRate7d <= 10
                              ? 'text-yellow-600'
                              : 'text-red-600'
                        }`}
                      >
                        {(rider.cancelRate7d ?? 0).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      Rs {rider.earnings7d.toFixed(0)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---- Zones Tab ----

function ZonesTab({
  density,
  hotspots,
  positioning,
}: {
  density: ZoneDensity[];
  hotspots: ZoneHotspot[];
  positioning: ZonePositioning[];
}) {
  const demandColors: Record<string, { bg: string; text: string; border: string; dot: string }> = {
    low: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', dot: 'bg-green-500' },
    medium: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200', dot: 'bg-yellow-500' },
    high: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200', dot: 'bg-orange-500' },
    surge: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', dot: 'bg-red-500' },
  };

  const zonesNeedingRiders = positioning.filter((z) => z.ridersNeeded > 0);

  return (
    <div className="space-y-6">
      {/* Zone Density Cards */}
      <div>
        <h3 className="text-lg font-bold text-gray-900 mb-3 flex items-center gap-2">
          <Flame className="text-orange-500" size={20} />
          Zone Demand (Last 2 Hours)
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {density.length === 0 ? (
            <div className="col-span-full text-center text-gray-400 py-8">
              No zone data available
            </div>
          ) : (
            density.map((zone) => {
              const colors = demandColors[zone.demandLevel] || demandColors.low;
              return (
                <div
                  key={zone.zoneId}
                  className={`rounded-xl p-5 border-2 shadow-sm hover:shadow-md transition-all ${colors.bg} ${colors.border}`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-bold text-gray-900">{zone.zoneName}</h4>
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2.5 h-2.5 rounded-full ${colors.dot} animate-pulse`} />
                      <span className={`text-xs font-bold uppercase ${colors.text}`}>
                        {zone.demandLevel}
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs text-gray-500">Orders</p>
                      <p className="text-xl font-bold text-gray-900">{zone.orderCount}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Avg Delivery</p>
                      <p className={`text-xl font-bold ${
                        zone.avgDeliveryTimeMins <= 30
                          ? 'text-green-600'
                          : zone.avgDeliveryTimeMins <= 45
                            ? 'text-orange-600'
                            : 'text-red-600'
                      }`}>
                        {zone.avgDeliveryTimeMins}m
                      </p>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Demand Level Legend */}
      <div className="flex items-center gap-6 text-xs text-gray-500">
        <span className="font-medium">Demand Levels:</span>
        {Object.entries(demandColors).map(([level, colors]) => (
          <div key={level} className="flex items-center gap-1.5">
            <div className={`w-3 h-3 rounded-full ${colors.dot}`} />
            <span className="capitalize">{level}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Rider Positioning -- Zones Needing Riders */}
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
          <div className="p-4 border-b bg-gray-50">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Bike className="text-[#059211]" size={20} />
              Rider Positioning
              {zonesNeedingRiders.length > 0 && (
                <span className="px-2 py-0.5 bg-red-100 text-red-600 rounded text-xs font-medium">
                  {zonesNeedingRiders.length} zones need riders
                </span>
              )}
            </h3>
          </div>
          <div className="divide-y divide-gray-100 max-h-[400px] overflow-y-auto">
            {positioning.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-400">
                No positioning data available
              </div>
            ) : (
              positioning.map((zone) => (
                <div
                  key={zone.zoneId}
                  className={`p-4 flex items-center justify-between ${
                    zone.ridersNeeded > 0 ? 'bg-red-50/50' : ''
                  }`}
                >
                  <div>
                    <h4 className="font-medium text-gray-900">{zone.zoneName}</h4>
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <Bike size={12} />
                        {zone.activeRiders} active
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock size={12} />
                        {zone.pendingOrders} pending
                      </span>
                    </div>
                  </div>
                  {zone.ridersNeeded > 0 ? (
                    <span className="flex items-center gap-1.5 px-3 py-1.5 bg-red-100 text-red-700 rounded-lg text-sm font-bold">
                      <ChevronUp size={14} />
                      +{zone.ridersNeeded} needed
                    </span>
                  ) : (
                    <span className="px-3 py-1.5 bg-green-100 text-green-700 rounded-lg text-sm font-medium">
                      Covered
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Hotspots */}
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
          <div className="p-4 border-b bg-gray-50">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Zap className="text-yellow-500" size={20} />
              Top Hotspots
            </h3>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">#</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Zone</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Orders</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Avg Value</th>
              </tr>
            </thead>
            <tbody>
              {hotspots.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                    No hotspot data available
                  </td>
                </tr>
              ) : (
                hotspots.map((spot, i) => (
                  <tr
                    key={spot.zoneId}
                    className="border-t border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3">
                      {i < 3 ? (
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-orange-100 text-orange-700 text-xs font-bold">
                          {i + 1}
                        </span>
                      ) : (
                        <span className="text-gray-400 font-medium pl-1.5">
                          {i + 1}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {spot.zoneName}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-[#059211]">
                      {spot.orderCount}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      Rs {spot.avgOrderValue.toFixed(0)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---- Prep Time Tab ----

function PrepTimeTab({
  stats,
  kitchens,
  threshold,
  onThresholdChange,
}: {
  stats: PrepTimeStats;
  kitchens: SlowKitchen[];
  threshold: string;
  onThresholdChange: (v: string) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-4">
        <StatCard
          icon={<Clock size={24} />}
          label="Avg Prep Time"
          value={`${stats.avgPrepTime.toFixed(1)}m`}
          color="blue"
        />
        <StatCard
          icon={<Clock size={24} />}
          label="Median Prep Time"
          value={`${stats.medianPrepTime.toFixed(1)}m`}
          color="green"
        />
        <StatCard
          icon={<TrendingUp size={24} />}
          label="P90 Prep Time"
          value={`${stats.p90PrepTime.toFixed(1)}m`}
          color="orange"
        />
        <StatCard
          icon={<Users size={24} />}
          label="Total Stores"
          value={String(stats.totalStores)}
          color="purple"
        />
        <StatCard
          icon={<AlertCircle size={24} />}
          label="Slow Kitchens"
          value={String(stats.slowKitchenCount)}
          color="red"
        />
      </div>

      {/* Slow Kitchens Table */}
      <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
        <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <AlertCircle className="text-red-500" size={20} />
            Slow Kitchens
          </h3>
          <div className="flex items-center gap-3">
            <label className="text-sm text-gray-600">
              Threshold (min):
            </label>
            <input
              type="number"
              value={threshold}
              onChange={(e) => onThresholdChange(e.target.value)}
              className="w-20 px-3 py-1 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
            />
            <span className="text-sm text-gray-500">
              {kitchens.length} stores exceeding {threshold}m
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Rank</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Store</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Avg Prep Time</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">P90 Prep Time</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Samples</th>
              </tr>
            </thead>
            <tbody>
              {kitchens.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    No slow kitchens found for this threshold
                  </td>
                </tr>
              ) : (
                kitchens.map((kitchen) => (
                  <tr
                    key={kitchen.storeId}
                    className="border-t border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3">
                      {kitchen.rank <= 3 ? (
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-100 text-red-700 text-xs font-bold">
                          {kitchen.rank}
                        </span>
                      ) : (
                        <span className="text-gray-400 font-medium pl-1.5">
                          {kitchen.rank}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {kitchen.storeName}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={`font-bold ${
                          kitchen.avgPrepTime > 30
                            ? 'text-red-600'
                            : kitchen.avgPrepTime > 20
                              ? 'text-orange-600'
                              : 'text-yellow-600'
                        }`}
                      >
                        {kitchen.avgPrepTime.toFixed(1)}m
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={`font-bold ${
                          kitchen.p90PrepTime > 45
                            ? 'text-red-600'
                            : kitchen.p90PrepTime > 30
                              ? 'text-orange-600'
                              : 'text-yellow-600'
                        }`}
                      >
                        {kitchen.p90PrepTime.toFixed(1)}m
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      {kitchen.sampleCount}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---- Helper Components ----

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: 'green' | 'blue' | 'orange' | 'purple' | 'red';
}) {
  const colors = {
    green: 'bg-green-50 text-green-700 border-green-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    orange: 'bg-orange-50 text-orange-700 border-orange-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
    red: 'bg-red-50 text-red-700 border-red-200',
  };
  const iconBg = {
    green: 'bg-green-100 text-green-600',
    blue: 'bg-blue-100 text-blue-600',
    orange: 'bg-orange-100 text-orange-600',
    purple: 'bg-purple-100 text-purple-600',
    red: 'bg-red-100 text-red-600',
  };

  return (
    <div
      className={`rounded-xl p-5 border-2 shadow-md hover:shadow-lg transition-all ${colors[color]}`}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className={`p-2 rounded-lg ${iconBg[color]}`}>{icon}</div>
        <span className="text-sm font-medium opacity-80">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

function formatCurrency(amount: number): string {
  if (amount >= 100000) return `Rs ${(amount / 100000).toFixed(1)}L`;
  if (amount >= 1000) return `Rs ${(amount / 1000).toFixed(1)}K`;
  return `Rs ${amount.toFixed(0)}`;
}
