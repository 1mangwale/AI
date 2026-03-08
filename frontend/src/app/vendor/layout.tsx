'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useNestjsAuthStore } from '@/store/nestjsAuthStore';
import {
  LayoutDashboard,
  Store,
  Package,
  ShoppingCart,
  BarChart3,
  DollarSign,
  Receipt,
  FileText,
  CreditCard,
  Star,
  ChevronDown,
  Menu,
  X,
  LogOut,
  User,
} from 'lucide-react';
import { Breadcrumbs } from '@/components/shared/Breadcrumbs';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';

interface NavChild {
  name: string;
  href: string;
}

interface NavItem {
  name: string;
  icon: React.ComponentType<{ size?: number }>;
  href?: string;
  children?: NavChild[];
}

const navigation: NavItem[] = [
  {
    name: 'Dashboard',
    href: '/vendor/dashboard',
    icon: LayoutDashboard,
  },
  {
    name: 'Stores',
    href: '/vendor/stores',
    icon: Store,
  },
  {
    name: 'Items',
    icon: Package,
    children: [
      { name: 'All Items', href: '/vendor/items' },
      { name: 'Add New', href: '/vendor/items/new' },
    ],
  },
  {
    name: 'Orders',
    href: '/vendor/orders',
    icon: ShoppingCart,
  },
  {
    name: 'Reports',
    icon: BarChart3,
    children: [
      { name: 'Earning', href: '/vendor/reports/earning' },
      { name: 'Expense', href: '/vendor/reports/expense' },
      { name: 'Tax', href: '/vendor/reports/tax' },
      { name: 'Disbursement', href: '/vendor/reports/disbursement' },
    ],
  },
  {
    name: 'POS',
    href: '/vendor/pos',
    icon: CreditCard,
  },
  {
    name: 'Reviews',
    href: '/vendor/reviews',
    icon: Star,
  },
];

const AUTH_FREE_PATHS = ['/vendor/login'];

export default function VendorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, _hasHydrated, user, userType, clearAuth } =
    useNestjsAuthStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedItems, setExpandedItems] = useState<string[]>([]);

  const isAuthFreePage = AUTH_FREE_PATHS.includes(pathname);

  useEffect(() => {
    if (_hasHydrated && !isAuthFreePage) {
      if (!isAuthenticated || userType !== 'vendor') {
        router.push('/vendor/login');
      }
    }
  }, [_hasHydrated, isAuthenticated, userType, isAuthFreePage, router]);

  if (isAuthFreePage) {
    return <>{children}</>;
  }

  if (!_hasHydrated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#059211]/20 border-t-[#059211] rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated || userType !== 'vendor') {
    return null;
  }

  const toggleExpanded = (name: string) => {
    setExpandedItems((prev) =>
      prev.includes(name)
        ? prev.filter((item) => item !== name)
        : [...prev, name]
    );
  };

  const handleLogout = () => {
    clearAuth();
    router.push('/vendor/login');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white shadow-lg transform transition-transform duration-300 ease-in-out lg:translate-x-0 flex flex-col ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-between px-6 border-b flex-shrink-0">
          <h1 className="text-xl font-bold text-[#059211]">Vendor Panel</h1>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden text-gray-500 hover:text-gray-700"
          >
            <X size={24} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          {navigation.map((item) => {
            const isActive = item.href
              ? pathname === item.href
              : item.children?.some((child) => pathname === child.href);
            const isExpanded = expandedItems.includes(item.name);

            return (
              <div key={item.name}>
                {item.children ? (
                  <>
                    <button
                      onClick={() => toggleExpanded(item.name)}
                      className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                        isActive
                          ? 'bg-[#059211]/10 text-[#059211]'
                          : 'text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <item.icon size={20} />
                        <span>{item.name}</span>
                      </div>
                      <ChevronDown
                        className={`transition-transform ${
                          isExpanded ? 'rotate-180' : ''
                        }`}
                        size={16}
                      />
                    </button>
                    {isExpanded && (
                      <div className="ml-4 mt-1 space-y-1">
                        {item.children.map((child) => (
                          <Link
                            key={child.href}
                            href={child.href}
                            className={`block px-3 py-2 text-sm rounded-lg transition-colors ${
                              pathname === child.href
                                ? 'bg-[#059211]/10 text-[#059211] font-medium'
                                : 'text-gray-600 hover:bg-gray-100'
                            }`}
                          >
                            {child.name}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <Link
                    href={item.href!}
                    className={`flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                      isActive
                        ? 'bg-[#059211]/10 text-[#059211]'
                        : 'text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    <item.icon size={20} />
                    <span>{item.name}</span>
                  </Link>
                )}
              </div>
            );
          })}
        </nav>

        {/* User info + Logout */}
        <div className="border-t p-4">
          {user && (
            <div className="px-3 py-2 mb-2">
              <p className="text-sm font-medium text-gray-900 truncate">
                {user.f_name} {user.l_name}
              </p>
              <p className="text-xs text-gray-500 truncate">{user.email}</p>
              <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium bg-[#059211]/10 text-[#059211]">
                Vendor
              </span>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg w-full transition-colors"
          >
            <LogOut size={20} />
            <span>Logout</span>
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="lg:pl-64">
        <div className="sticky top-0 z-10 flex h-16 items-center gap-4 border-b bg-white px-6">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden text-gray-500 hover:text-gray-700"
          >
            <Menu size={24} />
          </button>
          <Breadcrumbs />
        </div>

        <main className="p-6">
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
