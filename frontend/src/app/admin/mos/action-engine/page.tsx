'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, AlertCircle, Image, FileText, DollarSign,
  Megaphone, Eye, MousePointer, ArrowUpRight, Play, Pause,
  CheckCircle, Clock, Send, Sparkles, Zap, Plus, X,
  Target, ShoppingCart, RotateCcw, ChevronRight,
} from 'lucide-react';
import { mangwaleAIClient } from '@/lib/api/mangwale-ai';

// ---- Types ----

interface AssetStats {
  totalAssets: number;
  imagesGenerated: number;
  copyGenerated: number;
  totalCost: number;
}

interface Asset {
  id: string;
  type: 'image' | 'copy';
  provider: string;
  prompt?: string;
  resultUrl?: string;
  resultText?: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  cost: number;
  createdAt: string;
}

interface ExecutionStats {
  totalAds: number;
  liveAds: number;
  pendingApproval: number;
  totalSpend: number;
}

interface AdExecution {
  id: string;
  platform: 'meta' | 'google' | 'whatsapp';
  adType: string;
  headline: string;
  bodyText: string;
  callToAction: string;
  dailyBudget: number;
  targetAudience: string;
  status: 'draft' | 'pending_approval' | 'approved' | 'live' | 'paused' | 'completed';
  impressions: number;
  clicks: number;
  conversions: number;
  createdAt: string;
}

type Tab = 'assets' | 'executions' | 'campaigns';

// ---- Status / Badge Helpers ----

const ASSET_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  generating: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

const ASSET_TYPE_COLORS: Record<string, string> = {
  image: 'bg-blue-100 text-blue-700',
  copy: 'bg-purple-100 text-purple-700',
};

const PROVIDER_COLORS: Record<string, string> = {
  dalle3: 'bg-green-100 text-green-700',
  gemini_imagen: 'bg-blue-100 text-blue-700',
  vllm: 'bg-gray-100 text-gray-700',
  placeholder: 'bg-yellow-100 text-yellow-700',
};

const PLATFORM_COLORS: Record<string, string> = {
  meta: 'bg-blue-100 text-blue-700',
  google: 'bg-red-100 text-red-700',
  whatsapp: 'bg-green-100 text-green-700',
};

const EXEC_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  pending_approval: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-blue-100 text-blue-700',
  live: 'bg-green-100 text-green-700',
  paused: 'bg-orange-100 text-orange-700',
  completed: 'bg-gray-100 text-gray-600',
};

// ---- Main Page ----

export default function ActionEnginePage() {
  const [activeTab, setActiveTab] = useState<Tab>('assets');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Asset Studio data
  const [assetStats, setAssetStats] = useState<AssetStats | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);

  // Ad Executions data
  const [execStats, setExecStats] = useState<ExecutionStats | null>(null);
  const [executions, setExecutions] = useState<AdExecution[]>([]);

  useEffect(() => {
    loadData();
  }, [activeTab]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      if (activeTab === 'assets') {
        const [stats, assetList] = await Promise.all([
          mangwaleAIClient.get<AssetStats>('/mos/action-engine/assets/stats'),
          mangwaleAIClient.get<Asset[]>('/mos/action-engine/assets'),
        ]);
        setAssetStats(stats);
        setAssets(assetList);
      } else if (activeTab === 'executions') {
        const [stats, execList] = await Promise.all([
          mangwaleAIClient.get<ExecutionStats>('/mos/action-engine/executions/stats'),
          mangwaleAIClient.get<AdExecution[]>('/mos/action-engine/executions'),
        ]);
        setExecStats(stats);
        setExecutions(execList);
      }
      // campaigns tab uses placeholder data, no API call
    } catch (err: any) {
      console.error('Failed to load action engine data:', err);
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'assets', label: 'Asset Studio', icon: <Sparkles size={16} /> },
    { id: 'executions', label: 'Ad Executions', icon: <Megaphone size={16} /> },
    { id: 'campaigns', label: 'Campaign Flows', icon: <Zap size={16} /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#059211] to-[#047a0e] rounded-2xl p-8 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Action Engine</h1>
            <p className="text-green-100">
              AI-powered creative generation, ad execution, and campaign automation
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
          {activeTab === 'assets' && (
            <AssetStudioTab
              stats={assetStats}
              assets={assets}
              onReload={loadData}
              onError={setError}
            />
          )}
          {activeTab === 'executions' && (
            <AdExecutionsTab
              stats={execStats}
              executions={executions}
              onReload={loadData}
              onError={setError}
            />
          )}
          {activeTab === 'campaigns' && (
            <CampaignFlowsTab onError={setError} />
          )}
        </>
      )}
    </div>
  );
}

// ---- Asset Studio Tab ----

function AssetStudioTab({
  stats,
  assets,
  onReload,
  onError,
}: {
  stats: AssetStats | null;
  assets: Asset[];
  onReload: () => void;
  onError: (msg: string) => void;
}) {
  const [showGenerateImage, setShowGenerateImage] = useState(false);
  const [showGenerateCopy, setShowGenerateCopy] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Image form
  const [imgPrompt, setImgPrompt] = useState('');
  const [imgProvider, setImgProvider] = useState('dalle3');
  const [imgSize, setImgSize] = useState('1024x1024');

  // Copy form
  const [copyProduct, setCopyProduct] = useState('');
  const [copyTone, setCopyTone] = useState('professional');
  const [copyPlatform, setCopyPlatform] = useState('whatsapp');

  const handleGenerateImage = async () => {
    if (!imgPrompt.trim()) return;
    setSubmitting(true);
    try {
      await mangwaleAIClient.post('/mos/action-engine/assets/generate', {
        prompt: imgPrompt,
        provider: imgProvider,
        size: imgSize,
      });
      setShowGenerateImage(false);
      setImgPrompt('');
      onReload();
    } catch (err: any) {
      onError(err.message || 'Failed to generate image');
    } finally {
      setSubmitting(false);
    }
  };

  const handleGenerateCopy = async () => {
    if (!copyProduct.trim()) return;
    setSubmitting(true);
    try {
      await mangwaleAIClient.post('/mos/action-engine/assets/copy', {
        product: copyProduct,
        tone: copyTone,
        platform: copyPlatform,
      });
      setShowGenerateCopy(false);
      setCopyProduct('');
      onReload();
    } catch (err: any) {
      onError(err.message || 'Failed to generate copy');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            icon={<Sparkles size={22} />}
            label="Total Assets"
            value={stats.totalAssets.toLocaleString('en-IN')}
            color="green"
          />
          <StatCard
            icon={<Image size={22} />}
            label="Images Generated"
            value={stats.imagesGenerated.toLocaleString('en-IN')}
            color="blue"
          />
          <StatCard
            icon={<FileText size={22} />}
            label="Copy Generated"
            value={stats.copyGenerated.toLocaleString('en-IN')}
            color="purple"
          />
          <StatCard
            icon={<DollarSign size={22} />}
            label="Total Cost (INR)"
            value={formatCurrency(stats.totalCost)}
            color="orange"
          />
        </div>
      )}

      {/* Actions Bar */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => { setShowGenerateImage(!showGenerateImage); setShowGenerateCopy(false); }}
          className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all"
        >
          <Image size={16} />
          Generate Image
        </button>
        <button
          onClick={() => { setShowGenerateCopy(!showGenerateCopy); setShowGenerateImage(false); }}
          className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all"
        >
          <FileText size={16} />
          Generate Copy
        </button>
      </div>

      {/* Generate Image Form */}
      {showGenerateImage && (
        <div className="bg-white rounded-xl shadow-md border-2 border-[#059211]/30 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Image className="text-[#059211]" size={20} />
              Generate Image
            </h3>
            <button onClick={() => setShowGenerateImage(false)} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-all">
              <X size={20} />
            </button>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Prompt</label>
              <textarea
                value={imgPrompt}
                onChange={(e) => setImgPrompt(e.target.value)}
                rows={3}
                placeholder="Describe the image you want to generate..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                <select
                  value={imgProvider}
                  onChange={(e) => setImgProvider(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                >
                  <option value="dalle3">DALL-E 3</option>
                  <option value="gemini_imagen">Gemini Imagen</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Size</label>
                <select
                  value={imgSize}
                  onChange={(e) => setImgSize(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                >
                  <option value="1024x1024">1024x1024 (Square)</option>
                  <option value="1024x1792">1024x1792 (Portrait)</option>
                  <option value="1792x1024">1792x1024 (Landscape)</option>
                </select>
              </div>
            </div>
            <button
              onClick={handleGenerateImage}
              disabled={submitting || !imgPrompt.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all disabled:opacity-50"
            >
              {submitting ? <RefreshCw size={16} className="animate-spin" /> : <Sparkles size={16} />}
              {submitting ? 'Generating...' : 'Generate'}
            </button>
          </div>
        </div>
      )}

      {/* Generate Copy Form */}
      {showGenerateCopy && (
        <div className="bg-white rounded-xl shadow-md border-2 border-[#059211]/30 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <FileText className="text-[#059211]" size={20} />
              Generate Copy
            </h3>
            <button onClick={() => setShowGenerateCopy(false)} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-all">
              <X size={20} />
            </button>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Product Name</label>
              <input
                type="text"
                value={copyProduct}
                onChange={(e) => setCopyProduct(e.target.value)}
                placeholder="e.g. Chicken Biryani, Fresh Vegetables"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tone</label>
                <select
                  value={copyTone}
                  onChange={(e) => setCopyTone(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                >
                  <option value="professional">Professional</option>
                  <option value="casual">Casual</option>
                  <option value="fun">Fun</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Platform</label>
                <select
                  value={copyPlatform}
                  onChange={(e) => setCopyPlatform(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                >
                  <option value="whatsapp">WhatsApp</option>
                  <option value="instagram">Instagram</option>
                  <option value="facebook">Facebook</option>
                  <option value="google">Google</option>
                </select>
              </div>
            </div>
            <button
              onClick={handleGenerateCopy}
              disabled={submitting || !copyProduct.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all disabled:opacity-50"
            >
              {submitting ? <RefreshCw size={16} className="animate-spin" /> : <FileText size={16} />}
              {submitting ? 'Generating...' : 'Generate'}
            </button>
          </div>
        </div>
      )}

      {/* Asset List */}
      {assets.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <Sparkles className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No assets generated yet</p>
          <p className="text-sm text-gray-400 mt-1">
            Use the buttons above to generate images or copy
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
          <div className="p-4 border-b">
            <h3 className="text-lg font-bold text-gray-900">
              Assets ({assets.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Type</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Provider</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Content</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Cost (INR)</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Created</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${ASSET_TYPE_COLORS[asset.type] || 'bg-gray-100 text-gray-600'}`}>
                        {asset.type}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${PROVIDER_COLORS[asset.provider] || 'bg-gray-100 text-gray-600'}`}>
                        {asset.provider}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      {asset.type === 'image' ? (
                        <span className="text-gray-600 text-xs truncate block" title={asset.resultUrl}>
                          {asset.resultUrl ? truncateText(asset.resultUrl, 60) : asset.prompt ? truncateText(asset.prompt, 60) : '--'}
                        </span>
                      ) : (
                        <span className="text-gray-600 text-xs line-clamp-2" title={asset.resultText}>
                          {asset.resultText ? truncateText(asset.resultText, 80) : asset.prompt ? truncateText(asset.prompt, 80) : '--'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ASSET_STATUS_COLORS[asset.status] || 'bg-gray-100 text-gray-600'}`}>
                        {asset.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700 font-medium">
                      {formatCurrency(asset.cost)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500 text-xs">
                      {timeAgo(asset.createdAt)}
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

// ---- Ad Executions Tab ----

function AdExecutionsTab({
  stats,
  executions,
  onReload,
  onError,
}: {
  stats: ExecutionStats | null;
  executions: AdExecution[];
  onReload: () => void;
  onError: (msg: string) => void;
}) {
  const [showCreateAd, setShowCreateAd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Create ad form
  const [adPlatform, setAdPlatform] = useState('meta');
  const [adType, setAdType] = useState('image');
  const [adHeadline, setAdHeadline] = useState('');
  const [adBody, setAdBody] = useState('');
  const [adCta, setAdCta] = useState('Order Now');
  const [adBudget, setAdBudget] = useState(500);
  const [adAudience, setAdAudience] = useState('');

  const handleCreateAd = async () => {
    if (!adHeadline.trim()) return;
    setSubmitting(true);
    try {
      await mangwaleAIClient.post('/mos/action-engine/executions', {
        platform: adPlatform,
        adType,
        headline: adHeadline,
        bodyText: adBody,
        callToAction: adCta,
        dailyBudget: adBudget,
        targetAudience: adAudience,
      });
      setShowCreateAd(false);
      setAdHeadline('');
      setAdBody('');
      setAdAudience('');
      onReload();
    } catch (err: any) {
      onError(err.message || 'Failed to create ad');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAction = async (id: string, action: string) => {
    setActionLoading(id);
    try {
      if (action === 'submit-approval') {
        await mangwaleAIClient.post(`/mos/action-engine/executions/${id}/submit-approval`, {});
      } else if (action === 'approve') {
        await mangwaleAIClient.post(`/mos/action-engine/executions/${id}/approve`, { decidedBy: 'admin' });
      } else if (action === 'publish') {
        await mangwaleAIClient.post(`/mos/action-engine/executions/${id}/publish`, {});
      } else if (action === 'pause') {
        await mangwaleAIClient.patch(`/mos/action-engine/executions/${id}/pause`, {});
      } else if (action === 'resume') {
        await mangwaleAIClient.patch(`/mos/action-engine/executions/${id}/resume`, {});
      }
      onReload();
    } catch (err: any) {
      onError(err.message || `Failed to ${action}`);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            icon={<Megaphone size={22} />}
            label="Total Ads"
            value={stats.totalAds.toLocaleString('en-IN')}
            color="blue"
          />
          <StatCard
            icon={<Play size={22} />}
            label="Live Ads"
            value={stats.liveAds.toLocaleString('en-IN')}
            color="green"
          />
          <StatCard
            icon={<Clock size={22} />}
            label="Pending Approval"
            value={stats.pendingApproval.toLocaleString('en-IN')}
            color="orange"
          />
          <StatCard
            icon={<DollarSign size={22} />}
            label="Total Spend"
            value={formatCurrency(stats.totalSpend)}
            color="purple"
          />
        </div>
      )}

      {/* Create Ad Button */}
      <div>
        <button
          onClick={() => setShowCreateAd(!showCreateAd)}
          className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all"
        >
          <Plus size={16} />
          Create Ad
        </button>
      </div>

      {/* Create Ad Form */}
      {showCreateAd && (
        <div className="bg-white rounded-xl shadow-md border-2 border-[#059211]/30 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Megaphone className="text-[#059211]" size={20} />
              Create Ad Execution
            </h3>
            <button onClick={() => setShowCreateAd(false)} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-all">
              <X size={20} />
            </button>
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Platform</label>
                <select
                  value={adPlatform}
                  onChange={(e) => setAdPlatform(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                >
                  <option value="meta">Meta (Facebook/Instagram)</option>
                  <option value="google">Google Ads</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ad Type</label>
                <select
                  value={adType}
                  onChange={(e) => setAdType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                >
                  <option value="image">Image</option>
                  <option value="carousel">Carousel</option>
                  <option value="story">Story</option>
                  <option value="search">Search</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Headline</label>
              <input
                type="text"
                value={adHeadline}
                onChange={(e) => setAdHeadline(e.target.value)}
                placeholder="e.g. Fresh Biryani Delivered in 30 Minutes"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Body Text</label>
              <textarea
                value={adBody}
                onChange={(e) => setAdBody(e.target.value)}
                rows={3}
                placeholder="Ad body text..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Call to Action</label>
                <input
                  type="text"
                  value={adCta}
                  onChange={(e) => setAdCta(e.target.value)}
                  placeholder="e.g. Order Now"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Daily Budget (INR)</label>
                <input
                  type="number"
                  value={adBudget}
                  onChange={(e) => setAdBudget(parseInt(e.target.value, 10) || 0)}
                  min={0}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Audience</label>
              <textarea
                value={adAudience}
                onChange={(e) => setAdAudience(e.target.value)}
                rows={2}
                placeholder='e.g. 18-35, Raipur, food lovers'
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
              />
            </div>
            <button
              onClick={handleCreateAd}
              disabled={submitting || !adHeadline.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all disabled:opacity-50"
            >
              {submitting ? <RefreshCw size={16} className="animate-spin" /> : <Plus size={16} />}
              {submitting ? 'Creating...' : 'Create Ad'}
            </button>
          </div>
        </div>
      )}

      {/* Executions Table */}
      {executions.length === 0 ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-12 text-center">
          <Megaphone className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-500">No ad executions yet</p>
          <p className="text-sm text-gray-400 mt-1">
            Create your first ad to get started
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
          <div className="p-4 border-b">
            <h3 className="text-lg font-bold text-gray-900">
              Executions ({executions.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Platform</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Headline</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Budget/day</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Impressions</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Clicks</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">CTR%</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Conv.</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((exec) => {
                  const ctr = exec.impressions > 0
                    ? (exec.clicks / exec.impressions) * 100
                    : 0;

                  return (
                    <tr key={exec.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${PLATFORM_COLORS[exec.platform] || 'bg-gray-100 text-gray-600'}`}>
                          {exec.platform}
                        </span>
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <span className="text-gray-900 font-medium truncate block" title={exec.headline}>
                          {truncateText(exec.headline, 40)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${EXEC_STATUS_COLORS[exec.status] || 'bg-gray-100 text-gray-600'}`}>
                          {exec.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700 font-medium">
                        {formatCurrency(exec.dailyBudget)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        {exec.impressions.toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        {exec.clicks.toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        {(ctr ?? 0).toFixed(1)}%
                      </td>
                      <td className="px-4 py-3 text-right text-gray-900 font-medium">
                        {exec.conversions.toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {actionLoading === exec.id ? (
                          <RefreshCw size={14} className="animate-spin text-[#059211] mx-auto" />
                        ) : (
                          <ExecutionActionButton
                            status={exec.status}
                            onAction={(action) => handleAction(exec.id, action)}
                          />
                        )}
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

// ---- Execution Action Button ----

function ExecutionActionButton({
  status,
  onAction,
}: {
  status: string;
  onAction: (action: string) => void;
}) {
  switch (status) {
    case 'draft':
      return (
        <button
          onClick={() => onAction('submit-approval')}
          className="flex items-center gap-1 px-2 py-1 bg-yellow-50 text-yellow-700 rounded text-xs font-medium hover:bg-yellow-100 transition-all mx-auto"
          title="Submit for Approval"
        >
          <Send size={12} />
          Submit
        </button>
      );
    case 'pending_approval':
      return (
        <button
          onClick={() => onAction('approve')}
          className="flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs font-medium hover:bg-blue-100 transition-all mx-auto"
          title="Approve"
        >
          <CheckCircle size={12} />
          Approve
        </button>
      );
    case 'approved':
      return (
        <button
          onClick={() => onAction('publish')}
          className="flex items-center gap-1 px-2 py-1 bg-green-50 text-green-700 rounded text-xs font-medium hover:bg-green-100 transition-all mx-auto"
          title="Publish"
        >
          <ArrowUpRight size={12} />
          Publish
        </button>
      );
    case 'live':
      return (
        <button
          onClick={() => onAction('pause')}
          className="flex items-center gap-1 px-2 py-1 bg-orange-50 text-orange-700 rounded text-xs font-medium hover:bg-orange-100 transition-all mx-auto"
          title="Pause"
        >
          <Pause size={12} />
          Pause
        </button>
      );
    case 'paused':
      return (
        <button
          onClick={() => onAction('resume')}
          className="flex items-center gap-1 px-2 py-1 bg-green-50 text-green-700 rounded text-xs font-medium hover:bg-green-100 transition-all mx-auto"
          title="Resume"
        >
          <Play size={12} />
          Resume
        </button>
      );
    default:
      return <span className="text-xs text-gray-400">--</span>;
  }
}

// ---- Campaign Flows Tab ----

interface CartRecoveryStats {
  nudgesSent: number;
  conversions: number;
  discountCodesUsed: number;
  totalRuns: number;
}

interface FlowRun {
  id: string;
  flowName: string;
  sessionId: string;
  status: string;
  currentStep: string;
  startedAt: string;
  completedAt: string | null;
}

function CampaignFlowsTab({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const [showTriggerForm, setShowTriggerForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cartStats, setCartStats] = useState<CartRecoveryStats | null>(null);
  const [flowRuns, setFlowRuns] = useState<FlowRun[]>([]);
  const [testPhone, setTestPhone] = useState('');
  const [testingCart, setTestingCart] = useState(false);
  const [statsLoading, setStatsLoading] = useState(true);

  // Trigger form
  const [campName, setCampName] = useState('');
  const [campProduct, setCampProduct] = useState('');
  const [campPlatform, setCampPlatform] = useState('meta');
  const [campTone, setCampTone] = useState('professional');
  const [campBudget, setCampBudget] = useState(500);
  const [campPhone, setCampPhone] = useState('');

  useEffect(() => {
    loadCampaignData();
  }, []);

  const loadCampaignData = async () => {
    setStatsLoading(true);
    try {
      const [stats, runs] = await Promise.all([
        mangwaleAIClient.get<CartRecoveryStats>('/mos/action-engine/campaigns/cart-recovery-stats'),
        mangwaleAIClient.get<FlowRun[]>('/mos/action-engine/flow-runs?limit=20'),
      ]);
      setCartStats(stats);
      setFlowRuns(runs);
    } catch (err: any) {
      console.error('Failed to load campaign data:', err);
    } finally {
      setStatsLoading(false);
    }
  };

  const handleTestCartRecovery = async () => {
    if (!testPhone.trim()) return;
    setTestingCart(true);
    try {
      const result = await mangwaleAIClient.post<any>('/mos/action-engine/campaigns/test-cart-recovery', {
        phone: testPhone,
      });
      if (result.success) {
        setTestPhone('');
        loadCampaignData();
      } else {
        onError(result.error || 'Cart recovery test failed');
      }
    } catch (err: any) {
      onError(err.message || 'Failed to test cart recovery');
    } finally {
      setTestingCart(false);
    }
  };

  const handleTrigger = async () => {
    if (!campName.trim() || !campProduct.trim()) return;
    setSubmitting(true);
    try {
      await mangwaleAIClient.post('/mos/action-engine/campaigns/trigger', {
        name: campName,
        product: campProduct,
        platform: campPlatform,
        tone: campTone,
        dailyBudget: campBudget,
        adminPhone: campPhone,
      });
      setShowTriggerForm(false);
      setCampName('');
      setCampProduct('');
      setCampPhone('');
    } catch (err: any) {
      onError(err.message || 'Failed to trigger campaign');
    } finally {
      setSubmitting(false);
    }
  };

  const pipelineSteps = [
    'Detect Trend',
    'Generate Creative',
    'Review',
    'Approve',
    'Publish',
  ];

  return (
    <div className="space-y-6">
      {/* Overview Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          icon={<Target size={22} />}
          label="Cart Nudges Sent"
          value={cartStats ? cartStats.nudgesSent.toLocaleString('en-IN') : '...'}
          color="blue"
        />
        <StatCard
          icon={<ShoppingCart size={22} />}
          label="Cart Conversions"
          value={cartStats ? cartStats.conversions.toLocaleString('en-IN') : '...'}
          color="green"
        />
        <StatCard
          icon={<ArrowUpRight size={22} />}
          label="Discounts Used"
          value={cartStats ? cartStats.discountCodesUsed.toLocaleString('en-IN') : '...'}
          color="purple"
        />
      </div>

      {/* Campaign Action Pipeline */}
      <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-2 flex items-center gap-2">
          <Zap className="text-[#059211]" size={20} />
          Campaign Action Pipeline
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          Automated pipeline: Trend detection, creative generation, review, approval, and publish
        </p>

        {/* Pipeline Visualization */}
        <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-2">
          {pipelineSteps.map((step, idx) => (
            <div key={step} className="flex items-center">
              <span className="px-3 py-1.5 bg-[#059211]/10 text-[#059211] rounded-full text-xs font-medium whitespace-nowrap">
                {step}
              </span>
              {idx < pipelineSteps.length - 1 && (
                <ChevronRight size={16} className="text-gray-400 mx-1 flex-shrink-0" />
              )}
            </div>
          ))}
        </div>

        {/* Trigger Button */}
        <button
          onClick={() => setShowTriggerForm(!showTriggerForm)}
          className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all"
        >
          <Zap size={16} />
          Trigger New Campaign
        </button>

        {/* Trigger Form */}
        {showTriggerForm && (
          <div className="mt-4 border-t pt-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Campaign Name</label>
                <input
                  type="text"
                  value={campName}
                  onChange={(e) => setCampName(e.target.value)}
                  placeholder="e.g. Weekend Biryani Blitz"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Product Name</label>
                <input
                  type="text"
                  value={campProduct}
                  onChange={(e) => setCampProduct(e.target.value)}
                  placeholder="e.g. Chicken Biryani"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Platform</label>
                <select
                  value={campPlatform}
                  onChange={(e) => setCampPlatform(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                >
                  <option value="meta">Meta</option>
                  <option value="google">Google</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tone</label>
                <select
                  value={campTone}
                  onChange={(e) => setCampTone(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                >
                  <option value="professional">Professional</option>
                  <option value="casual">Casual</option>
                  <option value="fun">Fun</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Daily Budget (INR)</label>
                <input
                  type="number"
                  value={campBudget}
                  onChange={(e) => setCampBudget(parseInt(e.target.value, 10) || 0)}
                  min={0}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Admin Phone (for notifications)</label>
              <input
                type="text"
                value={campPhone}
                onChange={(e) => setCampPhone(e.target.value)}
                placeholder="e.g. +919876543210"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent"
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleTrigger}
                disabled={submitting || !campName.trim() || !campProduct.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all disabled:opacity-50"
              >
                {submitting ? <RefreshCw size={16} className="animate-spin" /> : <Zap size={16} />}
                {submitting ? 'Triggering...' : 'Trigger Campaign'}
              </button>
              <button
                onClick={() => setShowTriggerForm(false)}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Cart Recovery Section */}
      <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-2 flex items-center gap-2">
          <RotateCcw className="text-[#059211]" size={20} />
          Cart Recovery
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          Automated abandoned cart recovery via WhatsApp nudge with discount incentive
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-xs text-gray-500 mb-1">Nudges Sent</p>
            <p className="text-xl font-bold text-gray-900">
              {statsLoading ? '...' : cartStats?.nudgesSent ?? 0}
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-xs text-gray-500 mb-1">Conversions</p>
            <p className="text-xl font-bold text-green-600">
              {statsLoading ? '...' : cartStats?.conversions ?? 0}
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <p className="text-xs text-gray-500 mb-1">Discount Codes Used</p>
            <p className="text-xl font-bold text-blue-600">
              {statsLoading ? '...' : cartStats?.discountCodesUsed ?? 0}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="text"
            value={testPhone}
            onChange={(e) => setTestPhone(e.target.value)}
            placeholder="+919876543210"
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#059211] focus:border-transparent w-48"
          />
          <button
            onClick={handleTestCartRecovery}
            disabled={testingCart || !testPhone.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-[#059211] text-white rounded-lg hover:bg-[#047a0e] text-sm font-medium transition-all disabled:opacity-50"
          >
            {testingCart ? <RefreshCw size={16} className="animate-spin" /> : <ShoppingCart size={16} />}
            {testingCart ? 'Testing...' : 'Test Cart Recovery'}
          </button>
        </div>
      </div>

      {/* Recent Flow Executions */}
      <div className="bg-white rounded-xl shadow-md border-2 border-gray-100 overflow-hidden">
        <div className="p-4 border-b">
          <h3 className="text-lg font-bold text-gray-900">
            Recent Flow Executions ({flowRuns.length})
          </h3>
        </div>
        {flowRuns.length === 0 ? (
          <div className="p-12 text-center">
            <Zap className="mx-auto text-gray-300 mb-3" size={48} />
            <p className="text-gray-500">No flow executions yet</p>
            <p className="text-sm text-gray-400 mt-1">
              Trigger a campaign to see flow executions here
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Flow</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Session</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Current Step</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Started</th>
                </tr>
              </thead>
              <tbody>
                {flowRuns.map((run) => (
                  <tr key={run.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {run.flowName}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs font-mono">
                      {truncateText(run.sessionId || '', 16)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        run.status === 'completed' ? 'bg-green-100 text-green-700' :
                        run.status === 'active' ? 'bg-blue-100 text-blue-700' :
                        run.status === 'failed' ? 'bg-red-100 text-red-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {run.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs">
                      {run.currentStep || '--'}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500 text-xs">
                      {timeAgo(run.startedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
