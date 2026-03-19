'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAdminAuthStore } from '@/store/adminAuthStore';
import {
  LayoutDashboard,
  Brain,
  Search,
  Webhook,
  FileText,
  ChevronDown,
  Menu,
  X,
  LogOut,
  Gamepad2,
  Sparkles,
  GraduationCap,
  Database,
  Users,
  Megaphone,
  Monitor,
  UserCheck,
  User,
  Shield,
  Zap,
  ShoppingBag,
} from 'lucide-react';
import { Breadcrumbs } from '@/components/shared/Breadcrumbs';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';

type NavRole = 'super_admin' | 'admin' | 'manager' | 'reviewer' | 'viewer';

const ALL: NavRole[] = ['super_admin', 'admin', 'manager', 'reviewer', 'viewer'];
const MANAGER_PLUS: NavRole[] = ['super_admin', 'admin', 'manager'];
const ADMIN_PLUS: NavRole[] = ['super_admin', 'admin'];
const SUPER_ONLY: NavRole[] = ['super_admin'];

interface NavChild {
  name: string;
  href: string;
  allowedRoles?: NavRole[];
}

interface NavItem {
  name: string;
  icon: React.ComponentType<{ size?: number }>;
  href?: string;
  children?: NavChild[];
  allowedRoles?: NavRole[];
}

const navigation: NavItem[] = [
  {
    name: 'Dashboard',
    href: '/admin/dashboard',
    icon: LayoutDashboard,
    // visible to all roles
  },
  {
    name: 'Commerce',
    icon: ShoppingBag,
    allowedRoles: MANAGER_PLUS,
    children: [
      { name: 'Stores', href: '/admin/commerce/stores' },
      { name: 'Orders', href: '/admin/commerce/orders' },
      { name: 'Items', href: '/admin/commerce/items' },
      { name: 'Users', href: '/admin/commerce/users', allowedRoles: ADMIN_PLUS },
      { name: 'Payments', href: '/admin/commerce/finance/payments' },
      { name: 'Settlements', href: '/admin/commerce/finance/settlements' },
      { name: 'Offline Payments', href: '/admin/commerce/finance/offline-payments' },
      { name: 'Delivery Zones', href: '/admin/commerce/delivery/zones' },
      { name: 'Delivery Tracking', href: '/admin/commerce/delivery/tracking' },
      { name: 'Subscriptions', href: '/admin/commerce/subscriptions', allowedRoles: ADMIN_PLUS },
      { name: 'Roles & Permissions', href: '/admin/commerce/roles', allowedRoles: ADMIN_PLUS },
      { name: 'Business Settings', href: '/admin/commerce/settings', allowedRoles: ADMIN_PLUS },
    ],
  },
  {
    name: 'mOS Command',
    icon: Zap,
    allowedRoles: MANAGER_PLUS,
    children: [
      { name: 'Neural Dashboard', href: '/admin/mos' },
      { name: 'Model Orchestra', href: '/admin/mos/models' },
      { name: 'Operations Intel', href: '/admin/mos/operations' },
      { name: 'Customer Intelligence', href: '/admin/mos/customers' },
      { name: 'Approval Queue', href: '/admin/mos/approvals' },
      { name: 'Demand & Pricing', href: '/admin/mos/demand' },
      { name: 'Campaign Builder', href: '/admin/mos/campaigns' },
      { name: 'Retention Intel', href: '/admin/mos/retention' },
      { name: 'Rider Command', href: '/admin/mos/riders' },
      { name: 'Marketing Intel', href: '/admin/mos/marketing' },
      { name: 'Strategy Ledger', href: '/admin/mos/strategy' },
      { name: 'Action Engine', href: '/admin/mos/action-engine' },
      { name: 'WhatsApp Commerce', href: '/admin/mos/whatsapp-commerce' },
      { name: 'Content Factory', href: '/admin/mos/content-factory' },
      { name: 'Content Calendar', href: '/admin/mos/content-calendar' },
      { name: 'Scheduler', href: '/admin/mos/scheduler' },
    ],
  },
  {
    name: 'AI Hub',
    href: '/admin/ai-hub',
    icon: Sparkles,
    allowedRoles: MANAGER_PLUS,
  },
  {
    name: 'Self-Learning',
    icon: GraduationCap,
    allowedRoles: ['super_admin', 'admin', 'manager', 'reviewer'],
    children: [
      { name: 'Learning Dashboard', href: '/admin/learning', allowedRoles: MANAGER_PLUS },
      { name: 'Review Queue', href: '/admin/learning/review' },
      { name: 'Label Studio', href: '/admin/learning/label-studio', allowedRoles: MANAGER_PLUS },
    ],
  },
  {
    name: 'Data Sources',
    icon: Database,
    allowedRoles: MANAGER_PLUS,
    children: [
      { name: 'Source Management', href: '/admin/data-sources' },
      { name: 'Competitor Scraper', href: '/admin/scraper' },
      { name: 'Scraper Jobs', href: '/admin/scraper?tab=jobs' },
      { name: 'Store Mappings', href: '/admin/scraper?tab=mappings' },
      { name: 'Pricing Intel', href: '/admin/scraper?tab=pricing' },
    ],
  },
  {
    name: 'User Management',
    icon: Users,
    allowedRoles: ADMIN_PLUS,
    children: [
      { name: 'Admin Users', href: '/admin/users' },
      { name: 'Activity Log', href: '/admin/users/activity' },
    ],
  },
  {
    name: 'AI Management',
    icon: Brain,
    allowedRoles: MANAGER_PLUS,
    children: [
      { name: 'Models Registry', href: '/admin/models' },
      { name: 'Agent Settings', href: '/admin/agent-settings' },
      { name: 'Agent Testing', href: '/admin/agent-testing' },
      { name: 'Voice AI (ASR/TTS)', href: '/admin/voice' },
      { name: 'Voice Characters', href: '/admin/voice/characters' },
      { name: 'Docker Management', href: '/admin/docker', allowedRoles: ADMIN_PLUS },
      { name: 'vLLM Settings', href: '/admin/vllm-settings', allowedRoles: ADMIN_PLUS },
      { name: 'LLM Failover', href: '/admin/llm-failover' },
      { name: 'LLM Chat', href: '/admin/llm-chat' },
      { name: 'LLM Models', href: '/admin/llm-models' },
      { name: 'LLM Providers', href: '/admin/llm-providers' },
      { name: 'LLM Analytics', href: '/admin/llm-analytics' },
      { name: 'LLM Cost Tracking', href: '/admin/llm-cost-tracking' },
      { name: 'Agents', href: '/admin/agents' },
      { name: 'Intents', href: '/admin/intents' },
      { name: 'NLU Testing', href: '/admin/nlu-testing' },
      { name: 'NER Entities', href: '/admin/ner-entities' },
      { name: 'Training', href: '/admin/training' },
      { name: 'Flows', href: '/admin/flows' },
      { name: 'Flow Analytics', href: '/admin/flow-analytics' },
      { name: 'Self-Healing', href: '/admin/self-healing' },
      { name: 'Semantic Cache', href: '/admin/semantic-cache' },
      { name: 'Nerve Voice', href: '/admin/nerve' },
      { name: 'Exotel Voice', href: '/admin/exotel' },
    ],
  },
  {
    name: 'Gamification',
    icon: Gamepad2,
    allowedRoles: MANAGER_PLUS,
    children: [
      { name: 'Dashboard', href: '/admin/gamification' },
      { name: 'Settings', href: '/admin/gamification/settings' },
      { name: 'Game Questions', href: '/admin/gamification/questions' },
      { name: 'Training Samples', href: '/admin/gamification/training-samples' },
    ],
  },
  {
    name: 'Personalization',
    icon: UserCheck,
    allowedRoles: MANAGER_PLUS,
    children: [
      { name: 'User Profiles', href: '/admin/user-profiles' },
      { name: 'User Insights', href: '/admin/user-insights' },
      { name: 'Conversation Memory', href: '/admin/conversation-memory' },
      { name: 'RAG Documents', href: '/admin/rag-documents' },
      { name: 'Recommendations', href: '/admin/recommendations' },
    ],
  },
  {
    name: 'Search Management',
    icon: Search,
    children: [
      { name: 'System Health & Metrics', href: '/admin/search-config', allowedRoles: MANAGER_PLUS },
      { name: 'Analytics', href: '/admin/search-analytics' },
      { name: 'Trending', href: '/admin/trending', allowedRoles: MANAGER_PLUS },
      { name: 'Testing', href: '/admin/search-testing', allowedRoles: MANAGER_PLUS },
      { name: 'Index Management', href: '/admin/search-indices', allowedRoles: ADMIN_PLUS },
      { name: 'Data Sync', href: '/admin/search-data-sync', allowedRoles: ADMIN_PLUS },
      { name: 'Query Logs', href: '/admin/search-logs', allowedRoles: MANAGER_PLUS },
      { name: 'Items', href: '/admin/items', allowedRoles: ADMIN_PLUS },
      { name: 'Stores', href: '/admin/stores', allowedRoles: ADMIN_PLUS },
      { name: 'Categories', href: '/admin/categories', allowedRoles: ADMIN_PLUS },
    ],
  },
  {
    name: 'Integrations',
    icon: Webhook,
    allowedRoles: ADMIN_PLUS,
    children: [
      { name: 'Webhooks', href: '/admin/webhooks' },
      { name: 'API Keys', href: '/admin/api-keys' },
      { name: 'Channels', href: '/admin/channels' },
      { name: 'White-Label', href: '/admin/tenants' },
    ],
  },
  {
    name: 'Marketing',
    icon: Megaphone,
    allowedRoles: MANAGER_PLUS,
    children: [
      { name: 'WhatsApp Broadcast', href: '/admin/broadcast' },
      { name: 'Analytics', href: '/admin/analytics' },
    ],
  },
  {
    name: 'System',
    icon: Monitor,
    allowedRoles: ADMIN_PLUS,
    children: [
      { name: 'System Settings', href: '/admin/settings' },
      { name: 'System Monitoring', href: '/admin/monitoring', allowedRoles: ALL },
      { name: 'Zones', href: '/admin/zones' },
      { name: 'Secrets', href: '/admin/secrets', allowedRoles: SUPER_ONLY },
    ],
  },
  {
    name: 'Audit Logs',
    href: '/admin/audit-logs',
    icon: FileText,
    // visible to all roles
  },
];

function hasAccess(allowedRoles: NavRole[] | undefined, userRole: string): boolean {
  if (!allowedRoles) return true;
  return allowedRoles.includes(userRole as NavRole);
}

const ROLE_COLORS: Record<string, string> = {
  super_admin: 'bg-purple-100 text-purple-700',
  admin: 'bg-blue-100 text-blue-700',
  manager: 'bg-green-100 text-green-700',
  reviewer: 'bg-yellow-100 text-yellow-700',
  viewer: 'bg-gray-100 text-gray-600',
};

const AUTH_FREE_PATHS = ['/admin/login', '/admin/forgot-password'];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, _hasHydrated, user, clearAuth } = useAdminAuthStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedItems, setExpandedItems] = useState<string[]>([]);

  // Auth-free pages (login, forgot-password) render without sidebar
  const isAuthFreePage = AUTH_FREE_PATHS.includes(pathname);

  // Redirect to login if not authenticated (after hydration)
  useEffect(() => {
    if (_hasHydrated && !isAuthenticated && !isAuthFreePage) {
      router.push('/admin/login');
    }
  }, [_hasHydrated, isAuthenticated, isAuthFreePage, router]);

  // Auth-free pages: render children only, no sidebar
  if (isAuthFreePage) {
    return <>{children}</>;
  }

  // Wait for hydration to prevent flash
  if (!_hasHydrated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  // Not authenticated — redirect is happening via useEffect
  if (!isAuthenticated) {
    return null;
  }

  const userRole = user?.role ?? 'viewer';

  // Filter navigation based on user role
  const filteredNavigation = navigation
    .map((item) => {
      if (!hasAccess(item.allowedRoles, userRole)) return null;
      if (item.children) {
        const filteredChildren = item.children.filter((child) =>
          hasAccess(child.allowedRoles, userRole)
        );
        if (filteredChildren.length === 0) return null;
        return { ...item, children: filteredChildren };
      }
      return item;
    })
    .filter(Boolean) as NavItem[];

  const toggleExpanded = (name: string) => {
    setExpandedItems((prev) =>
      prev.includes(name)
        ? prev.filter((item) => item !== name)
        : [...prev, name]
    );
  };

  const handleLogout = () => {
    clearAuth();
    router.push('/admin/login');
  };

  const roleBadgeClass = ROLE_COLORS[userRole] ?? 'bg-gray-100 text-gray-600';

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
          <h1 className="text-xl font-bold text-blue-600">Mangwale Admin</h1>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden text-gray-500 hover:text-gray-700"
          >
            <X size={24} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          {filteredNavigation.map((item) => {
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
                          ? 'bg-blue-50 text-blue-700'
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
                                ? 'bg-blue-50 text-blue-700 font-medium'
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
                        ? 'bg-blue-50 text-blue-700'
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

        {/* Admin user info + Profile + Logout */}
        <div className="border-t p-4">
          {user && (
            <div className="px-3 py-2 mb-2">
              <p className="text-sm font-medium text-gray-900 truncate">{user.name}</p>
              <p className="text-xs text-gray-500 truncate">{user.email}</p>
              <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium ${roleBadgeClass}`}>
                {user.role.replace('_', ' ')}
              </span>
            </div>
          )}
          <Link
            href="/admin/profile"
            className="flex items-center gap-3 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg w-full transition-colors"
          >
            <User size={20} />
            <span>My Profile</span>
          </Link>
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
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
