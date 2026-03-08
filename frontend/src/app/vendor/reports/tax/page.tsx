'use client';

import { useState, useEffect, useCallback } from 'react';
import { FileText, Calendar } from 'lucide-react';
import { nestjsVendorDashboard } from '@/lib/api/nestjs/vendor-dashboard';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';

interface TaxRow {
  date: string;
  orders: number;
  taxable_amount: number;
  cgst: number;
  sgst: number;
  igst: number;
  total_tax: number;
  [key: string]: unknown;
}

function getDefaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    from: from.toISOString().split('T')[0],
    to: to.toISOString().split('T')[0],
  };
}

export default function VendorTaxReportPage() {
  const defaultRange = getDefaultDateRange();
  const [fromDate, setFromDate] = useState(defaultRange.from);
  const [toDate, setToDate] = useState(defaultRange.to);
  const [data, setData] = useState<TaxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await nestjsVendorDashboard.getTaxReport({
        from: fromDate,
        to: toDate,
      });
      if (res.success) {
        setData(res.data as unknown as TaxRow[]);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load tax report.'
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
      orders: acc.orders + (row.orders || 0),
      taxable_amount: acc.taxable_amount + (row.taxable_amount || 0),
      cgst: acc.cgst + (row.cgst || 0),
      sgst: acc.sgst + (row.sgst || 0),
      igst: acc.igst + (row.igst || 0),
      total_tax: acc.total_tax + (row.total_tax || 0),
    }),
    { orders: 0, taxable_amount: 0, cgst: 0, sgst: 0, igst: 0, total_tax: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
          <FileText className="text-blue-600" size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tax / GST Report</h1>
          <p className="text-xs text-gray-500">
            CGST, SGST, and IGST breakdown
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
                    Taxable Amount
                  </th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-700">
                    CGST
                  </th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-700">
                    SGST
                  </th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-700">
                    IGST
                  </th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-700">
                    Total Tax
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="text-center py-12 text-gray-400"
                    >
                      No tax data for this period
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
                          {row.date
                            ? new Date(row.date).toLocaleDateString('en-IN')
                            : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-900">
                          {row.orders || 0}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-900">
                          ₹{(row.taxable_amount || 0).toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          ₹{(row.cgst || 0).toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          ₹{(row.sgst || 0).toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          ₹{(row.igst || 0).toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-blue-700">
                          ₹{(row.total_tax || 0).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-gray-50 font-semibold border-t-2">
                      <td className="px-4 py-3 text-gray-900">Total</td>
                      <td className="px-4 py-3 text-right text-gray-900">
                        {totals.orders}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-900">
                        ₹{totals.taxable_amount.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        ₹{totals.cgst.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        ₹{totals.sgst.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        ₹{totals.igst.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right text-blue-700">
                        ₹{totals.total_tax.toFixed(2)}
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
