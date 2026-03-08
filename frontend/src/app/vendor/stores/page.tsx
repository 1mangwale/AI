'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Store as StoreIcon, MapPin, Star, ShoppingCart, Settings } from 'lucide-react';
import { nestjsStores } from '@/lib/api/nestjs/stores';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import type { Store } from '@/types/nestjs/api';

export default function VendorStoresPage() {
  const router = useRouter();
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchStores();
  }, []);

  const fetchStores = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await nestjsStores.vendor.myStores();
      if (res.success) {
        setStores(res.data);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load stores.'
      );
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" text="Loading stores..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-red-600 text-sm">{error}</p>
        <button
          onClick={fetchStores}
          className="px-4 py-2 bg-[#059211] text-white rounded-lg text-sm hover:bg-[#047a0e] transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">My Stores</h1>

      {stores.length === 0 ? (
        <div className="bg-white rounded-lg border p-12 text-center">
          <StoreIcon className="mx-auto mb-3 text-gray-300" size={48} />
          <p className="text-gray-500 text-sm">No stores found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {stores.map((store) => (
            <div
              key={store.id}
              className="bg-white rounded-xl border shadow-sm hover:shadow-md transition-shadow overflow-hidden"
            >
              {/* Cover / Logo area */}
              <div className="h-32 bg-gradient-to-br from-[#059211]/10 to-[#059211]/5 flex items-center justify-center relative">
                {store.logo ? (
                  <img
                    src={store.logo}
                    alt={store.name}
                    className="w-16 h-16 rounded-full object-cover border-2 border-white shadow"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-full bg-[#059211]/10 flex items-center justify-center">
                    <StoreIcon className="text-[#059211]" size={28} />
                  </div>
                )}
                <span
                  className={`absolute top-3 right-3 text-xs px-2 py-0.5 rounded-full font-medium ${
                    store.status && store.active
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-700'
                  }`}
                >
                  {store.status && store.active ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="p-4">
                <h3 className="text-base font-semibold text-gray-900 mb-1">
                  {store.name}
                </h3>

                <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-3">
                  <MapPin size={12} />
                  <span className="truncate">{store.address}</span>
                </div>

                <div className="flex items-center gap-4 mb-4">
                  <div className="flex items-center gap-1 text-xs text-gray-600">
                    <Star size={12} className="text-yellow-500" />
                    <span>
                      {store.avg_rating.toFixed(1)} ({store.rating_count})
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-gray-600">
                    <ShoppingCart size={12} />
                    <span>Min: ₹{store.minimum_order}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs mb-4">
                  {store.delivery && (
                    <span className="px-2 py-0.5 bg-blue-50 text-blue-600 rounded-full">
                      Delivery
                    </span>
                  )}
                  {store.take_away && (
                    <span className="px-2 py-0.5 bg-purple-50 text-purple-600 rounded-full">
                      Takeaway
                    </span>
                  )}
                  {store.schedule_order && (
                    <span className="px-2 py-0.5 bg-orange-50 text-orange-600 rounded-full">
                      Schedule
                    </span>
                  )}
                </div>

                <button
                  onClick={() => router.push(`/vendor/stores/${store.id}`)}
                  className="w-full flex items-center justify-center gap-2 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors"
                >
                  <Settings size={14} />
                  Manage Store
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
