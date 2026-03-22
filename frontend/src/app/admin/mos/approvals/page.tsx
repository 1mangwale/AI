'use client';

import { useState, useEffect } from 'react';
import {
  RefreshCw, CheckCircle, XCircle, Clock, AlertCircle,
  Filter, ChevronDown, ChevronUp, AlertTriangle, Inbox,
} from 'lucide-react';

interface ApprovalRequest {
  id: string;
  type: string;
  title: string;
  description: string | null;
  payload: Record<string, any>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  requestedBy: string | null;
  assignedTo: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNotes: string | null;
  createdAt: string;
}

interface ApprovalStats {
  pending: number;
  approvedToday: number;
  rejectedToday: number;
  avgResponseTimeHours: number;
  byType: { type: string; count: number }[];
  byPriority: { priority: string; count: number }[];
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700 border-red-200',
  high: 'bg-orange-100 text-orange-700 border-orange-200',
  normal: 'bg-blue-100 text-blue-700 border-blue-200',
  low: 'bg-gray-100 text-gray-600 border-gray-200',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  expired: 'bg-gray-100 text-gray-500',
};

const TYPE_COLORS: Record<string, string> = {
  campaign: 'bg-purple-100 text-purple-700',
  refund: 'bg-green-100 text-green-700',
  pricing: 'bg-blue-100 text-blue-700',
  rider_action: 'bg-orange-100 text-orange-700',
  ad_creative: 'bg-pink-100 text-pink-700',
  vendor_action: 'bg-cyan-100 text-cyan-700',
  reengagement: 'bg-amber-100 text-amber-700',
};

export default function ApprovalQueuePage() {
  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [stats, setStats] = useState<ApprovalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState({ status: 'pending', type: '', priority: '' });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (filter.status) params.set('status', filter.status);
      if (filter.type) params.set('type', filter.type);
      if (filter.priority) params.set('priority', filter.priority);

      const [queueRes, statsRes] = await Promise.all([
        fetch(`/api/approvals?${params}`).then(r => r.json()).catch(() => ({ items: [] })),
        fetch('/api/approvals/stats').then(r => r.json()).catch(() => null),
      ]);
      setItems(queueRes.items || []);
      setStats(statsRes);
    } catch (err: any) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [filter]);

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      await fetch(`/api/approvals/${id}/approve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decidedBy: 'admin', notes: actionNote || undefined }),
      });
      setActionNote('');
      setExpandedId(null);
      loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: string) => {
    if (!actionNote) {
      setError('Rejection reason is required');
      return;
    }
    setActionLoading(id);
    try {
      await fetch(`/api/approvals/${id}/reject`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decidedBy: 'admin', reason: actionNote }),
      });
      setActionNote('');
      setExpandedId(null);
      loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Approval Queue</h1>
          <p className="text-sm text-gray-500 mt-1">Review and approve AI-generated decisions</p>
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
          <AlertCircle className="text-red-500 flex-shrink-0" size={20} />
          <span className="text-red-700">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <XCircle size={16} />
          </button>
        </div>
      )}

      {/* Stats Bar */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center gap-2 text-yellow-600 text-sm mb-1">
              <Clock size={16} /> Pending
            </div>
            <p className="text-2xl font-bold">{stats.pending}</p>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center gap-2 text-green-600 text-sm mb-1">
              <CheckCircle size={16} /> Approved Today
            </div>
            <p className="text-2xl font-bold">{stats.approvedToday}</p>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center gap-2 text-red-600 text-sm mb-1">
              <XCircle size={16} /> Rejected Today
            </div>
            <p className="text-2xl font-bold">{stats.rejectedToday}</p>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center gap-2 text-blue-600 text-sm mb-1">
              <Clock size={16} /> Avg Response
            </div>
            <p className="text-2xl font-bold">{stats.avgResponseTimeHours}h</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <select
          value={filter.status}
          onChange={e => setFilter({ ...filter, status: e.target.value })}
          className="border rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <select
          value={filter.type}
          onChange={e => setFilter({ ...filter, type: e.target.value })}
          className="border rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value="">All Types</option>
          <option value="campaign">Campaign</option>
          <option value="refund">Refund</option>
          <option value="pricing">Pricing</option>
          <option value="rider_action">Rider Action</option>
          <option value="ad_creative">Ad Creative</option>
          <option value="vendor_action">Vendor Action</option>
          <option value="reengagement">Re-engagement</option>
        </select>
        <select
          value={filter.priority}
          onChange={e => setFilter({ ...filter, priority: e.target.value })}
          className="border rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value="">All Priority</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
      </div>

      {/* Approval Items */}
      <div className="space-y-3">
        {items.length === 0 && !loading && (
          <div className="bg-white rounded-lg border p-12 text-center">
            <Inbox className="mx-auto text-gray-300 mb-3" size={48} />
            <p className="text-gray-500">No approval requests found</p>
          </div>
        )}
        {items.map(item => (
          <div key={item.id} className={`bg-white rounded-lg border hover:shadow-sm transition-shadow ${item.priority === 'urgent' ? 'border-l-4 border-l-red-500' : item.priority === 'high' ? 'border-l-4 border-l-orange-500' : ''}`}>
            <div
              className="p-4 cursor-pointer"
              onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TYPE_COLORS[item.type] || 'bg-gray-100 text-gray-600'}`}>
                    {(item.type || '').replace('_', ' ')}
                  </span>
                  <h3 className="font-medium text-gray-900">{item.title}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${PRIORITY_COLORS[item.priority]}`}>
                    {item.priority}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[item.status]}`}>
                    {item.status}
                  </span>
                  <span className="text-xs text-gray-400">{timeAgo(item.createdAt)}</span>
                  {expandedId === item.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </div>
              {item.description && (
                <p className="text-sm text-gray-500 mt-1 line-clamp-1">{item.description}</p>
              )}
            </div>

            {expandedId === item.id && (
              <div className="border-t px-4 pb-4 pt-3">
                {item.description && (
                  <p className="text-sm text-gray-600 mb-3">{item.description}</p>
                )}
                <div className="bg-gray-50 rounded-lg p-3 mb-3">
                  <p className="text-xs font-medium text-gray-500 mb-1">Payload</p>
                  <pre className="text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify(item.payload, null, 2)}
                  </pre>
                </div>
                <div className="text-xs text-gray-400 mb-3 flex gap-4">
                  <span>Requested by: {item.requestedBy || 'System'}</span>
                  <span>Assigned to: {item.assignedTo || 'Unassigned'}</span>
                  {item.decidedBy && <span>Decided by: {item.decidedBy} at {new Date(item.decidedAt!).toLocaleString()}</span>}
                </div>
                {item.decisionNotes && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded p-2 mb-3">
                    <p className="text-xs text-yellow-700"><strong>Notes:</strong> {item.decisionNotes}</p>
                  </div>
                )}
                {item.status === 'pending' && (
                  <div className="flex gap-3 items-end">
                    <div className="flex-1">
                      <input
                        type="text"
                        value={actionNote}
                        onChange={e => setActionNote(e.target.value)}
                        placeholder="Notes/reason (required for reject)..."
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <button
                      onClick={() => handleApprove(item.id)}
                      disabled={actionLoading === item.id}
                      className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm"
                    >
                      <CheckCircle size={16} /> Approve
                    </button>
                    <button
                      onClick={() => handleReject(item.id)}
                      disabled={actionLoading === item.id}
                      className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm"
                    >
                      <XCircle size={16} /> Reject
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
