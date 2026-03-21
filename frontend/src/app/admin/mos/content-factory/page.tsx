'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, AlertCircle, Sparkles, FileText, DollarSign,
  Plus, X, Eye, Clock, CheckCircle, XCircle, Send,
  Calendar, Trash2, RotateCcw, Hash, Zap, Database,
  BookOpen, Filter, ChevronDown, ChevronUp, Edit3,
  Instagram, Linkedin, Megaphone, BarChart3, Target,
  Globe, Type, MessageSquare, Layers, Settings,
  TrendingUp, Award, ShoppingBag, Store, Users,
} from 'lucide-react';
import { mangwaleAIClient } from '@/lib/api/mangwale-ai';

// ---- Types ----

interface ContentStats {
  total: number;
  drafts: number;
  inReview: number;
  approved: number;
  totalCost: number;
}

interface ContentPiece {
  id: string;
  title: string;
  contentType: 'reel_script' | 'linkedin_post' | 'ad_copy' | 'carousel';
  platform: 'instagram' | 'linkedin' | 'meta_ads' | 'google_ads';
  status: 'draft' | 'review' | 'approved' | 'rejected' | 'scheduled' | 'posted';
  contentJson: any;
  rawText: string;
  cost: number;
  language: string;
  tone: string;
  reviewNotes?: string;
  scheduledAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface Hook {
  id: string;
  hookText: string;
  platform: string;
  category: string;
  freshnessScore: number;
  usageCount: number;
  isActive: boolean;
  createdAt: string;
}

interface Prompt {
  id: string;
  name: string;
  contentType: string;
  platform: string;
  version: number;
  active: boolean;
  systemPrompt: string;
  userPromptTemplate: string;
  createdAt: string;
}

interface BusinessMetrics {
  date: string;
  totalOrders: number;
  revenue: number;
  aov: number;
  newUsers: number;
  activeStores: number;
}

interface Performer {
  id: string;
  name: string;
  metric: number;
  metricLabel: string;
}

interface Milestone {
  id: string;
  text: string;
  type: string;
  date: string;
}

type Tab = 'content' | 'generate' | 'hooks' | 'business' | 'prompts' | 'analytics';

// ---- Status / Badge Helpers ----

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  review: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  scheduled: 'bg-blue-100 text-blue-700',
  posted: 'bg-purple-100 text-purple-700',
};

const TYPE_COLORS: Record<string, string> = {
  reel_script: 'bg-pink-100 text-pink-700',
  linkedin_post: 'bg-blue-100 text-blue-700',
  ad_copy: 'bg-orange-100 text-orange-700',
  carousel: 'bg-purple-100 text-purple-700',
};

const PLATFORM_COLORS: Record<string, string> = {
  instagram: 'bg-pink-100 text-pink-700',
  linkedin: 'bg-blue-100 text-blue-700',
  meta_ads: 'bg-indigo-100 text-indigo-700',
  google_ads: 'bg-red-100 text-red-700',
};

const PLATFORM_ICONS: Record<string, React.ReactNode> = {
  instagram: <Instagram size={14} />,
  linkedin: <Linkedin size={14} />,
  meta_ads: <Megaphone size={14} />,
  google_ads: <Globe size={14} />,
};

// ---- Main Page ----

export default function ContentFactoryPage() {
  const [activeTab, setActiveTab] = useState<Tab>('content');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Content tab data
  const [contentStats, setContentStats] = useState<ContentStats | null>(null);
  const [contentList, setContentList] = useState<ContentPiece[]>([]);

  // Filters
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [filterPlatform, setFilterPlatform] = useState('all');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      if (activeTab === 'content') {
        const params = new URLSearchParams();
        if (filterStatus !== 'all') params.append('status', filterStatus);
        if (filterType !== 'all') params.append('contentType', filterType);
        if (filterPlatform !== 'all') params.append('platform', filterPlatform);
        params.append('limit', '20');

        const [rawStats, list] = await Promise.all([
          mangwaleAIClient.get<any>('/mos/content-factory/stats'),
          mangwaleAIClient.get<any>(`/mos/content-factory/content?${params.toString()}`),
        ]);

        // Fix 2: Transform backend stats shape { byStatus: [{status, count}...] } to frontend shape
        const byStatus = rawStats?.byStatus || [];
        const findCount = (s: string) => byStatus.find((x: any) => x.status === s)?.count || 0;
        setContentStats({
          total: rawStats?.total || 0,
          drafts: findCount('draft'),
          inReview: findCount('review'),
          approved: findCount('approved'),
          totalCost: rawStats?.totalCostInr || rawStats?.totalCost || 0,
        });

        // Fix 1: Backend returns { items: ContentPiece[], total } not a flat array
        setContentList(Array.isArray(list) ? list : (list?.items || []));
      }
    } catch (err: any) {
      console.error('Failed to load content factory data:', err);
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [activeTab, filterStatus, filterType, filterPlatform]);

  useEffect(() => {
    if (activeTab === 'content') {
      loadData();
    } else {
      setLoading(false);
    }
  }, [activeTab, loadData]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'content', label: 'Content', icon: <FileText size={16} /> },
    { id: 'generate', label: 'Generate', icon: <Sparkles size={16} /> },
    { id: 'hooks', label: 'Hooks', icon: <Zap size={16} /> },
    { id: 'business', label: 'Business Data', icon: <Database size={16} /> },
    { id: 'prompts', label: 'Prompts', icon: <BookOpen size={16} /> },
    { id: 'analytics', label: 'Analytics', icon: <BarChart3 size={16} /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#059211] to-[#047a0e] rounded-2xl p-8 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2 flex items-center gap-3">
              <Sparkles size={32} />
              Content Factory
            </h1>
            <p className="text-green-100">
              AI-powered content generation for Instagram, LinkedIn & Ads
            </p>
          </div>
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all disabled:opacity-50"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
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
          <AlertCircle className="text-red-600 flex-shrink-0" size={20} />
          <span className="text-red-800 flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-600"
          >
            <X size={16} />
          </button>
          <button
            onClick={() => { setError(null); loadData(); }}
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
          {activeTab === 'content' && (
            <ContentTab
              stats={contentStats}
              contentList={contentList}
              filterStatus={filterStatus}
              filterType={filterType}
              filterPlatform={filterPlatform}
              onFilterStatus={setFilterStatus}
              onFilterType={setFilterType}
              onFilterPlatform={setFilterPlatform}
              onReload={loadData}
              onError={setError}
            />
          )}
          {activeTab === 'generate' && (
            <GenerateTab onReload={loadData} onError={setError} onSwitchTab={() => setActiveTab('content')} />
          )}
          {activeTab === 'hooks' && (
            <HooksTab onError={setError} />
          )}
          {activeTab === 'business' && (
            <BusinessDataTab onError={setError} />
          )}
          {activeTab === 'prompts' && (
            <PromptsTab onError={setError} />
          )}
          {activeTab === 'analytics' && (
            <AnalyticsTab onError={setError} />
          )}
        </>
      )}
    </div>
  );
}

// ---- Content Tab ----

function ContentTab({
  stats,
  contentList,
  filterStatus,
  filterType,
  filterPlatform,
  onFilterStatus,
  onFilterType,
  onFilterPlatform,
  onReload,
  onError,
}: {
  stats: ContentStats | null;
  contentList: ContentPiece[];
  filterStatus: string;
  filterType: string;
  filterPlatform: string;
  onFilterStatus: (v: string) => void;
  onFilterType: (v: string) => void;
  onFilterPlatform: (v: string) => void;
  onReload: () => void;
  onError: (msg: string) => void;
}) {
  const [selectedItem, setSelectedItem] = useState<ContentPiece | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectNotes, setRejectNotes] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [showScheduleInput, setShowScheduleInput] = useState(false);

  const handleStatusChange = async (id: string, status: string, notes?: string) => {
    setActionLoading(true);
    try {
      await mangwaleAIClient.patch(`/mos/content-factory/content/${id}/status`, {
        status,
        reviewNotes: notes || undefined,
      });
      setSelectedItem(null);
      setShowRejectInput(false);
      setRejectNotes('');
      setShowScheduleInput(false);
      setScheduleDate('');
      onReload();
    } catch (err: any) {
      onError(err.message || `Failed to update status to ${status}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRegenerate = async (id: string) => {
    setActionLoading(true);
    try {
      await mangwaleAIClient.post(`/mos/content-factory/content/${id}/regenerate`, {
        additionalInstructions: '',
      });
      setSelectedItem(null);
      onReload();
    } catch (err: any) {
      onError(err.message || 'Failed to regenerate content');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this content piece?')) return;
    setActionLoading(true);
    try {
      await mangwaleAIClient.delete(`/mos/content-factory/content/${id}`);
      setSelectedItem(null);
      onReload();
    } catch (err: any) {
      onError(err.message || 'Failed to delete content');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Filter Bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Filter size={16} className="text-gray-500" />
          <span className="text-sm font-medium text-gray-600">Filters:</span>
        </div>
        <select
          value={filterStatus}
          onChange={(e) => onFilterStatus(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
        >
          <option value="all">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="review">In Review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="scheduled">Scheduled</option>
          <option value="posted">Posted</option>
        </select>
        <select
          value={filterType}
          onChange={(e) => onFilterType(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
        >
          <option value="all">All Types</option>
          <option value="reel_script">Reel Script</option>
          <option value="linkedin_post">LinkedIn Post</option>
          <option value="ad_copy">Ad Copy</option>
          <option value="carousel">Carousel</option>
        </select>
        <select
          value={filterPlatform}
          onChange={(e) => onFilterPlatform(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
        >
          <option value="all">All Platforms</option>
          <option value="instagram">Instagram</option>
          <option value="linkedin">LinkedIn</option>
          <option value="meta_ads">Meta Ads</option>
          <option value="google_ads">Google Ads</option>
        </select>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <StatCard
            icon={<Layers size={22} />}
            label="Total"
            value={stats.total.toLocaleString('en-IN')}
            color="green"
          />
          <StatCard
            icon={<Edit3 size={22} />}
            label="Drafts"
            value={stats.drafts.toLocaleString('en-IN')}
            color="blue"
          />
          <StatCard
            icon={<Eye size={22} />}
            label="In Review"
            value={stats.inReview.toLocaleString('en-IN')}
            color="orange"
          />
          <StatCard
            icon={<CheckCircle size={22} />}
            label="Approved"
            value={stats.approved.toLocaleString('en-IN')}
            color="green"
          />
          <StatCard
            icon={<DollarSign size={22} />}
            label="Total Cost"
            value={formatCurrency(stats.totalCost)}
            color="purple"
          />
        </div>
      )}

      {/* Content Table */}
      {contentList.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <FileText className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No content pieces found</p>
          <p className="text-sm text-gray-400 mt-1">
            Generate content using the Generate tab
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
          <div className="p-4 border-b">
            <h3 className="text-lg font-bold text-gray-900">
              Content ({contentList.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Title</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Type</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Platform</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Cost</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Created</th>
                </tr>
              </thead>
              <tbody>
                {contentList.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => setSelectedItem(selectedItem?.id === item.id ? null : item)}
                    className={`border-t border-gray-100 hover:bg-gray-50 cursor-pointer transition-all ${
                      selectedItem?.id === item.id ? 'bg-green-50' : ''
                    }`}
                  >
                    <td className="px-4 py-3 max-w-xs">
                      <span className="text-gray-900 font-medium truncate block" title={item.title}>
                        {truncateText(item.title, 45)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[item.contentType] || 'bg-gray-100 text-gray-600'}`}>
                        {(item.contentType || '').replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${PLATFORM_COLORS[item.platform] || 'bg-gray-100 text-gray-600'}`}>
                        {PLATFORM_ICONS[item.platform]}
                        {(item.platform || '').replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[item.status] || 'bg-gray-100 text-gray-600'}`}>
                        {item.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700 font-medium">
                      {formatCurrency(item.cost)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500 text-xs">
                      {timeAgo(item.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detail View */}
      {selectedItem && (
        <div className="bg-white rounded-xl shadow-md border-2 border-[#059211]/30 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Eye className="text-[#059211]" size={20} />
              {selectedItem.title}
            </h3>
            <button
              onClick={() => { setSelectedItem(null); setShowRejectInput(false); setShowScheduleInput(false); }}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-all"
            >
              <X size={20} />
            </button>
          </div>

          {/* Meta info */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[selectedItem.contentType] || 'bg-gray-100 text-gray-600'}`}>
              {(selectedItem.contentType || '').replace(/_/g, ' ')}
            </span>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${PLATFORM_COLORS[selectedItem.platform] || 'bg-gray-100 text-gray-600'}`}>
              {PLATFORM_ICONS[selectedItem.platform]}
              {(selectedItem.platform || '').replace(/_/g, ' ')}
            </span>
            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[selectedItem.status] || 'bg-gray-100 text-gray-600'}`}>
              {selectedItem.status}
            </span>
            <span className="text-xs text-gray-500">
              Language: {selectedItem.language || 'English'}
            </span>
            <span className="text-xs text-gray-500">
              Tone: {selectedItem.tone || 'engaging'}
            </span>
            <span className="text-xs text-gray-500">
              Cost: {formatCurrency(selectedItem.cost)}
            </span>
          </div>

          {/* Review notes if rejected */}
          {selectedItem.status === 'rejected' && selectedItem.reviewNotes && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <p className="text-sm text-red-700">
                <span className="font-medium">Rejection notes:</span> {selectedItem.reviewNotes}
              </p>
            </div>
          )}

          {/* Rendered content */}
          <div className="mb-6">
            <ContentRenderer content={selectedItem.contentJson} contentType={selectedItem.contentType} />
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-3 flex-wrap border-t pt-4">
            {selectedItem.status === 'draft' && (
              <>
                <button
                  onClick={() => handleStatusChange(selectedItem.id, 'review')}
                  disabled={actionLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 text-sm font-medium transition-all disabled:opacity-50"
                >
                  {actionLoading ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />}
                  Submit for Review
                </button>
                <button
                  onClick={() => handleRegenerate(selectedItem.id)}
                  disabled={actionLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-sm font-medium transition-all disabled:opacity-50"
                >
                  <RotateCcw size={16} />
                  Regenerate
                </button>
                <button
                  onClick={() => handleDelete(selectedItem.id)}
                  disabled={actionLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 text-sm font-medium transition-all disabled:opacity-50"
                >
                  <Trash2 size={16} />
                  Delete
                </button>
              </>
            )}

            {selectedItem.status === 'review' && (
              <>
                <button
                  onClick={() => handleStatusChange(selectedItem.id, 'approved')}
                  disabled={actionLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium transition-all disabled:opacity-50"
                >
                  {actionLoading ? <RefreshCw size={16} className="animate-spin" /> : <CheckCircle size={16} />}
                  Approve
                </button>
                {!showRejectInput ? (
                  <button
                    onClick={() => setShowRejectInput(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 text-sm font-medium transition-all"
                  >
                    <XCircle size={16} />
                    Reject
                  </button>
                ) : (
                  <div className="flex items-center gap-2 flex-1">
                    <input
                      type="text"
                      value={rejectNotes}
                      onChange={(e) => setRejectNotes(e.target.value)}
                      placeholder="Rejection reason..."
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                    />
                    <button
                      onClick={() => handleStatusChange(selectedItem.id, 'rejected', rejectNotes)}
                      disabled={actionLoading || !rejectNotes.trim()}
                      className="flex items-center gap-2 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 text-sm font-medium transition-all disabled:opacity-50"
                    >
                      <XCircle size={16} />
                      Confirm Reject
                    </button>
                    <button
                      onClick={() => { setShowRejectInput(false); setRejectNotes(''); }}
                      className="px-3 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </>
            )}

            {selectedItem.status === 'approved' && (
              <>
                {!showScheduleInput ? (
                  <button
                    onClick={() => setShowScheduleInput(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-sm font-medium transition-all"
                  >
                    <Calendar size={16} />
                    Schedule
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="datetime-local"
                      value={scheduleDate}
                      onChange={(e) => setScheduleDate(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <button
                      onClick={() => handleStatusChange(selectedItem.id, 'scheduled')}
                      disabled={actionLoading || !scheduleDate}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-sm font-medium transition-all disabled:opacity-50"
                    >
                      <Calendar size={16} />
                      Confirm Schedule
                    </button>
                    <button
                      onClick={() => { setShowScheduleInput(false); setScheduleDate(''); }}
                      className="px-3 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </>
            )}

            {selectedItem.status === 'rejected' && (
              <>
                <button
                  onClick={() => handleRegenerate(selectedItem.id)}
                  disabled={actionLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-sm font-medium transition-all disabled:opacity-50"
                >
                  {actionLoading ? <RefreshCw size={16} className="animate-spin" /> : <RotateCcw size={16} />}
                  Regenerate
                </button>
                <button
                  onClick={() => handleDelete(selectedItem.id)}
                  disabled={actionLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 text-sm font-medium transition-all disabled:opacity-50"
                >
                  <Trash2 size={16} />
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Content Renderer ----

function ContentRenderer({ content, contentType }: { content: any; contentType: string }) {
  if (!content) {
    return (
      <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-500 italic">
        No content data available
      </div>
    );
  }

  if (contentType === 'reel_script') {
    return <ReelScriptRenderer content={content} />;
  }
  if (contentType === 'linkedin_post') {
    return <LinkedInPostRenderer content={content} />;
  }
  if (contentType === 'ad_copy') {
    return <AdCopyRenderer content={content} />;
  }
  if (contentType === 'carousel') {
    return <CarouselRenderer content={content} />;
  }

  // Fallback: render JSON
  return (
    <pre className="bg-gray-50 rounded-lg p-4 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap font-mono">
      {JSON.stringify(content, null, 2)}
    </pre>
  );
}

function ReelScriptRenderer({ content }: { content: any }) {
  return (
    <div className="space-y-4">
      {/* Hook Line */}
      {content.hook_line && (
        <div className="bg-pink-50 border border-pink-200 rounded-lg p-4">
          <p className="text-xs font-medium text-pink-600 mb-1 uppercase tracking-wide">Hook Line</p>
          <p className="text-lg font-bold text-gray-900">{content.hook_line}</p>
        </div>
      )}

      {/* Scenes */}
      {content.scenes && Array.isArray(content.scenes) && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-gray-700">Scenes</p>
          {content.scenes.map((scene: any, idx: number) => (
            <div key={idx} className="bg-gray-50 border border-gray-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[#059211] text-white text-xs font-bold">
                  {idx + 1}
                </span>
                {scene.duration && (
                  <span className="text-xs text-gray-500 flex items-center gap-1">
                    <Clock size={12} />
                    {scene.duration}
                  </span>
                )}
              </div>
              {scene.visual && (
                <div className="mb-2">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Visual</p>
                  <p className="text-sm text-gray-800">{scene.visual}</p>
                </div>
              )}
              {scene.voiceover && (
                <div className="mb-2">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Voiceover</p>
                  <p className="text-sm text-gray-800 italic">&ldquo;{scene.voiceover}&rdquo;</p>
                </div>
              )}
              {scene.overlay && (
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Text Overlay</p>
                  <p className="text-sm text-gray-800 font-medium">{scene.overlay}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Caption */}
      {content.caption && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Caption</p>
          <p className="text-sm text-gray-800 whitespace-pre-wrap">{content.caption}</p>
        </div>
      )}

      {/* Hashtags */}
      {content.hashtags && (
        <div className="flex items-center gap-2 flex-wrap">
          <Hash size={14} className="text-gray-400" />
          {(Array.isArray(content.hashtags) ? content.hashtags : content.hashtags.split(/\s+/)).map((tag: string, idx: number) => (
            <span key={idx} className="inline-flex px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs font-medium">
              {tag.startsWith('#') ? tag : `#${tag}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkedInPostRenderer({ content }: { content: any }) {
  return (
    <div className="space-y-4">
      {/* Headline */}
      {content.headline && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-lg font-bold text-gray-900">{content.headline}</p>
        </div>
      )}

      {/* Body */}
      {content.body && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{content.body}</p>
        </div>
      )}

      {/* CTA */}
      {content.cta && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <p className="text-xs font-medium text-green-600 mb-1 uppercase tracking-wide">Call to Action</p>
          <p className="text-sm font-medium text-gray-900">{content.cta}</p>
        </div>
      )}

      {/* Hashtags */}
      {content.hashtags && (
        <div className="flex items-center gap-2 flex-wrap">
          <Hash size={14} className="text-gray-400" />
          {(Array.isArray(content.hashtags) ? content.hashtags : content.hashtags.split(/\s+/)).map((tag: string, idx: number) => (
            <span key={idx} className="inline-flex px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs font-medium">
              {tag.startsWith('#') ? tag : `#${tag}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function AdCopyRenderer({ content }: { content: any }) {
  const variations = content.variations || (Array.isArray(content) ? content : [content]);

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-gray-700">Ad Variations ({variations.length})</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {variations.map((variation: any, idx: number) => (
          <div key={idx} className="bg-orange-50 border border-orange-200 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-orange-500 text-white text-xs font-bold">
                {idx + 1}
              </span>
              <span className="text-xs text-orange-600 font-medium">Variation {idx + 1}</span>
            </div>
            {variation.headline && (
              <div className="mb-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Headline</p>
                <p className="text-sm font-bold text-gray-900">{variation.headline}</p>
              </div>
            )}
            {variation.primary_text && (
              <div className="mb-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Primary Text</p>
                <p className="text-sm text-gray-800">{variation.primary_text}</p>
              </div>
            )}
            {variation.description && (
              <div className="mb-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Description</p>
                <p className="text-sm text-gray-700">{variation.description}</p>
              </div>
            )}
            {variation.cta && (
              <div className="mt-3 pt-2 border-t border-orange-200">
                <span className="inline-flex px-3 py-1 bg-orange-500 text-white rounded-lg text-xs font-medium">
                  {variation.cta}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CarouselRenderer({ content }: { content: any }) {
  const slides = content.slides || (Array.isArray(content) ? content : []);

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-gray-700">Carousel Slides ({slides.length})</p>
      <div className="space-y-3">
        {slides.map((slide: any, idx: number) => (
          <div key={idx} className="bg-purple-50 border border-purple-200 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-purple-500 text-white text-xs font-bold">
                {idx + 1}
              </span>
              <span className="text-xs text-purple-600 font-medium">Slide {idx + 1}</span>
            </div>
            {slide.headline && (
              <div className="mb-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Headline</p>
                <p className="text-sm font-bold text-gray-900">{slide.headline}</p>
              </div>
            )}
            {slide.body && (
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Body</p>
                <p className="text-sm text-gray-800 whitespace-pre-wrap">{slide.body}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Generate Tab ----

function GenerateTab({
  onReload,
  onError,
  onSwitchTab,
}: {
  onReload: () => void;
  onError: (msg: string) => void;
  onSwitchTab: () => void;
}) {
  const [contentType, setContentType] = useState('reel_script');
  const [platform, setPlatform] = useState('instagram');
  const [tone, setTone] = useState('engaging');
  const [language, setLanguage] = useState('English');
  const [hookId, setHookId] = useState('auto');
  const [additionalInstructions, setAdditionalInstructions] = useState('');
  const [autoBusinessData, setAutoBusinessData] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<ContentPiece | null>(null);

  const [hooks, setHooks] = useState<Hook[]>([]);
  const [hooksLoading, setHooksLoading] = useState(true);

  useEffect(() => {
    loadHooks();
  }, []);

  // Auto-select platform based on content type
  useEffect(() => {
    const typeDefaults: Record<string, string> = {
      reel_script: 'instagram',
      linkedin_post: 'linkedin',
      ad_copy: 'meta_ads',
      carousel: 'instagram',
    };
    if (typeDefaults[contentType]) {
      setPlatform(typeDefaults[contentType]);
    }
  }, [contentType]);

  const loadHooks = async () => {
    setHooksLoading(true);
    try {
      const result = await mangwaleAIClient.get<Hook[]>('/mos/content-factory/hooks');
      setHooks(Array.isArray(result) ? result.filter((h) => h.isActive) : []);
    } catch (err: any) {
      console.error('Failed to load hooks:', err);
    } finally {
      setHooksLoading(false);
    }
  };

  const handleGenerate = async () => {
    setSubmitting(true);
    setGeneratedContent(null);
    try {
      const result = await mangwaleAIClient.post<ContentPiece>('/mos/content-factory/generate', {
        contentType,
        platform,
        tone,
        language,
        hookId: hookId === 'auto' ? 'auto' : hookId === 'none' ? null : hookId,
        additionalInstructions: additionalInstructions.trim() || undefined,
        autoFetchBusinessData: autoBusinessData,
      });
      setGeneratedContent(result);
      onReload();
    } catch (err: any) {
      onError(err.message || 'Failed to generate content');
    } finally {
      setSubmitting(false);
    }
  };

  const handleApproveGenerated = async () => {
    if (!generatedContent) return;
    try {
      await mangwaleAIClient.patch(`/mos/content-factory/content/${generatedContent.id}/status`, {
        status: 'review',
      });
      setGeneratedContent(null);
      onSwitchTab();
    } catch (err: any) {
      onError(err.message || 'Failed to submit for review');
    }
  };

  return (
    <div className="space-y-6">
      {/* Generate Form */}
      <div className="bg-white rounded-xl shadow-md border-2 border-[#059211]/30 p-6">
        <div className="flex items-center gap-2 mb-6">
          <Sparkles className="text-[#059211]" size={20} />
          <h3 className="text-lg font-bold text-gray-900">Generate New Content</h3>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Content Type</label>
              <select
                value={contentType}
                onChange={(e) => setContentType(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
              >
                <option value="reel_script">Reel Script</option>
                <option value="linkedin_post">LinkedIn Post</option>
                <option value="ad_copy">Ad Copy</option>
                <option value="carousel">Carousel</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Platform</label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
              >
                <option value="instagram">Instagram</option>
                <option value="linkedin">LinkedIn</option>
                <option value="meta_ads">Meta Ads</option>
                <option value="google_ads">Google Ads</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tone</label>
              <input
                type="text"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                placeholder="e.g. engaging, witty, professional"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Language</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
              >
                <option value="English">English</option>
                <option value="Hindi">Hindi</option>
                <option value="Marathi">Marathi</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Hook</label>
            <select
              value={hookId}
              onChange={(e) => setHookId(e.target.value)}
              disabled={hooksLoading}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent disabled:opacity-50"
            >
              <option value="auto">Auto-suggest</option>
              <option value="none">None</option>
              {hooks.map((hook) => (
                <option key={hook.id} value={hook.id}>
                  {truncateText(hook.hookText, 80)} ({hook.platform} / {hook.category})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Additional Instructions</label>
            <textarea
              value={additionalInstructions}
              onChange={(e) => setAdditionalInstructions(e.target.value)}
              rows={3}
              placeholder="Any specific instructions for the AI content generator..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="auto-business"
              checked={autoBusinessData}
              onChange={(e) => setAutoBusinessData(e.target.checked)}
              className="w-4 h-4 text-[#059211] border-gray-300 rounded focus:ring-[#059211]"
            />
            <label htmlFor="auto-business" className="text-sm text-gray-700">
              Auto-include business data (orders, revenue, top products)
            </label>
          </div>

          <button
            onClick={handleGenerate}
            disabled={submitting}
            className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all disabled:opacity-50"
          >
            {submitting ? <RefreshCw size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {submitting ? 'Generating...' : 'Generate Content'}
          </button>
        </div>
      </div>

      {/* Generated Content Preview */}
      {generatedContent && (
        <div className="bg-white rounded-xl shadow-md border-2 border-green-300 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <CheckCircle className="text-green-600" size={20} />
              Generated: {generatedContent.title}
            </h3>
            <button
              onClick={() => setGeneratedContent(null)}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-all"
            >
              <X size={20} />
            </button>
          </div>

          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[generatedContent.contentType] || 'bg-gray-100 text-gray-600'}`}>
              {(generatedContent.contentType || '').replace(/_/g, ' ')}
            </span>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${PLATFORM_COLORS[generatedContent.platform] || 'bg-gray-100 text-gray-600'}`}>
              {PLATFORM_ICONS[generatedContent.platform]}
              {(generatedContent.platform || '').replace(/_/g, ' ')}
            </span>
            <span className="text-xs text-gray-500">Cost: {formatCurrency(generatedContent.cost)}</span>
          </div>

          <div className="mb-6">
            <ContentRenderer content={generatedContent.contentJson} contentType={generatedContent.contentType} />
          </div>

          <div className="flex items-center gap-3 border-t pt-4">
            <button
              onClick={handleApproveGenerated}
              className="flex items-center gap-2 px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 text-sm font-medium transition-all"
            >
              <Send size={16} />
              Submit for Review
            </button>
            <button
              onClick={handleGenerate}
              disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-sm font-medium transition-all disabled:opacity-50"
            >
              <RotateCcw size={16} />
              Regenerate
            </button>
            <button
              onClick={() => onSwitchTab()}
              className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium transition-all"
            >
              <Eye size={16} />
              View in Content Tab
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Hooks Tab ----

function HooksTab({ onError }: { onError: (msg: string) => void }) {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingHook, setEditingHook] = useState<Hook | null>(null);

  // Form
  const [hookText, setHookText] = useState('');
  const [hookPlatform, setHookPlatform] = useState('instagram');
  const [hookCategory, setHookCategory] = useState('engagement');

  useEffect(() => {
    loadHooks();
  }, []);

  const loadHooks = async () => {
    setLoading(true);
    try {
      const result = await mangwaleAIClient.get<Hook[]>('/mos/content-factory/hooks');
      setHooks(Array.isArray(result) ? result : []);
    } catch (err: any) {
      onError(err.message || 'Failed to load hooks');
    } finally {
      setLoading(false);
    }
  };

  const handleAddHook = async () => {
    if (!hookText.trim()) return;
    setSubmitting(true);
    try {
      await mangwaleAIClient.post('/mos/content-factory/hooks', {
        hookText: hookText.trim(),
        platform: hookPlatform,
        category: hookCategory,
      });
      setShowAddForm(false);
      setHookText('');
      loadHooks();
    } catch (err: any) {
      onError(err.message || 'Failed to add hook');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateHook = async () => {
    if (!editingHook || !hookText.trim()) return;
    setSubmitting(true);
    try {
      await mangwaleAIClient.patch(`/mos/content-factory/hooks/${editingHook.id}`, {
        hookText: hookText.trim(),
        platform: hookPlatform,
        category: hookCategory,
      });
      setEditingHook(null);
      setHookText('');
      loadHooks();
    } catch (err: any) {
      onError(err.message || 'Failed to update hook');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleActive = async (hook: Hook) => {
    try {
      await mangwaleAIClient.patch(`/mos/content-factory/hooks/${hook.id}`, {
        isActive: !hook.isActive,
      });
      loadHooks();
    } catch (err: any) {
      onError(err.message || 'Failed to toggle hook');
    }
  };

  const startEdit = (hook: Hook) => {
    setEditingHook(hook);
    setHookText(hook.hookText);
    setHookPlatform(hook.platform);
    setHookCategory(hook.category);
    setShowAddForm(true);
  };

  const cancelForm = () => {
    setShowAddForm(false);
    setEditingHook(null);
    setHookText('');
    setHookPlatform('instagram');
    setHookCategory('engagement');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <RefreshCw className="animate-spin text-[#059211]" size={48} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Add Hook Button */}
      <div>
        <button
          onClick={() => { setShowAddForm(!showAddForm); setEditingHook(null); setHookText(''); }}
          className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all"
        >
          <Plus size={16} />
          Add Hook
        </button>
      </div>

      {/* Add/Edit Hook Form */}
      {showAddForm && (
        <div className="bg-white rounded-xl shadow-md border-2 border-[#059211]/30 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Zap className="text-[#059211]" size={20} />
              {editingHook ? 'Edit Hook' : 'Add New Hook'}
            </h3>
            <button onClick={cancelForm} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-all">
              <X size={20} />
            </button>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Hook Text</label>
              <textarea
                value={hookText}
                onChange={(e) => setHookText(e.target.value)}
                rows={2}
                placeholder="e.g. Stop scrolling! This will change how you order food..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Platform</label>
                <select
                  value={hookPlatform}
                  onChange={(e) => setHookPlatform(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                >
                  <option value="instagram">Instagram</option>
                  <option value="linkedin">LinkedIn</option>
                  <option value="meta_ads">Meta Ads</option>
                  <option value="google_ads">Google Ads</option>
                  <option value="all">All Platforms</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select
                  value={hookCategory}
                  onChange={(e) => setHookCategory(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                >
                  <option value="engagement">Engagement</option>
                  <option value="curiosity">Curiosity</option>
                  <option value="urgency">Urgency</option>
                  <option value="social_proof">Social Proof</option>
                  <option value="question">Question</option>
                  <option value="statistic">Statistic</option>
                  <option value="story">Story</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={editingHook ? handleUpdateHook : handleAddHook}
                disabled={submitting || !hookText.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all disabled:opacity-50"
              >
                {submitting ? <RefreshCw size={16} className="animate-spin" /> : <Plus size={16} />}
                {submitting ? 'Saving...' : editingHook ? 'Update Hook' : 'Add Hook'}
              </button>
              <button
                onClick={cancelForm}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hooks Table */}
      {hooks.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <Zap className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No hooks created yet</p>
          <p className="text-sm text-gray-400 mt-1">
            Add hooks to improve content generation quality
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
          <div className="p-4 border-b">
            <h3 className="text-lg font-bold text-gray-900">
              Hooks ({hooks.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Hook Text</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Platform</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Category</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Freshness</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Usage</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Active</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {hooks.map((hook) => (
                  <tr key={hook.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3 max-w-xs">
                      <span className="text-gray-900 font-medium truncate block" title={hook.hookText}>
                        {truncateText(hook.hookText, 60)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${PLATFORM_COLORS[hook.platform] || 'bg-gray-100 text-gray-600'}`}>
                        {PLATFORM_ICONS[hook.platform]}
                        {(hook.platform || '').replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                        {(hook.category || '').replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              hook.freshnessScore >= 70 ? 'bg-green-500' :
                              hook.freshnessScore >= 40 ? 'bg-yellow-500' :
                              'bg-red-500'
                            }`}
                            style={{ width: `${hook.freshnessScore || 0}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500 w-8 text-right">
                          {hook.freshnessScore || 0}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700 font-medium">
                      {hook.usageCount}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => handleToggleActive(hook)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                          hook.isActive ? 'bg-[#059211]' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                            hook.isActive ? 'translate-x-4.5' : 'translate-x-0.5'
                          }`}
                          style={{ transform: hook.isActive ? 'translateX(18px)' : 'translateX(2px)' }}
                        />
                      </button>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => startEdit(hook)}
                        className="flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs font-medium hover:bg-blue-100 transition-all mx-auto"
                      >
                        <Edit3 size={12} />
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Business Data Tab ----

function BusinessDataTab({ onError }: { onError: (msg: string) => void }) {
  const [metrics, setMetrics] = useState<BusinessMetrics | null>(null);
  const [topStores, setTopStores] = useState<Performer[]>([]);
  const [topProducts, setTopProducts] = useState<Performer[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    loadBusinessData();
  }, []);

  const loadBusinessData = async () => {
    setLoading(true);
    try {
      const [metricsRes, performersRes, milestonesRes] = await Promise.all([
        mangwaleAIClient.get<BusinessMetrics>('/mos/content-factory/business/metrics').catch(() => null),
        mangwaleAIClient.get<any>('/mos/content-factory/business/performers').catch(() => []),
        mangwaleAIClient.get<Milestone[]>('/mos/content-factory/business/milestones').catch(() => []),
      ]);
      setMetrics(metricsRes);
      // Fix 6: Backend returns flat TopPerformer[] with category field, not { topStores, topProducts }
      const allPerformers = Array.isArray(performersRes) ? performersRes : [];
      setTopStores(allPerformers.filter((p: any) => p.category === 'store'));
      setTopProducts(allPerformers.filter((p: any) => p.category === 'product'));
      setMilestones(Array.isArray(milestonesRes) ? milestonesRes : []);
    } catch (err: any) {
      onError(err.message || 'Failed to load business data');
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await mangwaleAIClient.post('/mos/content-factory/sync/all', {});
      await loadBusinessData();
    } catch (err: any) {
      onError(err.message || 'Failed to sync business data');
    } finally {
      setSyncing(false);
    }
  };

  const getMilestoneColor = (type: string) => {
    const colors: Record<string, string> = {
      revenue: 'bg-green-100 text-green-700',
      orders: 'bg-blue-100 text-blue-700',
      users: 'bg-purple-100 text-purple-700',
      growth: 'bg-orange-100 text-orange-700',
    };
    return colors[type] || 'bg-gray-100 text-gray-700';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <RefreshCw className="animate-spin text-[#059211]" size={48} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Sync Button */}
      <div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all disabled:opacity-50"
        >
          {syncing ? <RefreshCw size={16} className="animate-spin" /> : <Database size={16} />}
          {syncing ? 'Syncing...' : 'Sync Now'}
        </button>
      </div>

      {/* Latest Metrics */}
      {metrics ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-6">
          <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <BarChart3 className="text-[#059211]" size={20} />
            Latest Metrics
            <span className="text-xs text-gray-500 font-normal ml-2">
              {metrics.date ? new Date(metrics.date).toLocaleDateString('en-IN') : 'Today'}
            </span>
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <p className="text-xs text-gray-500 mb-1">Total Orders</p>
              <p className="text-xl font-bold text-gray-900">{metrics.totalOrders.toLocaleString('en-IN')}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <p className="text-xs text-gray-500 mb-1">Revenue</p>
              <p className="text-xl font-bold text-green-600">{formatCurrency(metrics.revenue)}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <p className="text-xs text-gray-500 mb-1">AOV</p>
              <p className="text-xl font-bold text-blue-600">{formatCurrency(metrics.aov)}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <p className="text-xs text-gray-500 mb-1">New Users</p>
              <p className="text-xl font-bold text-purple-600">{metrics.newUsers.toLocaleString('en-IN')}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <p className="text-xs text-gray-500 mb-1">Active Stores</p>
              <p className="text-xl font-bold text-orange-600">{metrics.activeStores.toLocaleString('en-IN')}</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <Database className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No business metrics available</p>
          <p className="text-sm text-gray-400 mt-1">
            Click &ldquo;Sync Now&rdquo; to fetch the latest data
          </p>
        </div>
      )}

      {/* Top Performers */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {/* Top Stores */}
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-6">
          <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <Store className="text-[#059211]" size={20} />
            Top Stores
          </h3>
          {topStores.length === 0 ? (
            <p className="text-sm text-gray-500 italic">No store data available</p>
          ) : (
            <div className="space-y-3">
              {topStores.map((store, idx) => (
                <div key={store.id} className="flex items-center gap-3">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[#059211]/10 text-[#059211] text-xs font-bold">
                    {idx + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{store.name}</p>
                    <p className="text-xs text-gray-500">{store.metricLabel}</p>
                  </div>
                  <span className="text-sm font-bold text-gray-700">
                    {typeof store.metric === 'number' ? store.metric.toLocaleString('en-IN') : store.metric}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top Products */}
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-6">
          <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <ShoppingBag className="text-[#059211]" size={20} />
            Top Products
          </h3>
          {topProducts.length === 0 ? (
            <p className="text-sm text-gray-500 italic">No product data available</p>
          ) : (
            <div className="space-y-3">
              {topProducts.map((product, idx) => (
                <div key={product.id} className="flex items-center gap-3">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-xs font-bold">
                    {idx + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{product.name}</p>
                    <p className="text-xs text-gray-500">{product.metricLabel}</p>
                  </div>
                  <span className="text-sm font-bold text-gray-700">
                    {typeof product.metric === 'number' ? product.metric.toLocaleString('en-IN') : product.metric}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent Milestones */}
      <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
          <Award className="text-[#059211]" size={20} />
          Recent Milestones
        </h3>
        {milestones.length === 0 ? (
          <p className="text-sm text-gray-500 italic">No milestones recorded yet</p>
        ) : (
          <div className="space-y-3">
            {milestones.map((milestone) => (
              <div key={milestone.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${getMilestoneColor(milestone.type)}`}>
                  {milestone.type}
                </span>
                <p className="text-sm text-gray-800 flex-1">{milestone.text}</p>
                <span className="text-xs text-gray-500">{timeAgo(milestone.date)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Prompts Tab ----

function PromptsTab({ onError }: { onError: (msg: string) => void }) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activating, setActivating] = useState<string | null>(null);

  useEffect(() => {
    loadPrompts();
  }, []);

  const loadPrompts = async () => {
    setLoading(true);
    try {
      const result = await mangwaleAIClient.get<Prompt[]>('/mos/content-factory/prompts');
      setPrompts(Array.isArray(result) ? result : []);
    } catch (err: any) {
      onError(err.message || 'Failed to load prompts');
    } finally {
      setLoading(false);
    }
  };

  const handleActivate = async (id: string) => {
    setActivating(id);
    try {
      await mangwaleAIClient.post(`/mos/content-factory/prompts/${id}/activate`, {});
      loadPrompts();
    } catch (err: any) {
      onError(err.message || 'Failed to activate prompt');
    } finally {
      setActivating(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <RefreshCw className="animate-spin text-[#059211]" size={48} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {prompts.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <BookOpen className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No prompts configured</p>
          <p className="text-sm text-gray-400 mt-1">
            Prompts are managed by the backend content factory service
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
          <div className="p-4 border-b">
            <h3 className="text-lg font-bold text-gray-900">
              Prompt Templates ({prompts.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Content Type</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Platform</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Version</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {prompts.map((prompt) => (
                  <PromptRow
                    key={prompt.id}
                    prompt={prompt}
                    expanded={expandedId === prompt.id}
                    onToggle={() => setExpandedId(expandedId === prompt.id ? null : prompt.id)}
                    onActivate={() => handleActivate(prompt.id)}
                    activating={activating === prompt.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function PromptRow({
  prompt,
  expanded,
  onToggle,
  onActivate,
  activating,
}: {
  prompt: Prompt;
  expanded: boolean;
  onToggle: () => void;
  onActivate: () => void;
  activating: boolean;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-t border-gray-100 hover:bg-gray-50 cursor-pointer transition-all ${
          expanded ? 'bg-green-50' : ''
        }`}
      >
        <td className="px-4 py-3">
          <span className="text-gray-900 font-medium flex items-center gap-2">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {prompt.name}
          </span>
        </td>
        <td className="px-4 py-3">
          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[prompt.contentType] || 'bg-gray-100 text-gray-600'}`}>
            {(prompt.contentType || '').replace(/_/g, ' ')}
          </span>
        </td>
        <td className="px-4 py-3">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${PLATFORM_COLORS[prompt.platform] || 'bg-gray-100 text-gray-600'}`}>
            {PLATFORM_ICONS[prompt.platform]}
            {(prompt.platform || '').replace(/_/g, ' ')}
          </span>
        </td>
        <td className="px-4 py-3 text-center">
          <span className="text-sm font-medium text-gray-700">v{prompt.version}</span>
        </td>
        <td className="px-4 py-3 text-center">
          {prompt.active ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              Active
            </span>
          ) : (
            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
              Inactive
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
          {!prompt.active && (
            <button
              onClick={onActivate}
              disabled={activating}
              className="flex items-center gap-1 px-2 py-1 bg-green-50 text-green-700 rounded text-xs font-medium hover:bg-green-100 transition-all mx-auto disabled:opacity-50"
            >
              {activating ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle size={12} />}
              Activate
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50">
          <td colSpan={6} className="px-4 py-4">
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">System Prompt</p>
                <pre className="bg-white border border-gray-200 rounded-lg p-4 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap font-mono max-h-60 overflow-y-auto">
                  {prompt.systemPrompt || 'No system prompt configured'}
                </pre>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">User Prompt Template</p>
                <pre className="bg-white border border-gray-200 rounded-lg p-4 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap font-mono max-h-60 overflow-y-auto">
                  {prompt.userPromptTemplate || 'No user prompt template configured'}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
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

// ---- Analytics Tab ----

interface AnalyticsSummary {
  totalTrackedPosts: number;
  totalEntries: number;
  avgEngagementRate: number;
  totalImpressions: number;
  totalReach: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  totalSaves: number;
  totalClicks: number;
  totalVideoViews: number;
  byPlatform: {
    platform: string;
    trackedPosts: number;
    avgEngagementRate: number;
    totalImpressions: number;
    totalLikes: number;
  }[];
}

interface TopPerformingItem {
  content_piece_id: string;
  title: string;
  content_type: string;
  platform: string;
  engagement_rate: number;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
}

interface Learning {
  id: string;
  learning_type: string;
  insight: string;
  confidence: number;
  evidence: any;
  created_at: string;
}

function AnalyticsTab({ onError }: { onError: (msg: string) => void }) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [topPerforming, setTopPerforming] = useState<TopPerformingItem[]>([]);
  const [learnings, setLearnings] = useState<Learning[]>([]);
  const [loading, setLoading] = useState(true);
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [manualContentId, setManualContentId] = useState('');
  const [manualPlatform, setManualPlatform] = useState('instagram');
  const [manualMetrics, setManualMetrics] = useState({
    impressions: '', reach: '', likes: '', comments: '', shares: '', saves: '', clicks: '', videoViews: '', avgWatchTimeSec: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryRes, topRes, learningsRes] = await Promise.all([
        mangwaleAIClient.get('/mos/content-factory/analytics/summary'),
        mangwaleAIClient.get('/mos/content-factory/analytics/top-performing?limit=10'),
        mangwaleAIClient.get('/mos/content-factory/learnings?limit=20'),
      ]);
      setSummary(summaryRes.data);
      setTopPerforming(Array.isArray(topRes.data) ? topRes.data : []);
      setLearnings(Array.isArray(learningsRes.data) ? learningsRes.data : []);
    } catch (err: any) {
      onError(err.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => { loadAnalytics(); }, [loadAnalytics]);

  const submitManualEntry = async () => {
    if (!manualContentId.trim()) return;
    setSubmitting(true);
    try {
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(manualMetrics)) {
        if (v) metrics[k] = parseInt(v);
      }
      await mangwaleAIClient.post(`/mos/content-factory/analytics/${manualContentId}/manual`, {
        platform: manualPlatform,
        ...metrics,
      });
      setManualEntryOpen(false);
      setManualContentId('');
      setManualMetrics({ impressions: '', reach: '', likes: '', comments: '', shares: '', saves: '', clicks: '', videoViews: '', avgWatchTimeSec: '' });
      loadAnalytics();
    } catch (err: any) {
      onError(err.message || 'Failed to submit analytics');
    } finally {
      setSubmitting(false);
    }
  };

  const triggerAnalysis = async () => {
    try {
      await mangwaleAIClient.post('/mos/content-factory/learnings/analyze', {});
      loadAnalytics();
    } catch (err: any) {
      onError(err.message || 'Analysis failed');
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-gray-400"><RefreshCw className="animate-spin mr-2" size={20} /> Loading analytics...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {[
            { label: 'Tracked Posts', value: summary.totalTrackedPosts, icon: <FileText size={18} />, color: 'text-blue-600' },
            { label: 'Avg Engagement', value: `${(summary.avgEngagementRate ?? 0).toFixed(1)}%`, icon: <TrendingUp size={18} />, color: 'text-green-600' },
            { label: 'Total Impressions', value: summary.totalImpressions.toLocaleString(), icon: <Eye size={18} />, color: 'text-purple-600' },
            { label: 'Total Reach', value: summary.totalReach.toLocaleString(), icon: <Users size={18} />, color: 'text-indigo-600' },
            { label: 'Total Likes', value: summary.totalLikes.toLocaleString(), icon: <Award size={18} />, color: 'text-red-500' },
            { label: 'Video Views', value: summary.totalVideoViews.toLocaleString(), icon: <Eye size={18} />, color: 'text-orange-500' },
          ].map((card) => (
            <div key={card.label} className="bg-white rounded-xl border p-4">
              <div className={`flex items-center gap-2 mb-1 ${card.color}`}>{card.icon}<span className="text-xs text-gray-500">{card.label}</span></div>
              <div className="text-2xl font-bold text-gray-900">{card.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Platform Breakdown */}
      {summary && summary.byPlatform.length > 0 && (
        <div className="bg-white rounded-xl border p-6">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2"><Globe size={20} /> Platform Breakdown</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {summary.byPlatform.map((p) => (
              <div key={p.platform} className="border rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  {p.platform === 'instagram' ? <Instagram size={18} className="text-pink-500" /> : <Linkedin size={18} className="text-blue-600" />}
                  <span className="font-semibold capitalize">{p.platform}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-gray-500">Posts:</span> {p.trackedPosts}</div>
                  <div><span className="text-gray-500">Engagement:</span> {(p.avgEngagementRate ?? 0).toFixed(1)}%</div>
                  <div><span className="text-gray-500">Impressions:</span> {p.totalImpressions.toLocaleString()}</div>
                  <div><span className="text-gray-500">Likes:</span> {p.totalLikes.toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button onClick={() => setManualEntryOpen(!manualEntryOpen)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <Plus size={16} /> Manual Entry
        </button>
        <button onClick={triggerAnalysis} className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors">
          <TrendingUp size={16} /> Analyze Performance
        </button>
        <button onClick={loadAnalytics} className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors">
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {/* Manual Entry Form */}
      {manualEntryOpen && (
        <div className="bg-white rounded-xl border p-6">
          <h3 className="text-lg font-semibold mb-4">Manual Analytics Entry</h3>
          <p className="text-sm text-gray-500 mb-4">Enter metrics from Instagram Insights or LinkedIn Analytics dashboards.</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Content ID</label>
              <input type="text" value={manualContentId} onChange={(e) => setManualContentId(e.target.value)} placeholder="Paste content piece ID" className="w-full px-3 py-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Platform</label>
              <select value={manualPlatform} onChange={(e) => setManualPlatform(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm">
                <option value="instagram">Instagram</option>
                <option value="linkedin">LinkedIn</option>
              </select>
            </div>
            {Object.entries({ impressions: 'Impressions', reach: 'Reach', likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves', clicks: 'Clicks', videoViews: 'Video Views', avgWatchTimeSec: 'Avg Watch (sec)' }).map(([key, label]) => (
              <div key={key}>
                <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
                <input type="number" value={manualMetrics[key as keyof typeof manualMetrics]} onChange={(e) => setManualMetrics((prev) => ({ ...prev, [key]: e.target.value }))} placeholder="0" className="w-full px-3 py-2 border rounded-lg text-sm" />
              </div>
            ))}
          </div>
          <div className="flex gap-3">
            <button onClick={submitManualEntry} disabled={submitting || !manualContentId.trim()} className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors">
              {submitting ? 'Submitting...' : 'Submit'}
            </button>
            <button onClick={() => setManualEntryOpen(false)} className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Top Performing */}
      {topPerforming.length > 0 && (
        <div className="bg-white rounded-xl border p-6">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2"><Award size={20} className="text-yellow-500" /> Top Performing Content</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="pb-2 pr-4">Title</th>
                  <th className="pb-2 pr-4">Type</th>
                  <th className="pb-2 pr-4">Platform</th>
                  <th className="pb-2 pr-4">Engagement</th>
                  <th className="pb-2 pr-4">Impressions</th>
                  <th className="pb-2 pr-4">Likes</th>
                  <th className="pb-2 pr-4">Comments</th>
                  <th className="pb-2">Shares</th>
                </tr>
              </thead>
              <tbody>
                {topPerforming.map((item) => (
                  <tr key={item.content_piece_id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="py-3 pr-4 font-medium">{item.title ? truncateText(item.title, 40) : 'Untitled'}</td>
                    <td className="py-3 pr-4"><span className="px-2 py-0.5 bg-gray-100 rounded text-xs">{item.content_type}</span></td>
                    <td className="py-3 pr-4 capitalize">{item.platform}</td>
                    <td className="py-3 pr-4 font-semibold text-green-600">{(item.engagement_rate ?? 0).toFixed(1)}%</td>
                    <td className="py-3 pr-4">{item.impressions?.toLocaleString()}</td>
                    <td className="py-3 pr-4">{item.likes?.toLocaleString()}</td>
                    <td className="py-3 pr-4">{item.comments?.toLocaleString()}</td>
                    <td className="py-3">{item.shares?.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Learnings / Insights */}
      <div className="bg-white rounded-xl border p-6">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2"><Sparkles size={20} className="text-purple-500" /> AI Learnings</h3>
        {learnings.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            <TrendingUp size={40} className="mx-auto mb-3 opacity-50" />
            <p className="font-medium">No learnings yet</p>
            <p className="text-sm mt-1">Generate and track 10+ content pieces with analytics to unlock AI-driven insights.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {learnings.map((l) => (
              <div key={l.id} className="border rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs font-medium">{l.learning_type}</span>
                  <span className="text-xs text-gray-500">Confidence: {((l.confidence ?? 0) * 100).toFixed(0)}%</span>
                </div>
                <p className="text-sm text-gray-800">{l.insight}</p>
                <p className="text-xs text-gray-400 mt-2">{new Date(l.created_at).toLocaleDateString()}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

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

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}
