'use client';

import { useState, useEffect, useCallback } from 'react';
import { CreditCard, Calendar, CheckCircle, Clock, XCircle } from 'lucide-react';
import { nestjsVendorDashboard } from '@/lib/api/nestjs/vendor-dashboard';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';

interface DisbursementRow {
  id: number;
  date: string;
  amount: number;
  status: 'pending' | 'completed' | 'failed';
  method: string;
  reference: string;
  period_start: string;
  period_end: string;
  [key: string]: unknown;
}

function getDefaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 3);
  return {
    from: from.toISOString().split('T')[0],
    to: to.toISOString().split('T')[0],
  };
}

const statusConfig: Record<
  string,
  { icon: React.ComponentType<{ size?: number; className?: string }>; color: string; bg: string }
> = {
  completed: { icon: CheckCircle, color: 'text-green-700', bg: 'bg-green-100' },
  pending: { icon: Clock, color: 'text-yellow-700', bg: 'bg-yellow-100' },
  failed: { icon: XCircle, color: 'text-red-700', bg: 'bg-red-100' },
};

export default function VendorDisbursementReportPage() {
  const defaultRange = getDefaultDateRange();
  const [fromDate, setFromDate] = useState(defaultRange.from);
  const [toDate, setToDate] = useState(defaultRange.to);
  const [data, setData] = useState<DisbursementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await nestjsVendorDashboard.getDisbursementReport({
        from: fromDate,
        to: toDate,
      });
      if (res.success) {
        setData(res.data as unknown as DisbursementRow[]);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load disbursement report.'
      );
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const totalAmount = data
    .filter((r) => r.status === 'completed')
    .reduce((sum, row) => sum + (row.amount || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center">
          <CreditCard className="text-purple-600" size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Disbursement Report
          </h1>
          <p className="text-xs text-gray-500">
            Settlement history and payouts
          </p>
        </div>
      </div>

      {/* Date filters */}
      <div className="bg-white rounded-xl border p-4">
        <div className="flex flex-col sm:flex-row items-end gap-4">
          <div className="flex-1 w-full">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              From Date
            </label>
            <div className="relative">
              <Calendar
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
              />
            </div>
          </div>
          <div className="flex-1 w-full">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              To Date
            </label>
            <div className="relative">
              <Calendar
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
              />
            </div>
          </div>
          <button
            onClick={fetchReport}
            className="px-5 py-2 bg-[#059211] text-white rounded-lg text-sm font-semibold hover:bg-[#047a0e] transition-colors whitespace-nowrap"
          >
            Apply
          </button>
        </div>
      </div>

      {/* Summary */}
      {!loading && !error && data.length > 0 && (
        <div className="bg-white rounded-xl border p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">Total Disbursed</p>
              <p className="text-2xl font-bold text-gray-900">
                ₹{totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-500">Total Settlements</p>
              <p className="text-2xl font-bold text-gray-900">{data.length}</p>
            </div>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center min-h-[300px]">
          <LoadingSpinner size="lg" text="Loading report..." />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center min-h-[300px] gap-4">
          <p className="text-red-600 text-sm">{error}</p>
          <button
            onClick={fetchReport}
            className="px-4 py-2 bg-[#059211] text-white rounded-lg text-sm hover:bg-[#047a0e] transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Table */}
      {!loading && !error && (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="text-left px-4 py-3 font-semibold text-gray-700">
                    Date
                  </th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-700">
                    Period
                  </th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-700">
                    Method
                  </th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-700">
                    Reference
                  </th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-700">
                    Status
                  </th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-700">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center py-12 text-gray-400"
                    >
                      No disbursements for this period
                    </td>
                  </tr>
                ) : (
                  data.map((row, idx) => {
                    const sc = statusConfig[row.status] || statusConfig.pending;
                    const StatusIcon = sc.icon;
                    return (
                      <tr
                        key={row.id || idx}
                        className="border-b last:border-0 hover:bg-gray-50"
                      >
                        <td className="px-4 py-3 text-gray-900">
                          {row.date
                            ? new Date(row.date).toLocaleDateString('en-IN')
                            : '-'}
                        </td>
                        <td className="px-4 py-3 text-gray-600 text-xs">
                          {row.period_start && row.period_end
                            ? `${new Date(row.period_start).toLocaleDateString('en-IN')} - ${new Date(row.period_end).toLocaleDateString('en-IN')}`
                            : '-'}
                        </td>
                        <td className="px-4 py-3 text-gray-700 capitalize">
                          {row.method || '-'}
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs font-mono">
                          {row.reference || '-'}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${sc.bg} ${sc.color}`}
                          >
                            <StatusIcon size={12} />
                            {row.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-900">
                          ₹{(row.amount || 0).toFixed(2)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
