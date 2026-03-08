'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Package,
  MapPin,
  Phone,
  CreditCard,
  Clock,
  User,
  Loader2,
} from 'lucide-react';
import { nestjsOrders } from '@/lib/api/nestjs/orders';
import { useToast } from '@/components/shared/Toast';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import type { Order, OrderStatus } from '@/types/nestjs/api';

const statusFlow: OrderStatus[] = ['confirmed', 'processing', 'handover'];

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  confirmed: 'bg-blue-100 text-blue-700',
  processing: 'bg-purple-100 text-purple-700',
  handover: 'bg-indigo-100 text-indigo-700',
  picked_up: 'bg-cyan-100 text-cyan-700',
  delivered: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
  failed: 'bg-red-100 text-red-700',
  refunded: 'bg-gray-100 text-gray-700',
};

function getNextStatus(current: OrderStatus): OrderStatus | null {
  const idx = statusFlow.indexOf(current);
  if (idx === -1) {
    if (current === 'pending') return 'confirmed';
    return null;
  }
  if (idx < statusFlow.length - 1) {
    return statusFlow[idx + 1];
  }
  return null;
}

const statusLabels: Record<string, string> = {
  confirmed: 'Confirm Order',
  processing: 'Start Processing',
  handover: 'Ready for Handover',
};

export default function VendorOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const orderId = Number(id);

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (orderId) {
      fetchOrder();
    }
  }, [orderId]);

  const fetchOrder = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await nestjsOrders.vendor.get(orderId);
      if (res.success) {
        setOrder(res.data);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load order.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStatus = async (newStatus: string) => {
    setUpdating(true);
    try {
      const res = await nestjsOrders.vendor.updateStatus(orderId, newStatus);
      if (res.success) {
        toast.success(`Order status updated to ${newStatus.replace('_', ' ')}`);
        setOrder(res.data);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to update status.'
      );
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" text="Loading order..." />
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-red-600 text-sm">{error || 'Order not found'}</p>
        <button
          onClick={() => router.push('/vendor/orders')}
          className="px-4 py-2 bg-[#059211] text-white rounded-lg text-sm hover:bg-[#047a0e] transition-colors"
        >
          Back to Orders
        </button>
      </div>
    );
  }

  const nextStatus = getNextStatus(order.order_status);

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/vendor/orders')}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Order #{order.id}
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {new Date(order.created_at).toLocaleString()}
            </p>
          </div>
        </div>
        <span
          className={`text-sm px-3 py-1 rounded-full font-medium ${
            statusColors[order.order_status] || 'bg-gray-100 text-gray-600'
          }`}
        >
          {order.order_status.replace('_', ' ')}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Order items */}
        <div className="lg:col-span-2 space-y-4">
          {/* Items */}
          <div className="bg-white rounded-xl border p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">
              Order Items
            </h2>
            <div className="divide-y">
              {order.details?.map((detail) => (
                <div
                  key={detail.id}
                  className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="w-12 h-12 bg-gray-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    {detail.item_details?.image ? (
                      <img
                        src={detail.item_details.image}
                        alt={detail.item_details.name}
                        className="w-full h-full object-cover rounded-lg"
                      />
                    ) : (
                      <Package className="text-gray-300" size={20} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {detail.item_details?.name || `Item #${detail.item_id}`}
                    </p>
                    <p className="text-xs text-gray-500">
                      Qty: {detail.quantity} x ₹{detail.price.toFixed(2)}
                    </p>
                    {detail.variation && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        Variation: {detail.variation}
                      </p>
                    )}
                  </div>
                  <div className="text-sm font-semibold text-gray-900">
                    ₹{(detail.price * detail.quantity).toFixed(2)}
                  </div>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="border-t mt-4 pt-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Subtotal</span>
                <span className="text-gray-900">
                  ₹
                  {(
                    order.order_amount -
                    order.tax_amount -
                    order.delivery_charge +
                    order.coupon_discount_amount
                  ).toFixed(2)}
                </span>
              </div>
              {order.coupon_discount_amount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">
                    Discount{' '}
                    {order.coupon_discount_title
                      ? `(${order.coupon_discount_title})`
                      : ''}
                  </span>
                  <span className="text-green-600">
                    -₹{order.coupon_discount_amount.toFixed(2)}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Tax</span>
                <span className="text-gray-900">
                  ₹{order.tax_amount.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Delivery Charge</span>
                <span className="text-gray-900">
                  ₹{order.delivery_charge.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between text-sm font-bold pt-2 border-t">
                <span className="text-gray-900">Total</span>
                <span className="text-gray-900">
                  ₹{order.order_amount.toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          {/* Status actions */}
          {nextStatus && (
            <div className="bg-white rounded-xl border p-5">
              <h2 className="text-sm font-semibold text-gray-900 mb-3">
                Update Status
              </h2>
              <div className="flex items-center gap-3">
                {order.order_status === 'pending' && (
                  <>
                    <button
                      onClick={() => handleUpdateStatus('confirmed')}
                      disabled={updating}
                      className="flex-1 py-2.5 bg-[#059211] text-white rounded-lg text-sm font-semibold hover:bg-[#047a0e] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {updating && (
                        <Loader2 className="animate-spin" size={14} />
                      )}
                      Accept Order
                    </button>
                    <button
                      onClick={() => handleUpdateStatus('cancelled')}
                      disabled={updating}
                      className="flex-1 py-2.5 bg-red-50 text-red-600 rounded-lg text-sm font-semibold hover:bg-red-100 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      Reject Order
                    </button>
                  </>
                )}
                {order.order_status !== 'pending' && (
                  <button
                    onClick={() => handleUpdateStatus(nextStatus)}
                    disabled={updating}
                    className="flex-1 py-2.5 bg-[#059211] text-white rounded-lg text-sm font-semibold hover:bg-[#047a0e] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {updating && (
                      <Loader2 className="animate-spin" size={14} />
                    )}
                    {statusLabels[nextStatus] || `Move to ${nextStatus}`}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Customer info */}
          <div className="bg-white rounded-xl border p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              Customer
            </h2>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <User size={14} />
                <span>
                  {order.delivery_address?.contact_person_name || 'N/A'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Phone size={14} />
                <span>
                  {order.delivery_address?.contact_person_number || 'N/A'}
                </span>
              </div>
            </div>
          </div>

          {/* Delivery address */}
          <div className="bg-white rounded-xl border p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              Delivery Address
            </h2>
            <div className="flex items-start gap-2 text-sm text-gray-600">
              <MapPin size={14} className="mt-0.5 flex-shrink-0" />
              <div>
                <p>{order.delivery_address?.address || 'N/A'}</p>
                {order.delivery_address?.house && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    House: {order.delivery_address.house}
                    {order.delivery_address.floor &&
                      `, Floor: ${order.delivery_address.floor}`}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Payment info */}
          <div className="bg-white rounded-xl border p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              Payment
            </h2>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <CreditCard size={14} />
                <span className="capitalize">
                  {order.payment_method.replace('_', ' ')}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    order.payment_status === 'paid'
                      ? 'bg-green-100 text-green-700'
                      : order.payment_status === 'unpaid'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {order.payment_status}
                </span>
              </div>
            </div>
          </div>

          {/* Order info */}
          <div className="bg-white rounded-xl border p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              Order Info
            </h2>
            <div className="space-y-2 text-sm text-gray-600">
              <div className="flex justify-between">
                <span>Type</span>
                <span className="capitalize font-medium text-gray-900">
                  {order.order_type.replace('_', ' ')}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Scheduled</span>
                <span className="font-medium text-gray-900">
                  {order.scheduled ? 'Yes' : 'No'}
                </span>
              </div>
              {order.schedule_at && (
                <div className="flex justify-between">
                  <span>Schedule At</span>
                  <span className="font-medium text-gray-900">
                    {new Date(order.schedule_at).toLocaleString()}
                  </span>
                </div>
              )}
              {order.order_note && (
                <div className="pt-2 border-t">
                  <p className="text-xs text-gray-400 mb-0.5">Order Note</p>
                  <p className="text-sm text-gray-700">{order.order_note}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
