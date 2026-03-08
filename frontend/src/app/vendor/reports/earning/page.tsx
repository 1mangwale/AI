'use client';

import { useState, useEffect, useCallback } from 'react';
import { DollarSign, Calendar, Download } from 'lucide-react';
import { nestjsVendorDashboard } from '@/lib/api/nestjs/vendor-dashboard';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import type { EarningReport } from '@/types/nestjs/api';

function getDefaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    from: from.toISOString().split('T')[0],
    to: to.toISOString().split('T')[0],
  };
}

export default function VendorEarningReportPage() {
  const defaultRange = getDefaultDateRange();
  const [fromDate, setFromDate] = useState(defaultRange.from);
  const [toDate, setToDate] = useState(defaultRange.to);
  const [data, setData] = useState<EarningReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await nestjsVendorDashboard.getEarningReport({
        from: fromDate,
        to: toDate,
      });
      if (res.success) {
        setData(res.data);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load earning report.'
      );
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const totals = data.reduce(
    (acc, row) => ({
      orders: acc.orders + row.orders,
      earning: acc.earning + row.earning,
      commission: acc.commission + row.commission,
      tax: acc.tax + row.tax,
      net_earning: acc.net_earning + row.net_earning,
    }),
    { orders: 0, earning: 0, commission: 0, tax: 0, net_earning: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
          <DollarSign className="text-green-600" size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Earning Report</h1>
          <p className="text-xs text-gray-500">
            Track your earnings and commissions
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
                  <th className="text-right px-4 py-3 font-semibold text-gray-700">
                    Orders
                  </th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-700">
                    Earning
                  </th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-700">
                    Commission
                  </th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-700">
                    Tax
                  </th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-700">
                    Net Earning
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
                      No data for this period
                    </td>
                  </tr>
                ) : (
                  <>
                    {data.map((row, idx) => (
                      <tr
                        key={idx}
                        className="border-b last:border-0 hover:bg-gray-50"
                      >
                        <td className="px-4 py-3 text-gray-900">
                          {new Date(row.date).toLocaleDateString('en-IN')}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-900">
                          {row.orders}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-900">
                          ₹{row.earning.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right text-red-600">
                          -₹{row.commission.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          ₹{row.tax.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-green-700">
                          ₹{row.net_earning.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                    {/* Totals row */}
                    <tr className="bg-gray-50 font-semibold border-t-2">
                      <td className="px-4 py-3 text-gray-900">Total</td>
                      <td className="px-4 py-3 text-right text-gray-900">
                        {totals.orders}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-900">
                        ₹{totals.earning.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right text-red-600">
                        -₹{totals.commission.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        ₹{totals.tax.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right text-green-700">
                        ₹{totals.net_earning.toFixed(2)}
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
