import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const hostname = request.headers.get('host') || ''
  
  // Domain-based routing
  if (hostname === 'chat.mangwale.ai' || hostname.startsWith('chat.mangwale.ai:')) {
    // Redirect root to /chat for chat subdomain
    if (request.nextUrl.pathname === '/') {
      return NextResponse.rewrite(new URL('/chat', request.url))
    }
  }
  
  if (hostname === 'admin.mangwale.ai' || hostname.startsWith('admin.mangwale.ai:')) {
    // Redirect root to /admin for admin subdomain
    if (request.nextUrl.pathname === '/') {
      return NextResponse.rewrite(new URL('/admin', request.url))
    }
  }
  
  // shop.mangwale.ai - Root shows shop home
  if (hostname === 'shop.mangwale.ai' || hostname.startsWith('shop.mangwale.ai:')) {
    if (request.nextUrl.pathname === '/') {
      return NextResponse.rewrite(new URL('/shop', request.url))
    }
  }

  // vendor.mangwale.ai - Root shows vendor dashboard
  if (hostname === 'vendor.mangwale.ai' || hostname.startsWith('vendor.mangwale.ai:')) {
    if (request.nextUrl.pathname === '/') {
      return NextResponse.rewrite(new URL('/vendor/dashboard', request.url))
    }
  }

  // rider.mangwale.ai - Root shows rider dashboard
  if (hostname === 'rider.mangwale.ai' || hostname.startsWith('rider.mangwale.ai:')) {
    if (request.nextUrl.pathname === '/') {
      return NextResponse.rewrite(new URL('/rider/dashboard', request.url))
    }
  }

  // For mangwale.ai (root domain), show landing page at /landing
  if (hostname === 'mangwale.ai' || hostname.startsWith('mangwale.ai:')) {
    if (request.nextUrl.pathname === '/') {
      return NextResponse.rewrite(new URL('/landing', request.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - socket.io (websocket)
     */
    '/((?!api|napi|_next/static|_next/image|favicon.ico|socket.io).*)',
  ],
}
