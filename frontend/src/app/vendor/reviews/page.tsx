'use client';

import { useState, useEffect, useCallback } from 'react';
import { Star, MessageSquare, User, ChevronLeft, ChevronRight } from 'lucide-react';
import { nestjsVendorDashboard } from '@/lib/api/nestjs/vendor-dashboard';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';

interface Review {
  id: number;
  customer_name: string;
  customer_image?: string;
  rating: number;
  comment: string;
  item_name?: string;
  order_id?: number;
  created_at: string;
  [key: string]: unknown;
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          size={14}
          className={
            s <= rating
              ? 'text-yellow-400 fill-yellow-400'
              : 'text-gray-200'
          }
        />
      ))}
    </div>
  );
}

export default function VendorReviewsPage() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const limit = 20;

  const fetchReviews = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await nestjsVendorDashboard.getReviews({ page, limit });
      if (res.success) {
        const reviewData = res.data as unknown as Review[];
        setReviews(reviewData);
        setHasMore(reviewData.length === limit);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load reviews.'
      );
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  // Calculate average from current page
  const avgRating =
    reviews.length > 0
      ? reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-yellow-50 flex items-center justify-center">
          <Star className="text-yellow-500" size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Customer Reviews</h1>
          <p className="text-xs text-gray-500">
            See what customers are saying about your store
          </p>
        </div>
      </div>

      {/* Summary */}
      {!loading && !error && reviews.length > 0 && (
        <div className="bg-white rounded-xl border p-5 flex items-center gap-6">
          <div>
            <p className="text-3xl font-bold text-gray-900">
              {avgRating.toFixed(1)}
            </p>
            <StarRating rating={Math.round(avgRating)} />
          </div>
          <div className="text-sm text-gray-500">
            Based on {reviews.length} reviews on this page
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center min-h-[300px]">
          <LoadingSpinner size="lg" text="Loading reviews..." />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center justify-center min-h-[300px] gap-4">
          <p className="text-red-600 text-sm">{error}</p>
          <button
            onClick={fetchReviews}
            className="px-4 py-2 bg-[#059211] text-white rounded-lg text-sm hover:bg-[#047a0e] transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && reviews.length === 0 && (
        <div className="bg-white rounded-lg border p-12 text-center">
          <MessageSquare className="mx-auto mb-3 text-gray-300" size={48} />
          <p className="text-gray-500 text-sm">No reviews yet</p>
        </div>
      )}

      {/* Review list */}
      {!loading && !error && reviews.length > 0 && (
        <>
          <div className="space-y-3">
            {reviews.map((review) => (
              <div
                key={review.id}
                className="bg-white rounded-xl border p-5 hover:shadow-sm transition-shadow"
              >
                <div className="flex items-start gap-3">
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                    {review.customer_image ? (
                      <img
                        src={review.customer_image}
                        alt={review.customer_name}
                        className="w-full h-full rounded-full object-cover"
                      />
                    ) : (
                      <User className="text-gray-400" size={18} />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-semibold text-gray-900">
                        {review.customer_name || 'Anonymous'}
                      </p>
                      <span className="text-xs text-gray-400">
                        {new Date(review.created_at).toLocaleDateString(
                          'en-IN',
                          {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          }
                        )}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 mb-2">
                      <StarRating rating={review.rating} />
                      <span className="text-xs text-gray-500">
                        {review.rating}/5
                      </span>
                    </div>

                    {review.item_name && (
                      <p className="text-xs text-gray-400 mb-1">
                        Item: {review.item_name}
                      </p>
                    )}

                    {review.comment && (
                      <p className="text-sm text-gray-600 leading-relaxed">
                        {review.comment}
                      </p>
                    )}

                    {review.order_id && (
                      <p className="text-xs text-gray-400 mt-2">
                        Order #{review.order_id}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-center gap-2 pt-4">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-2 rounded-lg border hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm text-gray-600">Page {page}</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasMore}
              className="p-2 rounded-lg border hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
