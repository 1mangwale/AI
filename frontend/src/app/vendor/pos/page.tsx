'use client';

import { useState, useCallback } from 'react';
import {
  Search,
  Plus,
  Minus,
  Trash2,
  ShoppingCart,
  User,
  Loader2,
  Receipt,
} from 'lucide-react';
import { nestjsClient } from '@/lib/api/nestjs-client';
import { nestjsItems } from '@/lib/api/nestjs/items';
import { useToast } from '@/components/shared/Toast';
import type { Item, ApiResponse, Order } from '@/types/nestjs/api';

interface PosCartItem {
  item: Item;
  quantity: number;
}

export default function VendorPosPage() {
  const toast = useToast();

  // Search state
  const [itemSearch, setItemSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Item[]>([]);
  const [searching, setSearching] = useState(false);

  // Cart
  const [cart, setCart] = useState<PosCartItem[]>([]);

  // Customer
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerSearching, setCustomerSearching] = useState(false);
  const [customerFound, setCustomerFound] = useState(false);

  // Placing order
  const [placingOrder, setPlacingOrder] = useState(false);

  // Item search
  const handleItemSearch = useCallback(
    async (query: string) => {
      setItemSearch(query);
      if (query.trim().length < 2) {
        setSearchResults([]);
        return;
      }
      setSearching(true);
      try {
        const res = await nestjsItems.vendor.list({ search: query.trim(), limit: 10 });
        if (res.success) {
          setSearchResults(res.data);
        }
      } catch {
        // silently fail
      } finally {
        setSearching(false);
      }
    },
    []
  );

  // Add item to cart
  const addToCart = (item: Item) => {
    setCart((prev) => {
      const existing = prev.find((ci) => ci.item.id === item.id);
      if (existing) {
        return prev.map((ci) =>
          ci.item.id === item.id
            ? { ...ci, quantity: ci.quantity + 1 }
            : ci
        );
      }
      return [...prev, { item, quantity: 1 }];
    });
    setItemSearch('');
    setSearchResults([]);
  };

  // Update quantity
  const updateQuantity = (itemId: number, delta: number) => {
    setCart((prev) =>
      prev
        .map((ci) =>
          ci.item.id === itemId
            ? { ...ci, quantity: Math.max(0, ci.quantity + delta) }
            : ci
        )
        .filter((ci) => ci.quantity > 0)
    );
  };

  // Remove from cart
  const removeFromCart = (itemId: number) => {
    setCart((prev) => prev.filter((ci) => ci.item.id !== itemId));
  };

  // Customer phone search
  const handleCustomerSearch = async () => {
    if (!customerPhone.trim() || customerPhone.trim().length < 10) {
      toast.warning('Please enter a valid phone number.');
      return;
    }
    setCustomerSearching(true);
    try {
      const res = await nestjsClient.get<ApiResponse<{ name: string; phone: string }>>(
        `/vendor/pos/customer-search?phone=${encodeURIComponent(customerPhone.trim())}`
      );
      if (res.success && res.data) {
        setCustomerName(res.data.name || '');
        setCustomerFound(true);
        toast.success('Customer found!');
      } else {
        setCustomerFound(false);
        setCustomerName('');
        toast.info('Customer not found. Will create a new guest order.');
      }
    } catch {
      setCustomerFound(false);
      setCustomerName('');
    } finally {
      setCustomerSearching(false);
    }
  };

  // Calculate totals
  const subtotal = cart.reduce(
    (sum, ci) => sum + ci.item.price * ci.quantity,
    0
  );
  const taxRate = 0; // tax will be computed by backend
  const total = subtotal;

  // Place order
  const handlePlaceOrder = async () => {
    if (cart.length === 0) {
      toast.warning('Cart is empty.');
      return;
    }
    setPlacingOrder(true);
    try {
      const orderData = {
        items: cart.map((ci) => ({
          item_id: ci.item.id,
          quantity: ci.quantity,
          price: ci.item.price,
        })),
        customer_phone: customerPhone.trim() || undefined,
        payment_method: 'cash_on_delivery',
      };
      const res = await nestjsClient.post<ApiResponse<Order>>(
        '/vendor/pos/place-order',
        orderData
      );
      if (res.success) {
        toast.success(`POS Order #${res.data.id} placed successfully!`);
        setCart([]);
        setCustomerPhone('');
        setCustomerName('');
        setCustomerFound(false);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to place order.'
      );
    } finally {
      setPlacingOrder(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-[#059211]/10 flex items-center justify-center">
          <Receipt className="text-[#059211]" size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Point of Sale
          </h1>
          <p className="text-xs text-gray-500">
            Create walk-in orders
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left: Item search + results (3 cols) */}
        <div className="lg:col-span-3 space-y-4">
          {/* Item search */}
          <div className="bg-white rounded-xl border p-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Search Items
            </label>
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="text"
                value={itemSearch}
                onChange={(e) => handleItemSearch(e.target.value)}
                placeholder="Search by item name..."
                className="w-full pl-9 pr-3 py-2.5 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
              />
              {searching && (
                <Loader2
                  size={16}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 animate-spin"
                />
              )}
            </div>

            {/* Search results dropdown */}
            {searchResults.length > 0 && (
              <div className="mt-2 border rounded-lg max-h-64 overflow-y-auto divide-y">
                {searchResults.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => addToCart(item)}
                    className="w-full flex items-center gap-3 p-3 hover:bg-gray-50 text-left transition-colors"
                  >
                    <div className="w-10 h-10 bg-gray-100 rounded flex items-center justify-center flex-shrink-0">
                      {item.image ? (
                        <img
                          src={item.image}
                          alt={item.name}
                          className="w-full h-full object-cover rounded"
                        />
                      ) : (
                        <ShoppingCart size={14} className="text-gray-300" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {item.name}
                      </p>
                      <p className="text-xs text-gray-500">
                        ₹{item.price.toFixed(2)} | Stock: {item.stock}
                      </p>
                    </div>
                    <Plus size={16} className="text-[#059211] flex-shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Customer search */}
          <div className="bg-white rounded-xl border p-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Customer Phone (Optional)
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <User
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                />
                <input
                  type="tel"
                  value={customerPhone}
                  onChange={(e) => {
                    setCustomerPhone(e.target.value);
                    setCustomerFound(false);
                  }}
                  placeholder="Enter phone number..."
                  className="w-full pl-9 pr-3 py-2.5 border rounded-lg text-sm focus:ring-2 focus:ring-[#059211]/20 focus:border-[#059211] outline-none"
                />
              </div>
              <button
                onClick={handleCustomerSearch}
                disabled={customerSearching}
                className="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {customerSearching && (
                  <Loader2 className="animate-spin" size={14} />
                )}
                Search
              </button>
            </div>
            {customerFound && customerName && (
              <p className="mt-2 text-sm text-green-700">
                Customer: {customerName}
              </p>
            )}
          </div>
        </div>

        {/* Right: Cart (2 cols) */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-xl border p-4 sticky top-20">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <ShoppingCart size={16} />
              Cart ({cart.length} items)
            </h2>

            {cart.length === 0 ? (
              <div className="py-12 text-center">
                <ShoppingCart
                  className="mx-auto mb-2 text-gray-300"
                  size={32}
                />
                <p className="text-sm text-gray-400">Cart is empty</p>
                <p className="text-xs text-gray-300 mt-1">
                  Search and add items
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-3 max-h-80 overflow-y-auto">
                  {cart.map((ci) => (
                    <div
                      key={ci.item.id}
                      className="flex items-center gap-3 p-2 border rounded-lg"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {ci.item.name}
                        </p>
                        <p className="text-xs text-gray-500">
                          ₹{ci.item.price.toFixed(2)} each
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => updateQuantity(ci.item.id, -1)}
                          className="w-7 h-7 flex items-center justify-center rounded border hover:bg-gray-100 transition-colors"
                        >
                          <Minus size={12} />
                        </button>
                        <span className="w-8 text-center text-sm font-medium">
                          {ci.quantity}
                        </span>
                        <button
                          onClick={() => updateQuantity(ci.item.id, 1)}
                          className="w-7 h-7 flex items-center justify-center rounded border hover:bg-gray-100 transition-colors"
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                      <div className="text-sm font-semibold text-gray-900 w-16 text-right">
                        ₹{(ci.item.price * ci.quantity).toFixed(2)}
                      </div>
                      <button
                        onClick={() => removeFromCart(ci.item.id)}
                        className="p-1 text-red-400 hover:text-red-600 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Totals */}
                <div className="border-t mt-4 pt-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Subtotal</span>
                    <span className="text-gray-900 font-medium">
                      ₹{subtotal.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm font-bold">
                    <span className="text-gray-900">Total</span>
                    <span className="text-gray-900">₹{total.toFixed(2)}</span>
                  </div>
                </div>

                {/* Place order button */}
                <button
                  onClick={handlePlaceOrder}
                  disabled={placingOrder || cart.length === 0}
                  className="w-full mt-4 py-3 bg-[#059211] text-white rounded-lg text-sm font-semibold hover:bg-[#047a0e] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {placingOrder && (
                    <Loader2 className="animate-spin" size={16} />
                  )}
                  {placingOrder ? 'Placing Order...' : 'Place Order'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
