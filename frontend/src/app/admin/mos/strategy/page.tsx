'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, AlertCircle, BookOpen, Brain, Search, Plus,
  X, Check, Clock, Tag, BarChart3, ChevronDown, ChevronUp,
  FileText, Lightbulb, Archive, Filter, Hash, Eye, Save,
  Loader2, CheckCircle, XCircle, AlertTriangle, TrendingUp,
  Calendar,
} from 'lucide-react';
import { mangwaleAIClient } from '@/lib/api/mangwale-ai';

// ---- Types ----

interface Decision {
  id: string;
  type: string;
  title: string;
  decision: string;
  rationale: string;
  outcome: string;
  outcomeMetrics: Record<string, any>;
  decidedBy: string;
  tags: string[];
  createdAt: string;
}

interface DecisionStats {
  total: number;
  byType: Record<string, number>;
  byOutcome: Record<string, number>;
  recentCount: number;
}

interface MemoryItem {
  id: string;
  category: string;
  title: string;
  content: string;
  source: string;
  tags: string[];
  accessCount: number;
  createdAt: string;
}

interface MemoryCategory {
  category: string;
  count: number;
}

type Tab = 'decisions' | 'memory';

// ---- Type Colors ----

const TYPE_COLORS: Record<string, string> = {
  pricing: 'bg-blue-100 text-blue-700 border-blue-200',
  marketing: 'bg-pink-100 text-pink-700 border-pink-200',
  operations: 'bg-orange-100 text-orange-700 border-orange-200',
  product: 'bg-purple-100 text-purple-700 border-purple-200',
  technology: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  hiring: 'bg-teal-100 text-teal-700 border-teal-200',
  finance: 'bg-green-100 text-green-700 border-green-200',
  partnerships: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  customer_experience: 'bg-amber-100 text-amber-700 border-amber-200',
};

const OUTCOME_COLORS: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  success: {
    bg: 'bg-green-100',
    text: 'text-green-700',
    icon: <CheckCircle size={14} />,
  },
  failed: {
    bg: 'bg-red-100',
    text: 'text-red-700',
    icon: <XCircle size={14} />,
  },
  pending: {
    bg: 'bg-gray-100',
    text: 'text-gray-600',
    icon: <Clock size={14} />,
  },
  in_progress: {
    bg: 'bg-blue-100',
    text: 'text-blue-700',
    icon: <TrendingUp size={14} />,
  },
  partial: {
    bg: 'bg-yellow-100',
    text: 'text-yellow-700',
    icon: <AlertTriangle size={14} />,
  },
};

const CATEGORY_COLORS: Record<string, string> = {
  market_insight: 'bg-blue-100 text-blue-700 border-blue-200',
  customer_feedback: 'bg-green-100 text-green-700 border-green-200',
  competitor_analysis: 'bg-red-100 text-red-700 border-red-200',
  operational_learning: 'bg-orange-100 text-orange-700 border-orange-200',
  technical_knowledge: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  best_practice: 'bg-purple-100 text-purple-700 border-purple-200',
  failure_post_mortem: 'bg-pink-100 text-pink-700 border-pink-200',
  vendor_info: 'bg-teal-100 text-teal-700 border-teal-200',
  regulatory: 'bg-amber-100 text-amber-700 border-amber-200',
};

const DECISION_TYPES = [
  'pricing',
  'marketing',
  'operations',
  'product',
  'technology',
  'hiring',
  'finance',
  'partnerships',
  'customer_experience',
];

// ---- Decision Form ----

interface DecisionForm {
  type: string;
  title: string;
  decision: string;
  rationale: string;
  context: string;
  decidedBy: string;
  tags: string;
}

const EMPTY_DECISION_FORM: DecisionForm = {
  type: 'product',
  title: '',
  decision: '',
  rationale: '',
  context: '',
  decidedBy: '',
  tags: '',
};

// ---- Memory Form ----

interface MemoryForm {
  category: string;
  title: string;
  content: string;
  source: string;
  tags: string;
}

const EMPTY_MEMORY_FORM: MemoryForm = {
  category: 'market_insight',
  title: '',
  content: '',
  source: '',
  tags: '',
};

// ---- Main Page Component ----

export default function StrategyLedgerPage() {
  const [activeTab, setActiveTab] = useState<Tab>('decisions');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stats
  const [stats, setStats] = useState<DecisionStats | null>(null);

  // Decisions
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [decisionFilter, setDecisionFilter] = useState('');
  const [decisionSearch, setDecisionSearch] = useState('');
  const [showDecisionForm, setShowDecisionForm] = useState(false);
  const [decisionForm, setDecisionForm] = useState<DecisionForm>(EMPTY_DECISION_FORM);
  const [expandedDecisionId, setExpandedDecisionId] = useState<string | null>(null);

  // Outcome update
  const [updatingOutcome, setUpdatingOutcome] = useState<string | null>(null);
  const [outcomeValue, setOutcomeValue] = useState('');

  // Memory
  const [memoryItems, setMemoryItems] = useState<MemoryItem[]>([]);
  const [memoryCategories, setMemoryCategories] = useState<MemoryCategory[]>([]);
  const [memoryFilter, setMemoryFilter] = useState('');
  const [memorySearch, setMemorySearch] = useState('');
  const [showMemoryForm, setShowMemoryForm] = useState(false);
  const [memoryForm, setMemoryForm] = useState<MemoryForm>(EMPTY_MEMORY_FORM);

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadStats();
  }, []);

  useEffect(() => {
    loadTabData();
  }, [activeTab, decisionFilter, memoryFilter]);

  const loadStats = async () => {
    try {
      const data = await mangwaleAIClient.get<DecisionStats>(
        '/mos/strategy/decisions/stats',
      ).catch(() => null);
      setStats(data);
    } catch (err: any) {
      console.error('Failed to load strategy stats:', err);
    }
  };

  const loadTabData = async () => {
    try {
      setLoading(true);
      setError(null);

      if (activeTab === 'decisions') {
        const typeParam = decisionFilter ? `?type=${decisionFilter}&limit=50` : '?limit=50';
        const data = await mangwaleAIClient.get<Decision[]>(
          `/mos/strategy/decisions${typeParam}`,
        ).catch(() => [] as Decision[]);
        setDecisions(data);
      } else if (activeTab === 'memory') {
        const params = new URLSearchParams();
        if (memoryFilter) params.append('category', memoryFilter);
        params.append('limit', '20');
        const query = params.toString() ? `?${params.toString()}` : '';

        const [items, cats] = await Promise.all([
          mangwaleAIClient.get<MemoryItem[]>(`/mos/strategy/memory${query}`).catch(() => [] as MemoryItem[]),
          mangwaleAIClient.get<{ categories: MemoryCategory[] }>(
            '/mos/strategy/memory/categories',
          ).catch(() => ({ categories: [] as MemoryCategory[] })),
        ]);
        setMemoryItems(items);
        setMemoryCategories(cats.categories || []);
      }
    } catch (err: any) {
      console.error('Failed to load strategy data:', err);
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleSearchDecisions = async () => {
    if (!decisionSearch.trim()) {
      loadTabData();
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const data = await mangwaleAIClient.get<Decision[]>(
        `/mos/strategy/decisions/search?query=${encodeURIComponent(decisionSearch)}`,
      );
      setDecisions(data);
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSearchMemory = async () => {
    if (!memorySearch.trim()) {
      loadTabData();
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      params.append('query', memorySearch);
      if (memoryFilter) params.append('category', memoryFilter);
      params.append('limit', '20');
      const data = await mangwaleAIClient.get<MemoryItem[]>(
        `/mos/strategy/memory?${params.toString()}`,
      );
      setMemoryItems(data);
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDecision = async () => {
    if (!decisionForm.title || !decisionForm.decision) {
      setError('Please fill in title and decision');
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, any> = {
        type: decisionForm.type,
        title: decisionForm.title,
        decision: decisionForm.decision,
      };
      if (decisionForm.rationale) payload.rationale = decisionForm.rationale;
      if (decisionForm.context) payload.context = decisionForm.context;
      if (decisionForm.decidedBy) payload.decidedBy = decisionForm.decidedBy;
      if (decisionForm.tags) {
        payload.tags = decisionForm.tags.split(',').map((s) => s.trim()).filter(Boolean);
      }

      await mangwaleAIClient.post('/mos/strategy/decisions', payload);
      setDecisionForm(EMPTY_DECISION_FORM);
      setShowDecisionForm(false);
      loadTabData();
      loadStats();
    } catch (err: any) {
      setError(err.message || 'Failed to create decision');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateOutcome = async (id: string, outcome: string) => {
    try {
      await mangwaleAIClient.patch(`/mos/strategy/decisions/${id}/outcome`, {
        outcome,
      });
      setDecisions((prev) =>
        prev.map((d) => (d.id === id ? { ...d, outcome } : d)),
      );
      setUpdatingOutcome(null);
      setOutcomeValue('');
      loadStats();
    } catch (err: any) {
      setError(err.message || 'Failed to update outcome');
    }
  };

  const handleCreateMemory = async () => {
    if (!memoryForm.title || !memoryForm.content) {
      setError('Please fill in title and content');
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, any> = {
        category: memoryForm.category,
        title: memoryForm.title,
        content: memoryForm.content,
      };
      if (memoryForm.source) payload.source = memoryForm.source;
      if (memoryForm.tags) {
        payload.tags = memoryForm.tags.split(',').map((s) => s.trim()).filter(Boolean);
      }

      await mangwaleAIClient.post('/mos/strategy/memory', payload);
      setMemoryForm(EMPTY_MEMORY_FORM);
      setShowMemoryForm(false);
      loadTabData();
    } catch (err: any) {
      setError(err.message || 'Failed to add memory');
    } finally {
      setSubmitting(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'decisions', label: 'Decisions', icon: <BookOpen size={16} /> },
    { id: 'memory', label: 'Institutional Memory', icon: <Brain size={16} /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#059211] to-[#047a0e] rounded-2xl p-8 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Strategy Ledger</h1>
            <p className="text-green-100">
              Decision log, outcome tracking, and institutional memory
            </p>
          </div>
          <button
            onClick={() => {
              loadStats();
              loadTabData();
            }}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all disabled:opacity-50"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatsCard
            icon={<FileText size={22} />}
            label="Total Decisions"
            value={String(stats.total)}
            color="blue"
          />
          <StatsCard
            icon={<Clock size={22} />}
            label="Recent (30d)"
            value={String(stats.recentCount)}
            color="green"
          />
          <div className="bg-white rounded-xl p-4 shadow-md border-2 border-gray-100">
            <p className="text-xs text-gray-500 mb-2 flex items-center gap-1">
              <Tag size={12} /> By Type
            </p>
            <div className="flex flex-wrap gap-1">
              {Object.entries(stats.byType || {}).map(([type, count]) => (
                <span
                  key={type}
                  className={`px-2 py-0.5 rounded text-xs font-medium border ${
                    TYPE_COLORS[type] || 'bg-gray-100 text-gray-600 border-gray-200'
                  }`}
                >
                  {(type || '').replace(/_/g, ' ')}: {count}
                </span>
              ))}
              {Object.keys(stats.byType || {}).length === 0 && (
                <span className="text-xs text-gray-400">No data</span>
              )}
            </div>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-md border-2 border-gray-100">
            <p className="text-xs text-gray-500 mb-2 flex items-center gap-1">
              <BarChart3 size={12} /> By Outcome
            </p>
            <div className="flex flex-wrap gap-1">
              {Object.entries(stats.byOutcome || {}).map(([outcome, count]) => {
                const outcomeStyle = OUTCOME_COLORS[outcome] || OUTCOME_COLORS.pending;
                return (
                  <span
                    key={outcome}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${outcomeStyle.bg} ${outcomeStyle.text}`}
                  >
                    {outcomeStyle.icon}
                    {outcome}: {count}
                  </span>
                );
              })}
              {Object.keys(stats.byOutcome || {}).length === 0 && (
                <span className="text-xs text-gray-400">No data</span>
              )}
            </div>
          </div>
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
          {activeTab === 'decisions' && (
            <DecisionsTab
              decisions={decisions}
              filter={decisionFilter}
              searchQuery={decisionSearch}
              showForm={showDecisionForm}
              form={decisionForm}
              submitting={submitting}
              expandedId={expandedDecisionId}
              updatingOutcome={updatingOutcome}
              outcomeValue={outcomeValue}
              onFilterChange={(f) => setDecisionFilter(f)}
              onSearchChange={(s) => setDecisionSearch(s)}
              onSearch={handleSearchDecisions}
              onToggleExpand={(id) =>
                setExpandedDecisionId(expandedDecisionId === id ? null : id)
              }
              onShowForm={() => setShowDecisionForm(true)}
              onHideForm={() => {
                setShowDecisionForm(false);
                setDecisionForm(EMPTY_DECISION_FORM);
              }}
              onFormChange={(updates) =>
                setDecisionForm((prev) => ({ ...prev, ...updates }))
              }
              onSubmit={handleCreateDecision}
              onStartOutcomeUpdate={(id) => {
                setUpdatingOutcome(id);
                setOutcomeValue('');
              }}
              onCancelOutcomeUpdate={() => {
                setUpdatingOutcome(null);
                setOutcomeValue('');
              }}
              onOutcomeValueChange={setOutcomeValue}
              onUpdateOutcome={handleUpdateOutcome}
            />
          )}
          {activeTab === 'memory' && (
            <MemoryTab
              items={memoryItems}
              categories={memoryCategories}
              filter={memoryFilter}
              searchQuery={memorySearch}
              showForm={showMemoryForm}
              form={memoryForm}
              submitting={submitting}
              onFilterChange={(f) => setMemoryFilter(f)}
              onSearchChange={(s) => setMemorySearch(s)}
              onSearch={handleSearchMemory}
              onShowForm={() => setShowMemoryForm(true)}
              onHideForm={() => {
                setShowMemoryForm(false);
                setMemoryForm(EMPTY_MEMORY_FORM);
              }}
              onFormChange={(updates) =>
                setMemoryForm((prev) => ({ ...prev, ...updates }))
              }
              onSubmit={handleCreateMemory}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---- Decisions Tab ----

function DecisionsTab({
  decisions,
  filter,
  searchQuery,
  showForm,
  form,
  submitting,
  expandedId,
  updatingOutcome,
  outcomeValue,
  onFilterChange,
  onSearchChange,
  onSearch,
  onToggleExpand,
  onShowForm,
  onHideForm,
  onFormChange,
  onSubmit,
  onStartOutcomeUpdate,
  onCancelOutcomeUpdate,
  onOutcomeValueChange,
  onUpdateOutcome,
}: {
  decisions: Decision[];
  filter: string;
  searchQuery: string;
  showForm: boolean;
  form: DecisionForm;
  submitting: boolean;
  expandedId: string | null;
  updatingOutcome: string | null;
  outcomeValue: string;
  onFilterChange: (f: string) => void;
  onSearchChange: (s: string) => void;
  onSearch: () => void;
  onToggleExpand: (id: string) => void;
  onShowForm: () => void;
  onHideForm: () => void;
  onFormChange: (updates: Partial<DecisionForm>) => void;
  onSubmit: () => void;
  onStartOutcomeUpdate: (id: string) => void;
  onCancelOutcomeUpdate: () => void;
  onOutcomeValueChange: (v: string) => void;
  onUpdateOutcome: (id: string, outcome: string) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          {/* Type Filter */}
          <div className="flex items-center gap-2">
            <Filter size={16} className="text-gray-400" />
            <select
              value={filter}
              onChange={(e) => onFilterChange(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
            >
              <option value="">All Types</option>
              {DECISION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {(t || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              ))}
            </select>
          </div>

          {/* Search */}
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSearch()}
              placeholder="Search decisions..."
              className="pl-9 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211] w-64"
            />
          </div>
          <button
            onClick={onSearch}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-[#059211] border border-gray-300 rounded-lg hover:border-[#059211] transition-colors"
          >
            Search
          </button>
        </div>

        {!showForm && (
          <button
            onClick={onShowForm}
            className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] transition-colors text-sm font-medium"
          >
            <Plus size={16} />
            Log Decision
          </button>
        )}
      </div>

      {/* New Decision Form */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-md border-2 border-[#059211]/20 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Log New Decision</h3>
            <button onClick={onHideForm} className="text-gray-400 hover:text-gray-600">
              <X size={20} />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
              <select
                value={form.type}
                onChange={(e) => onFormChange({ type: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              >
                {DECISION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {(t || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                  </option>
                ))}
              </select>
            </div>

            {/* Decided By */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Decided By
              </label>
              <input
                type="text"
                value={form.decidedBy}
                onChange={(e) => onFormChange({ decidedBy: e.target.value })}
                placeholder="e.g., CTO, Product Lead"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Title */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => onFormChange({ title: e.target.value })}
                placeholder="Brief title for this decision"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Decision */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Decision
              </label>
              <textarea
                value={form.decision}
                onChange={(e) => onFormChange({ decision: e.target.value })}
                placeholder="What was decided?"
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211] resize-none"
              />
            </div>

            {/* Rationale */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Rationale (optional)
              </label>
              <textarea
                value={form.rationale}
                onChange={(e) => onFormChange({ rationale: e.target.value })}
                placeholder="Why was this decision made?"
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211] resize-none"
              />
            </div>

            {/* Context */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Context (optional)
              </label>
              <textarea
                value={form.context}
                onChange={(e) => onFormChange({ context: e.target.value })}
                placeholder="Any additional context or background"
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211] resize-none"
              />
            </div>

            {/* Tags */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tags (comma-separated)
              </label>
              <input
                type="text"
                value={form.tags}
                onChange={(e) => onFormChange({ tags: e.target.value })}
                placeholder="e.g., Q1-2026, pricing-strategy, food-module"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={onHideForm}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={onSubmit}
              disabled={submitting}
              className="flex items-center gap-2 px-6 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] transition-colors text-sm font-medium disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Save size={16} />
              )}
              Log Decision
            </button>
          </div>
        </div>
      )}

      {/* Decision List */}
      {decisions.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <BookOpen className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No decisions logged yet</p>
          <p className="text-sm text-gray-400 mt-1">
            Start logging strategic decisions to build your ledger
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {decisions.map((decision) => {
            const outcomeStyle = OUTCOME_COLORS[decision.outcome] || OUTCOME_COLORS.pending;
            const isExpanded = expandedId === decision.id;

            return (
              <div
                key={decision.id}
                className="bg-white rounded-xl shadow-md border-2 border-gray-100 hover:border-gray-200 transition-all"
              >
                {/* Decision Row */}
                <div
                  className="p-4 cursor-pointer"
                  onClick={() => onToggleExpand(decision.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        {/* Type Badge */}
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${
                            TYPE_COLORS[decision.type] || 'bg-gray-100 text-gray-600 border-gray-200'
                          }`}
                        >
                          {(decision.type || '').replace(/_/g, ' ')}
                        </span>

                        {/* Outcome Badge */}
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${outcomeStyle.bg} ${outcomeStyle.text}`}
                        >
                          {outcomeStyle.icon}
                          {decision.outcome || 'pending'}
                        </span>

                        {decision.decidedBy && (
                          <span className="text-xs text-gray-400">
                            by {decision.decidedBy}
                          </span>
                        )}
                      </div>

                      <h3 className="font-medium text-gray-900">{decision.title}</h3>
                      <p className="text-sm text-gray-600 line-clamp-1 mt-0.5">
                        {decision.decision}
                      </p>

                      {/* Tags */}
                      {decision.tags && decision.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {decision.tags.map((tag, i) => (
                            <span
                              key={i}
                              className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded text-xs"
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-xs text-gray-400">
                        {formatDate(decision.createdAt)}
                      </span>
                      {isExpanded ? (
                        <ChevronUp size={16} className="text-gray-400" />
                      ) : (
                        <ChevronDown size={16} className="text-gray-400" />
                      )}
                    </div>
                  </div>
                </div>

                {/* Expanded Detail */}
                {isExpanded && (
                  <div className="border-t border-gray-100 px-4 pb-4 pt-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Full Decision */}
                      <div className="bg-gray-50 rounded-lg p-4">
                        <p className="text-xs font-medium text-gray-500 mb-2 flex items-center gap-1">
                          <FileText size={12} /> Decision
                        </p>
                        <p className="text-sm text-gray-700">{decision.decision}</p>
                      </div>

                      {/* Rationale */}
                      <div className="bg-gray-50 rounded-lg p-4">
                        <p className="text-xs font-medium text-gray-500 mb-2 flex items-center gap-1">
                          <Lightbulb size={12} /> Rationale
                        </p>
                        <p className="text-sm text-gray-700">
                          {decision.rationale || 'No rationale provided'}
                        </p>
                      </div>

                      {/* Outcome Metrics */}
                      {decision.outcomeMetrics && Object.keys(decision.outcomeMetrics).length > 0 && (
                        <div className="bg-gray-50 rounded-lg p-4">
                          <p className="text-xs font-medium text-gray-500 mb-2 flex items-center gap-1">
                            <BarChart3 size={12} /> Outcome Metrics
                          </p>
                          <div className="space-y-1">
                            {Object.entries(decision.outcomeMetrics).map(([key, val]) => (
                              <div
                                key={key}
                                className="flex items-center justify-between text-sm"
                              >
                                <span className="text-gray-500">
                                  {(key || '').replace(/_/g, ' ')}
                                </span>
                                <span className="text-gray-900 font-medium">
                                  {String(val)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Update Outcome */}
                      <div className="bg-gray-50 rounded-lg p-4">
                        <p className="text-xs font-medium text-gray-500 mb-2">
                          Update Outcome
                        </p>
                        {updatingOutcome === decision.id ? (
                          <div className="flex items-center gap-2">
                            <select
                              value={outcomeValue}
                              onChange={(e) => onOutcomeValueChange(e.target.value)}
                              className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
                            >
                              <option value="">Select outcome</option>
                              <option value="success">Success</option>
                              <option value="failed">Failed</option>
                              <option value="partial">Partial</option>
                              <option value="in_progress">In Progress</option>
                              <option value="pending">Pending</option>
                            </select>
                            <button
                              onClick={() => {
                                if (outcomeValue) {
                                  onUpdateOutcome(decision.id, outcomeValue);
                                }
                              }}
                              disabled={!outcomeValue}
                              className="p-1.5 text-[#059211] hover:bg-green-50 rounded disabled:opacity-50"
                            >
                              <Check size={16} />
                            </button>
                            <button
                              onClick={onCancelOutcomeUpdate}
                              className="p-1.5 text-gray-400 hover:bg-gray-100 rounded"
                            >
                              <X size={16} />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onStartOutcomeUpdate(decision.id);
                            }}
                            className="text-sm text-[#059211] hover:underline flex items-center gap-1"
                          >
                            <TrendingUp size={14} />
                            Set Outcome
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Memory Tab ----

function MemoryTab({
  items,
  categories,
  filter,
  searchQuery,
  showForm,
  form,
  submitting,
  onFilterChange,
  onSearchChange,
  onSearch,
  onShowForm,
  onHideForm,
  onFormChange,
  onSubmit,
}: {
  items: MemoryItem[];
  categories: MemoryCategory[];
  filter: string;
  searchQuery: string;
  showForm: boolean;
  form: MemoryForm;
  submitting: boolean;
  onFilterChange: (f: string) => void;
  onSearchChange: (s: string) => void;
  onSearch: () => void;
  onShowForm: () => void;
  onHideForm: () => void;
  onFormChange: (updates: Partial<MemoryForm>) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Category Overview */}
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {categories.map((cat) => (
            <button
              key={cat.category}
              onClick={() => onFilterChange(filter === cat.category ? '' : cat.category)}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                filter === cat.category
                  ? 'bg-[#059211] text-white border-[#059211]'
                  : CATEGORY_COLORS[cat.category] || 'bg-gray-100 text-gray-600 border-gray-200'
              } hover:shadow-sm`}
            >
              {(cat.category || '').replace(/_/g, ' ')}
              <span className={`px-1.5 py-0.5 rounded-full text-xs ${
                filter === cat.category ? 'bg-white/20' : 'bg-white/80'
              }`}>
                {cat.count}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSearch()}
              placeholder="Search memory..."
              className="pl-9 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211] w-64"
            />
          </div>
          <button
            onClick={onSearch}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-[#059211] border border-gray-300 rounded-lg hover:border-[#059211] transition-colors"
          >
            Search
          </button>
        </div>

        {!showForm && (
          <button
            onClick={onShowForm}
            className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] transition-colors text-sm font-medium"
          >
            <Plus size={16} />
            Add Memory
          </button>
        )}
      </div>

      {/* New Memory Form */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-md border-2 border-[#059211]/20 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Add Institutional Memory</h3>
            <button onClick={onHideForm} className="text-gray-400 hover:text-gray-600">
              <X size={20} />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Category */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <select
                value={form.category}
                onChange={(e) => onFormChange({ category: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              >
                <option value="market_insight">Market Insight</option>
                <option value="customer_feedback">Customer Feedback</option>
                <option value="competitor_analysis">Competitor Analysis</option>
                <option value="operational_learning">Operational Learning</option>
                <option value="technical_knowledge">Technical Knowledge</option>
                <option value="best_practice">Best Practice</option>
                <option value="failure_post_mortem">Failure Post-mortem</option>
                <option value="vendor_info">Vendor Info</option>
                <option value="regulatory">Regulatory</option>
              </select>
            </div>

            {/* Source */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
              <input
                type="text"
                value={form.source}
                onChange={(e) => onFormChange({ source: e.target.value })}
                placeholder="e.g., Customer survey, Team retro, Market report"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Title */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => onFormChange({ title: e.target.value })}
                placeholder="Brief title for this knowledge item"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>

            {/* Content */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Content</label>
              <textarea
                value={form.content}
                onChange={(e) => onFormChange({ content: e.target.value })}
                placeholder="Detail the knowledge, insight, or learning"
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211] resize-none"
              />
            </div>

            {/* Tags */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tags (comma-separated)
              </label>
              <input
                type="text"
                value={form.tags}
                onChange={(e) => onFormChange({ tags: e.target.value })}
                placeholder="e.g., pricing, delivery, customer-retention"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211]/30 focus:border-[#059211]"
              />
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
            <button
              onClick={onHideForm}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={onSubmit}
              disabled={submitting}
              className="flex items-center gap-2 px-6 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] transition-colors text-sm font-medium disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Save size={16} />
              )}
              Add Memory
            </button>
          </div>
        </div>
      )}

      {/* Memory Cards */}
      {items.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <Brain className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No institutional memory items found</p>
          <p className="text-sm text-gray-400 mt-1">
            Add knowledge, insights, and learnings to build organizational memory
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((item) => (
            <div
              key={item.id}
              className="bg-white rounded-xl shadow-md border-2 border-gray-100 hover:border-[#059211]/30 p-5 transition-all flex flex-col"
            >
              {/* Category + Access Count */}
              <div className="flex items-center justify-between mb-2">
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${
                    CATEGORY_COLORS[item.category] || 'bg-gray-100 text-gray-600 border-gray-200'
                  }`}
                >
                  {(item.category || '').replace(/_/g, ' ')}
                </span>
                <span className="flex items-center gap-1 text-xs text-gray-400" title="Access count">
                  <Eye size={12} />
                  {item.accessCount}
                </span>
              </div>

              {/* Title */}
              <h4 className="font-medium text-gray-900 mb-1">{item.title}</h4>

              {/* Content Preview */}
              <p className="text-sm text-gray-600 line-clamp-3 flex-1">{item.content}</p>

              {/* Source */}
              {item.source && (
                <div className="flex items-center gap-1 mt-2 text-xs text-gray-400">
                  <Archive size={12} />
                  {item.source}
                </div>
              )}

              {/* Tags */}
              {item.tags && item.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {item.tags.map((tag, i) => (
                    <span
                      key={i}
                      className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded text-xs"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Date */}
              <div className="flex items-center gap-1 mt-3 pt-2 border-t border-gray-100 text-xs text-gray-400">
                <Calendar size={12} />
                {formatDate(item.createdAt)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Helper Components ----

function StatsCard({
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
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

// ---- Helpers ----

function formatDate(dateStr: string): string {
  if (!dateStr) return 'Unknown';
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
