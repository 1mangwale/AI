'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Save, ArrowLeft, Loader2 } from 'lucide-react';
import { nestjsStores } from '@/lib/api/nestjs/stores';
import { useToast } from '@/components/shared/Toast';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import type { Store } from '@/types/nestjs/api';

export default function VendorStoreConfigPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const storeId = Number(id);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Form fields
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [openingTime, setOpeningTime] = useState('');
  const [closingTime, setClosingTime] = useState('');
  const [delivery, setDelivery] = useState(false);
  const [takeAway, setTakeAway] = useState(false);
  const [scheduleOrder, setScheduleOrder] = useState(false);
  const [minimumOrder, setMinimumOrder] = useState(0);
  const [tax, setTax] = useState(0);
  const [deliveryTime, setDeliveryTime] = useState('');

  useEffect(() => {
    if (storeId) {
      fetchStore();
    }
  }, [storeId]);

  const fetchStore = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await nestjsStores.vendor.getStore(storeId);
      if (res.success && res.data) {
        const s = res.data;
        setName(s.name || '');
        setPhone(s.phone || '');
        setAddress(s.address || '');
        setOpeningTime(s.opening_time || '');
        setClosingTime(s.closing_time || '');
        setDelivery(s.delivery);
        setTakeAway(s.take_away);
        setScheduleOrder(s.schedule_order);
        setMinimumOrder(s.minimum_order);
        setTax(s.tax);
        setDeliveryTime(s.delivery_time || '');
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load store.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await nestjsStores.vendor.updateStore(storeId, {
        name,
        phone,
        address,
        opening_time: openingTime,
        closing_time: closingTime,
        delivery,
        take_away: takeAway,
        schedule_order: scheduleOrder,
        minimum_order: minimumOrder,
        tax,
        delivery_time: deliveryTime,
      } as Partial<Store>);
      if (res.success) {
        toast.success('Store updated successfully');
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to update store.'
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" text="Loading store..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-red-600 text-sm">{error}</p>
        <button
          onClick={fetchStore}
          className="px-4 py-2 bg-[#059211] text-white rounded-lg text-sm hover:bg-[#047a0e] transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push('/vendor/stores')}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Store Settings</h1>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border p-6 space-y-6">
        {/* Basic Info */}
        <div>
          <h2 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
            Basic Information
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Store Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Phone
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Address
              </label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
              />
            </div>
          </div>
        </div>

        {/* Timings */}
        <div>
          <h2 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
            Timings
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Opening Time
              </label>
              <input
                type="time"
                value={openingTime}
                onChange={(e) => setOpeningTime(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Closing Time
              </label>
              <input
                type="time"
                value={closingTime}
                onChange={(e) => setClosingTime(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Delivery Time
              </label>
              <input
                type="text"
                value={deliveryTime}
                onChange={(e) => setDeliveryTime(e.target.value)}
                placeholder="e.g. 30-45 min"
                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
              />
            </div>
          </div>
        </div>

        {/* Order Settings */}
        <div>
          <h2 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
            Order Settings
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Minimum Order (₹)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={minimumOrder}
                onChange={(e) => setMinimumOrder(Number(e.target.value))}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tax (%)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={tax}
                onChange={(e) => setTax(Number(e.target.value))}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
              />
            </div>
          </div>
        </div>

        {/* Toggles */}
        <div>
          <h2 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
            Service Options
          </h2>
          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={delivery}
                onChange={(e) => setDelivery(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-[#059211] focus:ring-[#059211]"
              />
              <span className="text-sm text-gray-700">
                Enable Delivery
              </span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={takeAway}
                onChange={(e) => setTakeAway(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-[#059211] focus:ring-[#059211]"
              />
              <span className="text-sm text-gray-700">
                Enable Takeaway
              </span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={scheduleOrder}
                onChange={(e) => setScheduleOrder(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-[#059211] focus:ring-[#059211]"
              />
              <span className="text-sm text-gray-700">
                Enable Schedule Order
              </span>
            </label>
          </div>
        </div>

        {/* Submit */}
        <div className="pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2.5 bg-[#059211] text-white rounded-lg text-sm font-semibold hover:bg-[#047a0e] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving ? (
              <Loader2 className="animate-spin" size={16} />
            ) : (
              <Save size={16} />
            )}
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
