'use client';

import { useState, useEffect, useCallback } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3200';

interface SchedulerJob {
  jobName: string;
  enabled: boolean;
  cronExpression: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  runCount: number;
}

interface AutoAction {
  actionName: string;
  enabled: boolean;
  config: Record<string, any>;
  lastTriggeredAt: string | null;
  triggerCount: number;
}

interface HistoryEntry {
  id: string;
  job_name?: string;
  action_name?: string;
  status: string;
  duration_ms?: number;
  result: any;
  error: string | null;
  started_at?: string;
  triggered_at?: string;
}

const JOB_DESCRIPTIONS: Record<string, string> = {
  compute_health_scores: 'Compute customer health scores (RFM, churn risk, LTV)',
  compute_rider_tiers: 'Compute rider tier rankings (bronze/silver/gold)',
  compute_prep_times: 'Compute restaurant prep time predictions',
  compute_cohorts: 'Compute retention cohort analysis',
  analyze_complaints: 'Analyze complaint patterns from order reviews',
  generate_demand_forecast: 'Generate hourly demand forecast',
  find_reorder_candidates: 'Find users eligible for reorder nudge',
  check_weather_triggers: 'Check weather conditions for campaign triggers',
  check_event_triggers: 'Check upcoming events for campaign triggers',
};

const ACTION_DESCRIPTIONS: Record<string, string> = {
  churn_reengagement: 'High churn risk users get WhatsApp discount nudge',
  reorder_nudge: 'Users due for reorder get WhatsApp reminder',
  auto_refund_late: 'Late deliveries auto-credit wallet refund',
  weather_campaign: 'Weather-triggered WhatsApp campaign',
  festival_campaign: 'Festival-triggered themed campaign',
  slow_kitchen_alert: 'Alert admin when store avg prep > threshold',
};

function cronToHuman(cron: string): string {
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts;

  if (hour === '*/2') return 'Every 2 hours';
  if (dow === '0' && dom === '*') return `Weekly Sun ${hour}:${min.padStart(2, '0')}`;
  if (dom === '*' && dow === '*') return `Daily ${hour}:${min.padStart(2, '0')}`;
  return cron;
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500">Never run</span>;

  const colors: Record<string, string> = {
    success: 'bg-green-100 text-green-700',
    manual_success: 'bg-blue-100 text-blue-700',
    error: 'bg-red-100 text-red-700',
    manual_error: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${colors[status] || 'bg-gray-100 text-gray-500'}`}>
      {status}
    </span>
  );
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function SchedulerPage() {
  const [tab, setTab] = useState<'jobs' | 'actions'>('jobs');
  const [jobs, setJobs] = useState<SchedulerJob[]>([]);
  const [actions, setActions] = useState<AutoAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyTarget, setHistoryTarget] = useState<string | null>(null);
  const [editingConfig, setEditingConfig] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState('');

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/mos/scheduler/jobs`);
      if (res.ok) setJobs(await res.json());
    } catch (err) {
      console.error('Failed to fetch jobs:', err);
    }
  }, []);

  const fetchActions = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/mos/scheduler/actions`);
      if (res.ok) setActions(await res.json());
    } catch (err) {
      console.error('Failed to fetch actions:', err);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchJobs(), fetchActions()]).finally(() => setLoading(false));
  }, [fetchJobs, fetchActions]);

  const toggleJob = async (name: string) => {
    const res = await fetch(`${API}/api/mos/scheduler/jobs/${name}/toggle`, { method: 'PATCH' });
    if (res.ok) fetchJobs();
  };

  const runJob = async (name: string) => {
    setRunningJob(name);
    try {
      await fetch(`${API}/api/mos/scheduler/jobs/${name}/run`, { method: 'POST' });
      await fetchJobs();
    } finally {
      setRunningJob(null);
    }
  };

  const toggleAction = async (name: string) => {
    const res = await fetch(`${API}/api/mos/scheduler/actions/${name}/toggle`, { method: 'PATCH' });
    if (res.ok) fetchActions();
  };

  const loadHistory = async (type: 'jobs' | 'actions', name: string) => {
    setHistoryTarget(name);
    const endpoint = type === 'jobs' ? 'jobs' : 'actions';
    const res = await fetch(`${API}/api/mos/scheduler/${endpoint}/${name}/history?limit=10`);
    if (res.ok) setHistory(await res.json());
  };

  const saveConfig = async (name: string) => {
    try {
      const parsed = JSON.parse(configDraft);
      const res = await fetch(`${API}/api/mos/scheduler/actions/${name}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      if (res.ok) {
        setEditingConfig(null);
        fetchActions();
      }
    } catch {
      alert('Invalid JSON');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Scheduler & Auto-Actions</h1>
        <p className="text-gray-500 mt-1">Manage cron jobs and automated actions for mOS services</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Total Jobs</p>
          <p className="text-2xl font-bold">{jobs.length}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Jobs Enabled</p>
          <p className="text-2xl font-bold text-green-600">{jobs.filter(j => j.enabled).length}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Auto-Actions</p>
          <p className="text-2xl font-bold">{actions.length}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Actions Enabled</p>
          <p className="text-2xl font-bold text-orange-600">{actions.filter(a => a.enabled).length}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <nav className="flex gap-4">
          {(['jobs', 'actions'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setHistoryTarget(null); }}
              className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                tab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'jobs' ? 'Scheduled Jobs' : 'Auto-Actions'}
            </button>
          ))}
        </nav>
      </div>

      {/* Jobs Tab */}
      {tab === 'jobs' && (
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Job</th>
                <th className="px-4 py-3 text-left font-medium">Schedule</th>
                <th className="px-4 py-3 text-left font-medium">Last Run</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-center font-medium">Runs</th>
                <th className="px-4 py-3 text-center font-medium">Enabled</th>
                <th className="px-4 py-3 text-center font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {jobs.map((job) => (
                <tr key={job.jobName} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium text-gray-900">{(job.jobName || '').replace(/_/g, ' ')}</p>
                      <p className="text-xs text-gray-500">{JOB_DESCRIPTIONS[job.jobName] || ''}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    <span className="font-mono text-xs">{cronToHuman(job.cronExpression)}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{timeAgo(job.lastRunAt)}</td>
                  <td className="px-4 py-3"><StatusBadge status={job.lastStatus} /></td>
                  <td className="px-4 py-3 text-center text-gray-600">{job.runCount}</td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => toggleJob(job.jobName)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        job.enabled ? 'bg-blue-600' : 'bg-gray-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                          job.enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => runJob(job.jobName)}
                        disabled={runningJob === job.jobName}
                        className="px-3 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded border border-blue-200 disabled:opacity-50"
                      >
                        {runningJob === job.jobName ? 'Running...' : 'Run Now'}
                      </button>
                      <button
                        onClick={() => loadHistory('jobs', job.jobName)}
                        className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded"
                      >
                        History
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Actions Tab */}
      {tab === 'actions' && (
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Action</th>
                <th className="px-4 py-3 text-left font-medium">Config</th>
                <th className="px-4 py-3 text-left font-medium">Last Triggered</th>
                <th className="px-4 py-3 text-center font-medium">Triggers</th>
                <th className="px-4 py-3 text-center font-medium">Enabled</th>
                <th className="px-4 py-3 text-center font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {actions.map((action) => (
                <tr key={action.actionName} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium text-gray-900">{(action.actionName || '').replace(/_/g, ' ')}</p>
                      <p className="text-xs text-gray-500">{ACTION_DESCRIPTIONS[action.actionName] || ''}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {editingConfig === action.actionName ? (
                      <div className="flex flex-col gap-1">
                        <textarea
                          value={configDraft}
                          onChange={(e) => setConfigDraft(e.target.value)}
                          className="font-mono text-xs border rounded p-2 w-64 h-24"
                        />
                        <div className="flex gap-1">
                          <button
                            onClick={() => saveConfig(action.actionName)}
                            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingConfig(null)}
                            className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingConfig(action.actionName);
                          setConfigDraft(JSON.stringify(action.config, null, 2));
                        }}
                        className="font-mono text-xs text-gray-600 hover:text-blue-600 text-left max-w-[200px] truncate block"
                        title={JSON.stringify(action.config, null, 2)}
                      >
                        {JSON.stringify(action.config).slice(0, 40)}...
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{timeAgo(action.lastTriggeredAt)}</td>
                  <td className="px-4 py-3 text-center text-gray-600">{action.triggerCount}</td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => toggleAction(action.actionName)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        action.enabled ? 'bg-orange-500' : 'bg-gray-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                          action.enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => loadHistory('actions', action.actionName)}
                      className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded"
                    >
                      History
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* History Panel */}
      {historyTarget && (
        <div className="bg-white rounded-lg border p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-medium text-gray-900">
              History: {(historyTarget || '').replace(/_/g, ' ')}
            </h3>
            <button
              onClick={() => setHistoryTarget(null)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Close
            </button>
          </div>
          {history.length === 0 ? (
            <p className="text-sm text-gray-500">No history yet</p>
          ) : (
            <div className="space-y-2">
              {history.map((entry) => (
                <div key={entry.id} className="flex items-center gap-4 text-sm border-b pb-2">
                  <StatusBadge status={entry.status} />
                  <span className="text-gray-600">{entry.duration_ms ? `${entry.duration_ms}ms` : '-'}</span>
                  <span className="text-gray-500 text-xs flex-1">
                    {entry.result ? JSON.stringify(entry.result).slice(0, 80) : entry.error || '-'}
                  </span>
                  <span className="text-gray-400 text-xs whitespace-nowrap">
                    {timeAgo(entry.started_at || entry.triggered_at || null)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
