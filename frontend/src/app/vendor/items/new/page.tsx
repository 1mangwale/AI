'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { nestjsItems } from '@/lib/api/nestjs/items';
import { useToast } from '@/components/shared/Toast';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { ItemForm } from '@/components/vendor/ItemForm';
import type { Category, Item } from '@/types/nestjs/api';

export default function VendorNewItemPage() {
  const router = useRouter();
  const toast = useToast();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await nestjsItems.getCategories();
      if (res.success) {
        setCategories(res.data);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load categories.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (data: Partial<Item>) => {
    setSaving(true);
    try {
      const res = await nestjsItems.vendor.create(data);
      if (res.success) {
        toast.success('Item created successfully!');
        router.push('/vendor/items');
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to create item.'
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" text="Loading categories..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-red-600 text-sm">{error}</p>
        <button
          onClick={fetchCategories}
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
          onClick={() => router.push('/vendor/items')}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Create New Item</h1>
      </div>

      <div className="bg-white rounded-xl border p-6">
        <ItemForm
          categories={categories}
          onSubmit={handleSubmit}
          loading={saving}
        />
      </div>
    </div>
  );
}
