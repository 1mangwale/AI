'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, AlertCircle, DollarSign, TrendingUp, Target,
  BarChart3, Megaphone, Search, ExternalLink, Sparkles,
  Youtube, Instagram, Hash, ArrowUpRight, Eye, MousePointer,
  ShoppingCart, Percent, X, Loader2, Globe, Share2,
} from 'lucide-react';
import { mangwaleAIClient } from '@/lib/api/mangwale-ai';

// ---- Types ----

interface MarketingOverview {
  totalSpend: number;
  totalRevenue: number;
  totalConversions: number;
  avgROI: number;
  activeCampaigns: number;
}

interface SocialTrend {
  id: string;
  platform: string;
  trendType: string;
  title: string;
  content: string;
  url: string;
  engagementMetrics: Record<string, number>;
  relevanceScore: number;
  tags: string[];
  detectedAt: string;
  processed: boolean;
}

interface TrendSuggestion {
  id?: string;
  title: string;
  description: string;
  platform: string;
  actionType: string;
  priority: string;
  estimatedImpact: string;
}

interface Campaign {
  id: string;
  platform: string;
  name: string;
  budget: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  status: string;
}

interface AttributionSource {
  source: string;
  medium: string;
  orders: number;
  revenue: number;
  percentage: number;
}

interface AttributionData {
  sources: AttributionSource[];
}

type Tab = 'trends' | 'campaigns' | 'attribution';

// ---- Platform Helpers ----

const PLATFORM_ICONS: Record<string, React.ReactNode> = {
  youtube: <Youtube size={14} />,
  instagram: <Instagram size={14} />,
  twitter: <Hash size={14} />,
  facebook: <Globe size={14} />,
};

const PLATFORM_COLORS: Record<string, string> = {
  youtube: 'bg-red-100 text-red-700 border-red-200',
  instagram: 'bg-pink-100 text-pink-700 border-pink-200',
  twitter: 'bg-sky-100 text-sky-700 border-sky-200',
  facebook: 'bg-blue-100 text-blue-700 border-blue-200',
  google: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  organic: 'bg-green-100 text-green-700 border-green-200',
  direct: 'bg-gray-100 text-gray-700 border-gray-200',
  referral: 'bg-purple-100 text-purple-700 border-purple-200',
  email: 'bg-orange-100 text-orange-700 border-orange-200',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  paused: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-blue-100 text-blue-700',
  draft: 'bg-gray-100 text-gray-600',
  failed: 'bg-red-100 text-red-700',
};

const PRIORITY_COLORS: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-gray-100 text-gray-600',
};

// ---- Main Page Component ----

export default function MarketingCommandPage() {
  const [activeTab, setActiveTab] = useState<Tab>('trends');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Overview
  const [overview, setOverview] = useState<MarketingOverview | null>(null);

  // Trends
  const [trends, setTrends] = useState<SocialTrend[]>([]);
  const [suggestions, setSuggestions] = useState<TrendSuggestion[]>([]);
  const [trendPlatform, setTrendPlatform] = useState('');
  const [fetchingTrends, setFetchingTrends] = useState(false);

  // Campaigns
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  // Attribution
  const [attribution, setAttribution] = useState<AttributionSource[]>([]);
  const [attrStartDate, setAttrStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [attrEndDate, setAttrEndDate] = useState(
    new Date().toISOString().split('T')[0],
  );

  useEffect(() => {
    loadOverview();
  }, []);

  useEffect(() => {
    loadTabData();
  }, [activeTab, attrStartDate, attrEndDate]);

  const loadOverview = async () => {
    try {
      const data = await mangwaleAIClient.get<MarketingOverview>(
        '/mos/marketing/overview',
      );
      setOverview(data);
    } catch (err: any) {
      console.error('Failed to load marketing overview:', err);
    }
  };

  const loadTabData = async () => {
    try {
      setLoading(true);
      setError(null);

      if (activeTab === 'trends') {
        const platformParam = trendPlatform ? `?platform=${trendPlatform}` : '';
        const [trendData, sugData] = await Promise.all([
          mangwaleAIClient.get<SocialTrend[]>(
            `/mos/marketing/trends${platformParam}`,
          ),
          mangwaleAIClient.get<TrendSuggestion[]>(
            '/mos/marketing/trends/suggestions',
          ),
        ]);
        setTrends(trendData);
        setSuggestions(sugData);
      } else if (activeTab === 'campaigns') {
        const data = await mangwaleAIClient.get<Campaign[]>(
          '/mos/marketing/campaigns',
        );
        setCampaigns(data);
      } else if (activeTab === 'attribution') {
        const data = await mangwaleAIClient.get<AttributionData>(
          `/mos/marketing/attribution?startDate=${attrStartDate}&endDate=${attrEndDate}`,
        );
        setAttribution(data.sources || []);
      }
    } catch (err: any) {
      console.error('Failed to load marketing data:', err);
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleFetchTrends = async (platform: string) => {
    setFetchingTrends(true);
    try {
      await mangwaleAIClient.post(
        `/mos/marketing/trends/fetch?platform=${platform}`,
        {},
      );
      // Reload trends after fetch
      const platformParam = trendPlatform ? `?platform=${trendPlatform}` : '';
      const data = await mangwaleAIClient.get<SocialTrend[]>(
        `/mos/marketing/trends${platformParam}`,
      );
      setTrends(data);
    } catch (err: any) {
      setError(err.message || `Failed to fetch ${platform} trends`);
    } finally {
      setFetchingTrends(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'trends', label: 'Social Trends', icon: <TrendingUp size={16} /> },
    { id: 'campaigns', label: 'Campaigns', icon: <Megaphone size={16} /> },
    { id: 'attribution', label: 'Attribution', icon: <Share2 size={16} /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#059211] to-[#047a0e] rounded-2xl p-8 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Marketing Command</h1>
            <p className="text-green-100">
              Social trends, campaign performance, and attribution analytics
            </p>
          </div>
          <button
            onClick={() => {
              loadOverview();
              loadTabData();
            }}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all disabled:opacity-50"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Overview Cards */}
      {overview && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <OverviewCard
            icon={<DollarSign size={22} />}
            label="Total Spend"
            value={formatCurrency(overview.totalSpend)}
            color="red"
          />
          <OverviewCard
            icon={<TrendingUp size={22} />}
            label="Total Revenue"
            value={formatCurrency(overview.totalRevenue)}
            color="green"
          />
          <OverviewCard
            icon={<ShoppingCart size={22} />}
            label="Conversions"
            value={String(overview.totalConversions)}
            color="blue"
          />
          <OverviewCard
            icon={<Percent size={22} />}
            label="Avg ROI"
            value={`${((overview.avgROI ?? 0) * 100).toFixed(1)}%`}
            color="purple"
          />
          <OverviewCard
            icon={<Megaphone size={22} />}
            label="Active Campaigns"
            value={String(overview.activeCampaigns)}
            color="orange"
          />
        </div>
      )}

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
          <AlertCircle className="text-red-600 flex-shrink-0" size={20} />
          <span className="text-red-800 flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-600"
          >
            <X size={16} />
          </button>
          <button
            onClick={loadTabData}
            className="px-3 py-1 bg-red-600 text-white rounded text-sm hover:bg-red-700"
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
          {activeTab === 'trends' && (
            <SocialTrendsTab
              trends={trends}
              suggestions={suggestions}
              platform={trendPlatform}
              onPlatformChange={(p) => {
                setTrendPlatform(p);
              }}
              onFetchTrends={handleFetchTrends}
              fetchingTrends={fetchingTrends}
              onReload={loadTabData}
            />
          )}
          {activeTab === 'campaigns' && (
            <CampaignsTab campaigns={campaigns} />
          )}
          {activeTab === 'attribution' && (
            <AttributionTab
              sources={attribution}
              startDate={attrStartDate}
              endDate={attrEndDate}
              onStartDateChange={setAttrStartDate}
              onEndDateChange={setAttrEndDate}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---- Social Trends Tab ----

function SocialTrendsTab({
  trends,
  suggestions,
  platform,
  onPlatformChange,
  onFetchTrends,
  fetchingTrends,
  onReload,
}: {
  trends: SocialTrend[];
  suggestions: TrendSuggestion[];
  platform: string;
  onPlatformChange: (p: string) => void;
  onFetchTrends: (platform: string) => void;
  fetchingTrends: boolean;
  onReload: () => void;
}) {
  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900">Recent Trends</h2>
          <select
            value={platform}
            onChange={(e) => {
              onPlatformChange(e.target.value);
            }}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
          >
            <option value="">All Platforms</option>
            <option value="youtube">YouTube</option>
            <option value="instagram">Instagram</option>
            <option value="twitter">Twitter</option>
            <option value="facebook">Facebook</option>
          </select>
          <button
            onClick={onReload}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-[#059211] border border-gray-300 rounded-lg hover:border-[#059211] transition-colors"
          >
            Apply Filter
          </button>
        </div>

        {/* Fetch Trends Buttons */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">Fetch Trends:</span>
          {['youtube', 'instagram'].map((p) => (
            <button
              key={p}
              onClick={() => onFetchTrends(p)}
              disabled={fetchingTrends}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] transition-colors text-sm font-medium disabled:opacity-50"
            >
              {fetchingTrends ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                PLATFORM_ICONS[p] || <Globe size={14} />
              )}
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Trend Cards */}
      {trends.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <TrendingUp className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No trends detected yet</p>
          <p className="text-sm text-gray-400 mt-1">
            Fetch trends from YouTube or Instagram to get started
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {trends.map((trend) => (
            <div
              key={trend.id}
              className="bg-white rounded-xl shadow-md border-2 border-gray-100 hover:border-gray-200 p-5 transition-all"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  {/* Platform Badge + Title */}
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${
                        PLATFORM_COLORS[trend.platform] || 'bg-gray-100 text-gray-600 border-gray-200'
                      }`}
                    >
                      {PLATFORM_ICONS[trend.platform] || <Globe size={12} />}
                      {trend.platform}
                    </span>
                    {trend.trendType && (
                      <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">
                        {trend.trendType}
                      </span>
                    )}
                    {trend.processed && (
                      <span className="px-2 py-0.5 bg-green-50 text-green-600 rounded text-xs font-medium">
                        Processed
                      </span>
                    )}
                  </div>
                  <h3 className="font-medium text-gray-900 mb-1">{trend.title}</h3>
                  <p className="text-sm text-gray-600 line-clamp-2">{trend.content}</p>

                  {/* Tags */}
                  {trend.tags && trend.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {trend.tags.map((tag, i) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 bg-blue-50 text-blue-600 rounded text-xs"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Engagement Metrics */}
                  {trend.engagementMetrics && Object.keys(trend.engagementMetrics).length > 0 && (
                    <div className="flex items-center gap-3 mt-2">
                      {Object.entries(trend.engagementMetrics).map(([key, val]) => (
                        <span
                          key={key}
                          className="inline-flex items-center gap-1 text-xs text-gray-500"
                        >
                          {key === 'views' && <Eye size={12} />}
                          {key === 'likes' && <ArrowUpRight size={12} />}
                          {key === 'clicks' && <MousePointer size={12} />}
                          {key}: {typeof val === 'number' ? val.toLocaleString() : val}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Right side: Relevance Score + Link */}
                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                  {/* Relevance Score */}
                  <div className="text-center">
                    <p className="text-xs text-gray-500 mb-1">Relevance</p>
                    <div className="w-16 h-16 relative">
                      <svg className="w-16 h-16 -rotate-90" viewBox="0 0 36 36">
                        <circle
                          cx="18"
                          cy="18"
                          r="15.5"
                          fill="none"
                          stroke="#e5e7eb"
                          strokeWidth="3"
                        />
                        <circle
                          cx="18"
                          cy="18"
                          r="15.5"
                          fill="none"
                          stroke={
                            trend.relevanceScore >= 0.7
                              ? '#059211'
                              : trend.relevanceScore >= 0.4
                                ? '#f59e0b'
                                : '#ef4444'
                          }
                          strokeWidth="3"
                          strokeDasharray={`${trend.relevanceScore * 97.4} 97.4`}
                          strokeLinecap="round"
                        />
                      </svg>
                      <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-gray-900">
                        {((trend.relevanceScore ?? 0) * 100).toFixed(0)}
                      </span>
                    </div>
                  </div>

                  {trend.url && (
                    <a
                      href={trend.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-[#059211] hover:underline"
                    >
                      <ExternalLink size={12} />
                      View
                    </a>
                  )}

                  <span className="text-xs text-gray-400">
                    {timeAgo(trend.detectedAt)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Suggestions Section */}
      {suggestions.length > 0 && (
        <div className="mt-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <Sparkles className="text-[#059211]" size={20} />
            Trend Suggestions
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {suggestions.map((sug, idx) => (
              <div
                key={sug.id || idx}
                className="bg-white rounded-xl shadow-md border-2 border-gray-100 hover:border-[#059211]/30 p-5 transition-all"
              >
                <div className="flex items-center justify-between mb-2">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${
                      PLATFORM_COLORS[sug.platform] || 'bg-gray-100 text-gray-600 border-gray-200'
                    }`}
                  >
                    {PLATFORM_ICONS[sug.platform] || <Globe size={12} />}
                    {sug.platform}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      PRIORITY_COLORS[sug.priority] || 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {sug.priority}
                  </span>
                </div>
                <h4 className="font-medium text-gray-900 mb-1">{sug.title}</h4>
                <p className="text-sm text-gray-600 line-clamp-3">{sug.description}</p>
                <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-100">
                  <span className="text-xs text-gray-500">{sug.actionType}</span>
                  <span className="text-xs text-[#059211] font-medium">
                    {sug.estimatedImpact}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Campaigns Tab ----

function CampaignsTab({ campaigns }: { campaigns: Campaign[] }) {
  const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
  const totalRevenue = campaigns.reduce((s, c) => s + c.revenue, 0);
  const totalConversions = campaigns.reduce((s, c) => s + c.conversions, 0);
  const activeCampaigns = campaigns.filter((c) => c.status === 'active').length;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <Megaphone size={16} /> Active
          </div>
          <p className="text-2xl font-bold text-green-600">{activeCampaigns}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <DollarSign size={16} /> Total Spend
          </div>
          <p className="text-2xl font-bold text-red-600">{formatCurrency(totalSpend)}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <TrendingUp size={16} /> Total Revenue
          </div>
          <p className="text-2xl font-bold text-green-600">{formatCurrency(totalRevenue)}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <ShoppingCart size={16} /> Conversions
          </div>
          <p className="text-2xl font-bold text-blue-600">{totalConversions}</p>
        </div>
      </div>

      {/* Campaigns Table */}
      {campaigns.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <Megaphone className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No campaigns found</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Platform</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Campaign</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Budget</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Spend</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Impressions</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Clicks</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Conv.</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Revenue</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">ROI</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => {
                  const roi = campaign.spend > 0
                    ? ((campaign.revenue - campaign.spend) / campaign.spend) * 100
                    : 0;
                  const ctr = campaign.impressions > 0
                    ? (campaign.clicks / campaign.impressions) * 100
                    : 0;
                  const budgetUsed = campaign.budget > 0
                    ? (campaign.spend / campaign.budget) * 100
                    : 0;

                  return (
                    <tr
                      key={campaign.id}
                      className="border-t border-gray-100 hover:bg-gray-50"
                    >
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${
                            PLATFORM_COLORS[campaign.platform] || 'bg-gray-100 text-gray-600 border-gray-200'
                          }`}
                        >
                          {PLATFORM_ICONS[campaign.platform] || <Globe size={12} />}
                          {campaign.platform}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          <p className="font-medium text-gray-900">{campaign.name}</p>
                          <div className="w-full bg-gray-200 rounded-full h-1.5 mt-1">
                            <div
                              className={`h-1.5 rounded-full ${
                                budgetUsed > 90
                                  ? 'bg-red-500'
                                  : budgetUsed > 70
                                    ? 'bg-yellow-500'
                                    : 'bg-[#059211]'
                              }`}
                              style={{ width: `${Math.min(budgetUsed, 100)}%` }}
                            />
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {(budgetUsed ?? 0).toFixed(0)}% of budget used
                          </p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        {formatCurrency(campaign.budget)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-900 font-medium">
                        {formatCurrency(campaign.spend)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        {campaign.impressions.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div>
                          <span className="text-gray-900">{campaign.clicks.toLocaleString()}</span>
                          <span className="text-xs text-gray-400 ml-1">
                            ({(ctr ?? 0).toFixed(1)}%)
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-900 font-medium">
                        {campaign.conversions}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-green-600">
                        {formatCurrency(campaign.revenue)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={`font-bold ${
                            roi >= 0 ? 'text-green-600' : 'text-red-600'
                          }`}
                        >
                          {roi >= 0 ? '+' : ''}{(roi ?? 0).toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            STATUS_COLORS[campaign.status] || 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {campaign.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Attribution Tab ----

function AttributionTab({
  sources,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
}: {
  sources: AttributionSource[];
  startDate: string;
  endDate: string;
  onStartDateChange: (d: string) => void;
  onEndDateChange: (d: string) => void;
}) {
  const totalRevenue = sources.reduce((s, src) => s + src.revenue, 0);
  const totalOrders = sources.reduce((s, src) => s + src.orders, 0);
  const maxRevenue = Math.max(...sources.map((s) => s.revenue), 1);

  return (
    <div className="space-y-6">
      {/* Date Range Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Attribution Breakdown</h2>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-500">From</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => onStartDateChange(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-500">To</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => onEndDateChange(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
            />
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <Globe size={16} /> Sources
          </div>
          <p className="text-2xl font-bold text-gray-900">{sources.length}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <ShoppingCart size={16} /> Total Orders
          </div>
          <p className="text-2xl font-bold text-blue-600">{totalOrders.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-md border-2 border-gray-100">
          <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
            <DollarSign size={16} /> Total Revenue
          </div>
          <p className="text-2xl font-bold text-green-600">{formatCurrency(totalRevenue)}</p>
        </div>
      </div>

      {sources.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <Share2 className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No attribution data for this date range</p>
        </div>
      ) : (
        <>
          {/* Horizontal Bar Chart */}
          <div className="bg-white rounded-xl p-6 shadow-md border-2 border-gray-100">
            <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
              <BarChart3 className="text-[#059211]" size={20} />
              Revenue by Source
            </h3>
            <div className="space-y-3">
              {sources.map((src) => {
                const pct = maxRevenue > 0 ? (src.revenue / maxRevenue) * 100 : 0;
                return (
                  <div key={`${src.source}-${src.medium}`} className="flex items-center gap-4">
                    <div className="w-32 flex-shrink-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{src.source}</p>
                      <p className="text-xs text-gray-400">{src.medium}</p>
                    </div>
                    <div className="flex-1 bg-gray-100 rounded-full h-8 relative overflow-hidden">
                      <div
                        className="bg-[#059211]/70 h-8 rounded-full flex items-center justify-end pr-3 transition-all"
                        style={{
                          width: `${Math.max(pct, 5)}%`,
                        }}
                      >
                        <span className="text-xs text-white font-medium whitespace-nowrap">
                          {formatCurrency(src.revenue)}
                        </span>
                      </div>
                    </div>
                    <span className="w-16 text-right text-sm font-bold text-gray-700">
                      {(src.percentage ?? 0).toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Attribution Table */}
          <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Source</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-600">Medium</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-600">Orders</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-600">Revenue</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-600">% of Total</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-600">Avg Order</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((src) => {
                    const avgOrder = src.orders > 0 ? src.revenue / src.orders : 0;
                    return (
                      <tr
                        key={`${src.source}-${src.medium}`}
                        className="border-t border-gray-100 hover:bg-gray-50"
                      >
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${
                              PLATFORM_COLORS[src.source.toLowerCase()] || 'bg-gray-100 text-gray-600 border-gray-200'
                            }`}
                          >
                            {src.source}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{src.medium}</td>
                        <td className="px-4 py-3 text-right text-gray-900 font-medium">
                          {src.orders.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-green-600">
                          {formatCurrency(src.revenue)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 bg-gray-200 rounded-full h-2">
                              <div
                                className="bg-[#059211] h-2 rounded-full"
                                style={{ width: `${Math.min(src.percentage, 100)}%` }}
                              />
                            </div>
                            <span className="text-gray-700 font-medium w-12 text-right">
                              {(src.percentage ?? 0).toFixed(1)}%
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {formatCurrency(avgOrder)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Helper Components ----

function OverviewCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: 'green' | 'blue' | 'red' | 'purple' | 'orange';
}) {
  const colors = {
    green: 'bg-green-50 text-green-700 border-green-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
    orange: 'bg-orange-50 text-orange-700 border-orange-200',
  };
  const iconBg = {
    green: 'bg-green-100 text-green-600',
    blue: 'bg-blue-100 text-blue-600',
    red: 'bg-red-100 text-red-600',
    purple: 'bg-purple-100 text-purple-600',
    orange: 'bg-orange-100 text-orange-600',
  };

  return (
    <div className={`rounded-xl p-4 border-2 shadow-md hover:shadow-lg transition-all ${colors[color]}`}>
      <div className="flex items-center gap-2 mb-2">
        <div className={`p-1.5 rounded-lg ${iconBg[color]}`}>{icon}</div>
        <span className="text-xs font-medium opacity-80">{label}</span>
      </div>
      <p className="text-xl font-bold">{value}</p>
    </div>
  );
}

// ---- Helpers ----

function formatCurrency(amount: number): string {
  if (amount >= 10000000) return `Rs ${(amount / 10000000).toFixed(1)}Cr`;
  if (amount >= 100000) return `Rs ${(amount / 100000).toFixed(1)}L`;
  if (amount >= 1000) return `Rs ${(amount / 1000).toFixed(1)}K`;
  return `Rs ${(amount ?? 0).toFixed(0)}`;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Unknown';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
