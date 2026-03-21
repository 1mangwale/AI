'use client';

import { useState, useEffect, useCallback } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3200';

// ─── Types ──────────────────────────────────────────────────────

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  storeName: string;
  storeId: number;
  imageUrl: string | null;
  available: boolean;
  orderCount: number;
}

interface WhatsAppOrder {
  id: string;
  phone: string;
  status: string;
  items: Array<{ name: string; quantity: number; price: number }>;
  totalAmount: number;
  deliveryAddress: string | null;
  paymentMethod: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OrderStats {
  totalOrders: number;
  totalRevenue: number;
  conversionRate: number;
  avgOrderValue: number;
  statusBreakdown: Array<{ status: string; count: number }>;
  paymentMethods: Array<{ method: string; count: number }>;
  topItems: Array<{ name: string; quantity: number; revenue: number }>;
}

// ─── Helpers ────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return `Rs ${amount.toFixed(0)}`;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STATUS_COLORS: Record<string, string> = {
  cart: 'bg-gray-100 text-gray-600',
  confirmed: 'bg-blue-100 text-blue-700',
  payment_pending: 'bg-yellow-100 text-yellow-700',
  paid: 'bg-green-100 text-green-700',
  delivered: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700',
};

// ─── Component ──────────────────────────────────────────────────

export default function WhatsAppCommercePage() {
  const [tab, setTab] = useState<'catalog' | 'orders' | 'stats'>('catalog');
  const [loading, setLoading] = useState(true);

  // Catalog state
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogCategory, setCatalogCategory] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [sendingTo, setSendingTo] = useState('');

  // Orders state
  const [orders, setOrders] = useState<WhatsAppOrder[]>([]);
  const [orderStatus, setOrderStatus] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<WhatsAppOrder | null>(null);

  // Stats state
  const [stats, setStats] = useState<OrderStats | null>(null);

  const fetchCatalog = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (catalogSearch) params.set('search', catalogSearch);
      if (catalogCategory) params.set('category', catalogCategory);
      const res = await fetch(`${API}/api/mos/whatsapp-commerce/catalog?${params}`);
      if (res.ok) {
        const data = await res.json();
        setCatalog(Array.isArray(data) ? data : data.items || []);
      }
    } catch (err) {
      console.error('Failed to fetch catalog:', err);
    }
  }, [catalogSearch, catalogCategory]);

  const fetchOrders = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (orderStatus) params.set('status', orderStatus);
      const res = await fetch(`${API}/api/mos/whatsapp-commerce/orders?${params}`);
      if (res.ok) {
        const data = await res.json();
        setOrders(Array.isArray(data) ? data : data.orders || []);
      }
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    }
  }, [orderStatus]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/mos/whatsapp-commerce/orders/stats`);
      if (res.ok) setStats(await res.json());
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    const loadAll = async () => {
      await Promise.all([fetchCatalog(), fetchOrders(), fetchStats()]);
      setLoading(false);
    };
    loadAll();
  }, [fetchCatalog, fetchOrders, fetchStats]);

  const syncCatalog = async () => {
    setSyncing(true);
    try {
      await fetch(`${API}/api/mos/whatsapp-commerce/catalog/sync`, { method: 'POST' });
      await fetchCatalog();
    } finally {
      setSyncing(false);
    }
  };

  const sendCatalog = async (phone: string) => {
    if (!phone) return;
    try {
      await fetch(`${API}/api/mos/whatsapp-commerce/catalog/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      setSendingTo('');
      alert('Catalog sent!');
    } catch {
      alert('Failed to send catalog');
    }
  };

  // Get unique categories from catalog
  const categories = [...new Set(catalog.map(c => c.category).filter(Boolean))];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-green-200 border-t-green-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">WhatsApp Commerce</h1>
        <p className="text-gray-500 mt-1">Manage product catalog, track orders, and view commerce analytics</p>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <nav className="flex gap-4">
          {(['catalog', 'orders', 'stats'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                tab === t ? 'border-green-600 text-green-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'catalog' ? 'Product Catalog' : t === 'orders' ? 'Active Orders' : 'Order Stats'}
            </button>
          ))}
        </nav>
      </div>

      {/* ─── Catalog Tab ─────────────────────────────────────────── */}
      {tab === 'catalog' && (
        <div className="space-y-4">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="Search products..."
              value={catalogSearch}
              onChange={(e) => setCatalogSearch(e.target.value)}
              className="px-3 py-2 border rounded-lg text-sm w-64"
            />
            <select
              value={catalogCategory}
              onChange={(e) => setCatalogCategory(e.target.value)}
              className="px-3 py-2 border rounded-lg text-sm"
            >
              <option value="">All Categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            <button
              onClick={syncCatalog}
              disabled={syncing}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
            >
              {syncing ? 'Syncing...' : 'Sync from PHP'}
            </button>
            <div className="flex items-center gap-2 ml-auto">
              <input
                type="text"
                placeholder="Phone number"
                value={sendingTo}
                onChange={(e) => setSendingTo(e.target.value)}
                className="px-3 py-2 border rounded-lg text-sm w-40"
              />
              <button
                onClick={() => sendCatalog(sendingTo)}
                disabled={!sendingTo}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                Send Catalog
              </button>
            </div>
          </div>

          {/* Catalog count */}
          <p className="text-sm text-gray-500">{catalog.length} products</p>

          {/* Catalog Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {catalog.map((item) => (
              <div key={item.id} className="bg-white rounded-lg border p-4 hover:shadow-sm transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-gray-900 truncate">{item.name}</h3>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">{item.storeName}</p>
                  </div>
                  <span className={`ml-2 px-2 py-0.5 rounded text-xs ${
                    item.available ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                  }`}>
                    {item.available ? 'Active' : 'Inactive'}
                  </span>
                </div>
                {item.description && (
                  <p className="text-xs text-gray-500 mt-2 line-clamp-2">{item.description}</p>
                )}
                <div className="flex items-center justify-between mt-3">
                  <span className="font-semibold text-green-700">{formatCurrency(item.price)}</span>
                  <span className="text-xs text-gray-400">{item.category}</span>
                </div>
                <div className="text-xs text-gray-400 mt-1">{item.orderCount} orders</div>
              </div>
            ))}
          </div>

          {catalog.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              <p className="text-lg font-medium">No products in catalog</p>
              <p className="text-sm mt-1">Click "Sync from PHP" to import products</p>
            </div>
          )}
        </div>
      )}

      {/* ─── Orders Tab ──────────────────────────────────────────── */}
      {tab === 'orders' && (
        <div className="space-y-4">
          {/* Status Filter */}
          <div className="flex gap-2">
            {['', 'cart', 'confirmed', 'payment_pending', 'paid', 'delivered'].map((s) => (
              <button
                key={s}
                onClick={() => setOrderStatus(s)}
                className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                  orderStatus === s
                    ? 'bg-green-600 text-white border-green-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >
                {s || 'All'}
              </button>
            ))}
          </div>

          {/* Orders Table */}
          <div className="bg-white rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Phone</th>
                  <th className="px-4 py-3 text-left font-medium">Items</th>
                  <th className="px-4 py-3 text-right font-medium">Total</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Payment</th>
                  <th className="px-4 py-3 text-left font-medium">Created</th>
                  <th className="px-4 py-3 text-center font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {orders.map((order) => (
                  <tr key={order.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-sm">{order.phone}</td>
                    <td className="px-4 py-3">
                      <span className="text-gray-600">
                        {(order.items || []).length} item{(order.items || []).length !== 1 ? 's' : ''}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">{formatCurrency(order.totalAmount || 0)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLORS[order.status] || 'bg-gray-100'}`}>
                        {order.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{order.paymentMethod || '-'}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{timeAgo(order.createdAt)}</td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => setSelectedOrder(order)}
                        className="text-blue-600 hover:underline text-xs"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
                {orders.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      No orders found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Order Detail Modal */}
          {selectedOrder && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSelectedOrder(null)}>
              <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-gray-900">Order Details</h3>
                  <button onClick={() => setSelectedOrder(null)} className="text-gray-400 hover:text-gray-600">X</button>
                </div>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Phone:</span>
                    <span className="font-mono">{selectedOrder.phone}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Status:</span>
                    <span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLORS[selectedOrder.status] || ''}`}>
                      {selectedOrder.status}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Total:</span>
                    <span className="font-semibold">{formatCurrency(selectedOrder.totalAmount || 0)}</span>
                  </div>
                  {selectedOrder.deliveryAddress && (
                    <div>
                      <span className="text-gray-500">Address:</span>
                      <p className="text-gray-700 mt-1">{selectedOrder.deliveryAddress}</p>
                    </div>
                  )}
                  <div>
                    <span className="text-gray-500">Items:</span>
                    <div className="mt-1 space-y-1">
                      {(selectedOrder.items || []).map((item, i) => (
                        <div key={i} className="flex justify-between text-gray-700">
                          <span>{item.quantity}x {item.name}</span>
                          <span>{formatCurrency(item.price * item.quantity)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Created:</span>
                    <span>{selectedOrder.createdAt ? new Date(selectedOrder.createdAt).toLocaleString() : '-'}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── Stats Tab ───────────────────────────────────────────── */}
      {tab === 'stats' && stats && (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-lg border p-4">
              <p className="text-sm text-gray-500">Total Orders</p>
              <p className="text-2xl font-bold">{stats.totalOrders}</p>
            </div>
            <div className="bg-white rounded-lg border p-4">
              <p className="text-sm text-gray-500">Total Revenue</p>
              <p className="text-2xl font-bold text-green-600">{formatCurrency(stats.totalRevenue)}</p>
            </div>
            <div className="bg-white rounded-lg border p-4">
              <p className="text-sm text-gray-500">Conversion Rate</p>
              <p className="text-2xl font-bold">{(stats.conversionRate ?? 0).toFixed(1)}%</p>
            </div>
            <div className="bg-white rounded-lg border p-4">
              <p className="text-sm text-gray-500">Avg Order Value</p>
              <p className="text-2xl font-bold">{formatCurrency(stats.avgOrderValue)}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Status Breakdown */}
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-medium text-gray-900 mb-3">Order Pipeline</h3>
              <div className="space-y-2">
                {(stats.statusBreakdown || []).map((s) => (
                  <div key={s.status} className="flex items-center justify-between">
                    <span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLORS[s.status] || 'bg-gray-100'}`}>
                      {s.status}
                    </span>
                    <span className="font-medium text-gray-700">{s.count}</span>
                  </div>
                ))}
                {(!stats.statusBreakdown || stats.statusBreakdown.length === 0) && (
                  <p className="text-sm text-gray-400">No data</p>
                )}
              </div>
            </div>

            {/* Payment Methods */}
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-medium text-gray-900 mb-3">Payment Methods</h3>
              <div className="space-y-2">
                {(stats.paymentMethods || []).map((pm) => (
                  <div key={pm.method} className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">{pm.method || 'Unknown'}</span>
                    <span className="font-medium text-gray-700">{pm.count}</span>
                  </div>
                ))}
                {(!stats.paymentMethods || stats.paymentMethods.length === 0) && (
                  <p className="text-sm text-gray-400">No data</p>
                )}
              </div>
            </div>

            {/* Popular Items */}
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-medium text-gray-900 mb-3">Top Items</h3>
              <div className="space-y-2">
                {(stats.topItems || []).slice(0, 10).map((item, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="text-gray-600 truncate flex-1">{item.name}</span>
                    <div className="flex items-center gap-3 ml-2">
                      <span className="text-gray-400">{item.quantity}x</span>
                      <span className="font-medium text-green-600 whitespace-nowrap">{formatCurrency(item.revenue)}</span>
                    </div>
                  </div>
                ))}
                {(!stats.topItems || stats.topItems.length === 0) && (
                  <p className="text-sm text-gray-400">No data</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'stats' && !stats && (
        <div className="text-center py-12 text-gray-500">
          <p>No stats available yet</p>
        </div>
      )}
    </div>
  );
}
