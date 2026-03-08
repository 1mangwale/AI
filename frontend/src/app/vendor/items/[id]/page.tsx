'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { nestjsItems } from '@/lib/api/nestjs/items';
import { useToast } from '@/components/shared/Toast';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { ItemForm } from '@/components/vendor/ItemForm';
import type { Category, Item } from '@/types/nestjs/api';

export default function VendorEditItemPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const itemId = Number(id);

  const [item, setItem] = useState<Item | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (itemId) {
      fetchData();
    }
  }, [itemId]);

  const fetchData = async () => {
    setLoading(true);
    setError('');
    try {
      const [itemRes, catRes] = await Promise.all([
        nestjsItems.vendor.get(itemId),
        nestjsItems.getCategories(),
      ]);
      if (itemRes.success) {
        setItem(itemRes.data);
      }
      if (catRes.success) {
        setCategories(catRes.data);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load item data.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (data: Partial<Item>) => {
    setSaving(true);
    try {
      const res = await nestjsItems.vendor.update(itemId, data);
      if (res.success) {
        toast.success('Item updated successfully!');
        router.push('/vendor/items');
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to update item.'
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" text="Loading item..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-red-600 text-sm">{error}</p>
        <button
          onClick={fetchData}
          className="px-4 py-2 bg-[#059211] text-white rounded-lg text-sm hover:bg-[#047a0e] transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-gray-500 text-sm">Item not found</p>
        <button
          onClick={() => router.push('/vendor/items')}
          className="px-4 py-2 bg-[#059211] text-white rounded-lg text-sm hover:bg-[#047a0e] transition-colors"
        >
          Back to Items
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push('/vendor/items')}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Edit Item</h1>
      </div>

      <div className="bg-white rounded-xl border p-6">
        <ItemForm
          item={item}
          categories={categories}
          onSubmit={handleSubmit}
          loading={saving}
        />
      </div>
    </div>
  );
}
