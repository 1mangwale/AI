'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, Zap, AlertCircle, CheckCircle, XCircle,
  Activity, DollarSign, Clock, Brain, Send, Loader2,
} from 'lucide-react';

interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  tier: number;
  costPer1kTokens: number;
  avgLatencyMs: number;
  successRate: number;
  capabilities: string[];
  maxTokens: number;
  isActive: boolean;
  circuitBreakerStatus: {
    failures: number;
    openUntil: string | null;
  };
}

interface RouterStats {
  modelUsage: Array<{ modelId: string; requests: number; avgLatency: number; successRate: number }>;
  costByTenant: Array<{ tenantId: number; totalCost: number }>;
  routingDecisions: Array<{ complexity: string; count: number }>;
}

interface TestResult {
  id: string;
  model: string;
  provider: string;
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  processingTimeMs: number;
  estimatedCost: number;
}

const TIER_COLORS: Record<number, string> = {
  1: 'bg-green-100 text-green-700',
  2: 'bg-blue-100 text-blue-700',
  3: 'bg-purple-100 text-purple-700',
};

const TIER_LABELS: Record<number, string> = {
  1: 'Fast/Cheap',
  2: 'Balanced',
  3: 'Premium',
};

const PROVIDER_COLORS: Record<string, string> = {
  vllm: 'bg-gray-100 text-gray-700',
  openai: 'bg-emerald-100 text-emerald-700',
  groq: 'bg-orange-100 text-orange-700',
  gemini: 'bg-blue-100 text-blue-700',
  anthropic: 'bg-amber-100 text-amber-700',
  deepseek: 'bg-cyan-100 text-cyan-700',
  grok: 'bg-red-100 text-red-700',
};

export default function ModelOrchestraPage() {
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [stats, setStats] = useState<RouterStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Test provider state
  const [testProvider, setTestProvider] = useState('');
  const [testPrompt, setTestPrompt] = useState('Summarize the benefits of food delivery in 2 sentences.');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [modelsRes, statsRes] = await Promise.all([
        fetch('/api/mos/models/orchestra').then(r => r.json()),
        fetch('/api/mos/models/orchestra/stats').then(r => r.json()),
      ]);
      setModels(modelsRes);
      setStats(statsRes);
    } catch (err: any) {
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleTest = async () => {
    if (!testProvider || !testPrompt) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/mos/models/orchestra/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: testProvider, prompt: testPrompt }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err: any) {
      setTestResult({ id: '', model: '', provider: testProvider, content: `Error: ${err.message}`, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, processingTimeMs: 0, estimatedCost: 0 });
    } finally {
      setTesting(false);
    }
  };

  const activeModels = models.filter(m => m.isActive);
  const inactiveModels = models.filter(m => !m.isActive);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Model Orchestra</h1>
          <p className="text-sm text-gray-500 mt-1">
            AI model routing, performance monitoring, and cost tracking
          </p>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="text-red-500" size={20} />
          <span className="text-red-700">{error}</span>
        </div>
      )}

      {/* Quick Stats */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
              <Brain size={16} /> Active Models
            </div>
            <p className="text-2xl font-bold">{activeModels.length}</p>
            <p className="text-xs text-gray-400">{inactiveModels.length} inactive</p>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
              <Activity size={16} /> Total Requests
            </div>
            <p className="text-2xl font-bold">
              {stats.modelUsage.reduce((sum, m) => sum + m.requests, 0).toLocaleString()}
            </p>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
              <Clock size={16} /> Avg Latency
            </div>
            <p className="text-2xl font-bold">
              {stats.modelUsage.length > 0
                ? Math.round(stats.modelUsage.reduce((sum, m) => sum + m.avgLatency, 0) / stats.modelUsage.length)
                : 0}ms
            </p>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center gap-2 text-gray-500 text-sm mb-1">
              <DollarSign size={16} /> Total Cost (30d)
            </div>
            <p className="text-2xl font-bold">
              ${stats.costByTenant.reduce((sum, t) => sum + t.totalCost, 0).toFixed(4)}
            </p>
          </div>
        </div>
      )}

      {/* Routing Decisions Distribution */}
      {stats && stats.routingDecisions.length > 0 && (
        <div className="bg-white rounded-lg border p-6">
          <h2 className="text-lg font-semibold mb-4">Routing by Complexity (Last 7 Days)</h2>
          <div className="flex gap-4">
            {stats.routingDecisions.map(d => {
              const total = stats.routingDecisions.reduce((s, r) => s + r.count, 0);
              const pct = total > 0 ? Math.round((d.count / total) * 100) : 0;
              const colors: Record<string, string> = {
                simple: 'bg-green-500',
                moderate: 'bg-blue-500',
                complex: 'bg-purple-500',
              };
              return (
                <div key={d.complexity} className="flex-1">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="capitalize font-medium">{d.complexity}</span>
                    <span className="text-gray-500">{d.count} ({pct}%)</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-3">
                    <div
                      className={`${colors[d.complexity] || 'bg-gray-500'} h-3 rounded-full`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Active Models */}
      <div className="bg-white rounded-lg border">
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold">Active Models ({activeModels.length})</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
          {activeModels.map(model => (
            <div key={model.id} className="border rounded-lg p-4 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-gray-900">{model.name}</h3>
                {model.circuitBreakerStatus.openUntil ? (
                  <span className="flex items-center gap-1 text-xs bg-red-100 text-red-700 px-2 py-1 rounded-full">
                    <XCircle size={12} /> Circuit Open
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">
                    <CheckCircle size={12} /> Active
                  </span>
                )}
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Provider</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${PROVIDER_COLORS[model.provider] || 'bg-gray-100'}`}>
                    {model.provider}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Tier</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${TIER_COLORS[model.tier]}`}>
                    {TIER_LABELS[model.tier]}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Cost/1K tokens</span>
                  <span className="font-mono">${model.costPer1kTokens}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Avg Latency</span>
                  <span className="font-mono">{model.avgLatencyMs}ms</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Success Rate</span>
                  <span className="font-mono">{(model.successRate * 100).toFixed(1)}%</span>
                </div>
                <div className="pt-2 flex flex-wrap gap-1">
                  {model.capabilities.map(cap => (
                    <span key={cap} className="px-2 py-0.5 bg-gray-50 border text-xs rounded-full text-gray-600">
                      {cap}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Inactive Models */}
      {inactiveModels.length > 0 && (
        <div className="bg-white rounded-lg border">
          <div className="p-4 border-b">
            <h2 className="text-lg font-semibold text-gray-500">Inactive Models ({inactiveModels.length})</h2>
            <p className="text-xs text-gray-400 mt-1">Configure API keys to activate</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
            {inactiveModels.map(model => (
              <div key={model.id} className="border rounded-lg p-4 opacity-60">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-gray-700">{model.name}</h3>
                  <span className="text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded-full">Inactive</span>
                </div>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Provider</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${PROVIDER_COLORS[model.provider] || 'bg-gray-100'}`}>
                      {model.provider}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Tier</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${TIER_COLORS[model.tier]}`}>
                      {TIER_LABELS[model.tier]}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Cost/1K tokens</span>
                    <span className="font-mono">${model.costPer1kTokens}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Model Usage Table */}
      {stats && stats.modelUsage.length > 0 && (
        <div className="bg-white rounded-lg border">
          <div className="p-4 border-b">
            <h2 className="text-lg font-semibold">Model Usage</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Model</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Requests</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Avg Latency</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Success Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {stats.modelUsage.map(m => (
                  <tr key={m.modelId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{m.modelId}</td>
                    <td className="px-4 py-3 text-right font-mono">{m.requests.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right font-mono">{m.avgLatency}ms</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`font-mono ${m.successRate >= 95 ? 'text-green-600' : m.successRate >= 80 ? 'text-yellow-600' : 'text-red-600'}`}>
                        {m.successRate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Test Provider */}
      <div className="bg-white rounded-lg border p-6">
        <h2 className="text-lg font-semibold mb-4">Test Provider</h2>
        <div className="flex gap-4 mb-4">
          <select
            value={testProvider}
            onChange={e => setTestProvider(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm bg-white"
          >
            <option value="">Select provider...</option>
            <option value="groq">Groq</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="deepseek">DeepSeek</option>
            <option value="grok">xAI Grok</option>
          </select>
          <input
            type="text"
            value={testPrompt}
            onChange={e => setTestPrompt(e.target.value)}
            placeholder="Enter test prompt..."
            className="flex-1 border rounded-lg px-3 py-2 text-sm"
          />
          <button
            onClick={handleTest}
            disabled={testing || !testProvider}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {testing ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            Test
          </button>
        </div>
        {testResult && (
          <div className="border rounded-lg p-4 bg-gray-50">
            <div className="flex justify-between text-xs text-gray-500 mb-2">
              <span>Model: {testResult.model} | Provider: {testResult.provider}</span>
              <span>{testResult.processingTimeMs}ms | {testResult.usage.totalTokens} tokens | ${(testResult.estimatedCost ?? 0).toFixed(6)}</span>
            </div>
            <p className="text-sm text-gray-800 whitespace-pre-wrap">{testResult.content}</p>
          </div>
        )}
      </div>
    </div>
  );
}
