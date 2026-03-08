import type { NextConfig } from "next";

const backendUrl = process.env.BACKEND_INTERNAL_URL || 'http://localhost:3200';
// PHP Laravel backend — source of truth for orders, auth, payments, stores, delivery-man
const phpBackendUrl = process.env.PHP_BACKEND_URL || 'https://new.mangwale.com';

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  distDir: '.next-output',
  
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.mangwale.com',
      },
      {
        protocol: 'https',
        hostname: '**.mangwale.ai',
      },
      {
        protocol: 'https',
        hostname: 'storage.mangwale.ai',
      },
      {
        protocol: 'https',
        hostname: 'mangwale-ai.s3.ap-south-1.amazonaws.com',
      },
      {
        protocol: 'https',
        hostname: 'mangwale.s3.ap-south-1.amazonaws.com',
      },
      {
        protocol: 'https',
        hostname: 's3.ap-south-1.amazonaws.com',
      },
      {
        protocol: 'https',
        hostname: 'developers.google.com',
      },
      {
        protocol: 'https',
        hostname: 'maps.googleapis.com',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
      },
      {
        protocol: 'http',
        hostname: 'localhost',
      }
    ],
    // unoptimized: false — Next.js image optimization enabled
  },
  
  // Allow cross-origin requests from our domain structure
  allowedDevOrigins: [
    'test.mangwale.ai',
    'chat.mangwale.ai',
    'admin.mangwale.ai',
    'shop.mangwale.ai',
    'vendor.mangwale.ai',
    'rider.mangwale.ai',
    '192.168.0.156',
    '192.168.0.156:3005',
    'localhost',
    'localhost:3005',
  ],
  
  // Domain-based routing with rewrites
  async rewrites() {
    return {
      // beforeFiles runs before Next.js checks for page/API route files
      // We DON'T put API rewrites here - we want local API routes to be checked first
      beforeFiles: [
        // chat.mangwale.ai - Root shows chat interface
        {
          source: '/',
          destination: '/chat',
          has: [
            {
              type: 'host',
              value: 'chat.mangwale.ai',
            },
          ],
        },
        // admin.mangwale.ai - Root redirects to admin dashboard
        {
          source: '/',
          destination: '/admin',
          has: [
            {
              type: 'host',
              value: 'admin.mangwale.ai',
            },
          ],
        },
        // shop.mangwale.ai - Root shows shop home
        // Route groups like (shop) are transparent in URL — Next.js resolves / to the (shop) layout
        // vendor.mangwale.ai and rider.mangwale.ai are handled similarly via middleware or redirects
      ],
      // afterFiles runs AFTER Next.js checks for page/API route files
      afterFiles: [
        // NOTE: WebSocket (/socket.io) is handled DIRECTLY by Traefik with higher priority
        // Do NOT proxy WebSocket through Next.js - it doesn't support WebSocket upgrades properly
        // Traefik route: chat-ws (priority 100) routes /socket.io to backend

        // Commerce API — /napi/* → PHP backend (new.mangwale.com)
        // Routes: /napi/v1/customer/*, /napi/v1/vendor/*, /napi/v1/delivery-man/*, /napi/v1/admin/*
        {
          source: '/napi/:path*',
          destination: `${phpBackendUrl}/api/:path*`,
        },

        // Search API stats (no /admin prefix on Search API)
        {
          source: '/api/search-admin/stats/:path*',
          destination: 'http://localhost:3100/stats/:path*',
        },
        // Search API sync routes (no /admin prefix on Search API)
        {
          source: '/api/search-admin/sync/:path*',
          destination: 'http://localhost:3100/sync/:path*',
        },
        // Search API analytics routes
        {
          source: '/api/search-admin/analytics/:path*',
          destination: 'http://localhost:3100/v2/analytics/:path*',
        },
        // Search API admin CRUD routes (items, stores, categories)
        {
          source: '/api/search-admin/:path*',
          destination: 'http://localhost:3100/admin/:path*',
        },
        // Proxy specific API paths to backend - EXCLUDING TTS and ASR which have local handlers
        // Auth routes
        {
          source: '/api/auth/:path*',
          destination: `${backendUrl}/api/auth/:path*`,
        },
        // Chat routes
        {
          source: '/api/chat/:path*',
          destination: `${backendUrl}/api/chat/:path*`,
        },
        // Orders routes
        {
          source: '/api/orders/:path*',
          destination: `${backendUrl}/api/orders/:path*`,
        },
        // Menu routes
        {
          source: '/api/menu/:path*',
          destination: `${backendUrl}/api/menu/:path*`,
        },
        // Restaurants routes
        {
          source: '/api/restaurants/:path*',
          destination: `${backendUrl}/api/restaurants/:path*`,
        },
        // Addresses routes
        {
          source: '/api/addresses/:path*',
          destination: `${backendUrl}/api/addresses/:path*`,
        },
        // Wallet routes
        {
          source: '/api/wallet/:path*',
          destination: `${backendUrl}/api/wallet/:path*`,
        },
        // Zones routes
        {
          source: '/api/zones/:path*',
          destination: `${backendUrl}/api/zones/:path*`,
        },
        // Admin routes
        {
          source: '/api/admin/:path*',
          destination: `${backendUrl}/api/admin/:path*`,
        },
        // Location routes
        {
          source: '/api/location/:path*',
          destination: `${backendUrl}/api/location/:path*`,
        },
        // Profile routes
        {
          source: '/api/profile/:path*',
          destination: `${backendUrl}/api/profile/:path*`,
        },
        // Health routes (excluded from NestJS global prefix)
        {
          source: '/api/health',
          destination: `${backendUrl}/health`,
        },
        // Users routes
        {
          source: '/api/users/:path*',
          destination: `${backendUrl}/api/users/:path*`,
        },
        // Payments routes
        {
          source: '/api/payments/:path*',
          destination: `${backendUrl}/api/payments/:path*`,
        },
        // Notifications routes
        {
          source: '/api/notifications/:path*',
          destination: `${backendUrl}/api/notifications/:path*`,
        },
        // Coupons routes
        {
          source: '/api/coupons/:path*',
          destination: `${backendUrl}/api/coupons/:path*`,
        },
        // Files routes
        {
          source: '/api/files/:path*',
          destination: `${backendUrl}/api/files/:path*`,
        },
        // mOS (Neural Decision Dashboard) routes
        {
          source: '/api/mos/:path*',
          destination: `${backendUrl}/api/mos/:path*`,
        },
        // Approvals routes
        {
          source: '/api/approvals/:path*',
          destination: `${backendUrl}/api/approvals/:path*`,
        },
        {
          source: '/api/approvals',
          destination: `${backendUrl}/api/approvals`,
        },
        // Payment webhook routes
        {
          source: '/api/payment/:path*',
          destination: `${backendUrl}/api/payment/:path*`,
        },
        // WhatsApp routes (flows, commerce)
        {
          source: '/api/whatsapp/:path*',
          destination: `${backendUrl}/api/whatsapp/:path*`,
        },
        // Catch-all for other API routes EXCEPT /api/tts and /api/asr (local handlers)
        // Voice routes go to backend
        {
          source: '/api/voice/:path*',
          destination: `${backendUrl}/api/voice/:path*`,
        },
        // Analytics routes
        {
          source: '/api/analytics/:path*',
          destination: `${backendUrl}/api/analytics/:path*`,
        },
        // Trending routes
        {
          source: '/api/trending/:path*',
          destination: `${backendUrl}/api/trending/:path*`,
        },
        {
          source: '/api/trending',
          destination: `${backendUrl}/api/trending`,
        },
        // Stats routes
        {
          source: '/api/stats/:path*',
          destination: `${backendUrl}/api/stats/:path*`,
        },
        // Broadcast routes
        {
          source: '/api/broadcast/:path*',
          destination: `${backendUrl}/api/broadcast/:path*`,
        },
        // NLU routes (intent classification, entity extraction, training data)
        {
          source: '/api/nlu/:path*',
          destination: `${backendUrl}/api/nlu/:path*`,
        },
        // Flow engine routes
        {
          source: '/api/flows/:path*',
          destination: `${backendUrl}/api/flows/:path*`,
        },
        // Agent routes
        {
          source: '/api/agents/:path*',
          destination: `${backendUrl}/api/agents/:path*`,
        },
        // Training routes (datasets, jobs, Label Studio)
        {
          source: '/api/training/:path*',
          destination: `${backendUrl}/api/training/:path*`,
        },
        // Model routes
        {
          source: '/api/models/:path*',
          destination: `${backendUrl}/api/models/:path*`,
        },
        // Settings routes
        {
          source: '/api/settings/:path*',
          destination: `${backendUrl}/api/settings/:path*`,
        },
        // Search routes (items, stores, suggest, health)
        {
          source: '/api/search/:path*',
          destination: `${backendUrl}/api/search/:path*`,
        },
        // RAG document routes
        {
          source: '/api/rag/:path*',
          destination: `${backendUrl}/api/rag/:path*`,
        },
        // Profiles routes (stores, vendors, riders)
        {
          source: '/api/profiles/:path*',
          destination: `${backendUrl}/api/profiles/:path*`,
        },
        // Context routes (weather, time, festivals)
        {
          source: '/api/context/:path*',
          destination: `${backendUrl}/api/context/:path*`,
        },
        // Data sources routes
        {
          source: '/api/data-sources/:path*',
          destination: `${backendUrl}/api/data-sources/:path*`,
        },
        // Scraper routes
        {
          source: '/api/scraper/:path*',
          destination: `${backendUrl}/api/scraper/:path*`,
        },
        // Gamification routes (questions, settings, training-samples, stats)
        {
          source: '/api/gamification/:path*',
          destination: `${backendUrl}/api/gamification/:path*`,
        },
        // AI routes (semantic cache, conversation memory)
        {
          source: '/api/ai/:path*',
          destination: `${backendUrl}/api/ai/:path*`,
        },
        // LLM routes (providers, failover, chat)
        {
          source: '/api/llm/:path*',
          destination: `${backendUrl}/api/llm/:path*`,
        },
        // Monitoring routes
        {
          source: '/api/monitoring/:path*',
          destination: `${backendUrl}/api/monitoring/:path*`,
        },
        // Exotel/Nerve routes
        {
          source: '/api/exotel/:path*',
          destination: `${backendUrl}/api/exotel/:path*`,
        },
        // Learning routes (corrections, self-learning)
        {
          source: '/api/learning/:path*',
          destination: `${backendUrl}/api/learning/:path*`,
        },
        // Config routes
        {
          source: '/api/config/:path*',
          destination: `${backendUrl}/api/config/:path*`,
        },
        // Webhooks routes
        {
          source: '/api/webhooks/:path*',
          destination: `${backendUrl}/api/webhooks/:path*`,
        },
        // Database routes
        {
          source: '/api/database/:path*',
          destination: `${backendUrl}/api/database/:path*`,
        },
        // vLLM direct proxy (OpenAI-compatible API on local GPU)
        {
          source: '/api/vllm/:path*',
          destination: 'http://localhost:8002/:path*',
        },
      ],
      fallback: [],
    };
  },
  
  // Security headers for all routes
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=(self)' },
        ],
      },
    ];
  },
};

export default nextConfig;
