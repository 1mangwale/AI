# Next.js Patterns (2026)

## Before Coding
```bash
# ALWAYS search first
Search: "nextjs 15 app router features"
Search: "nextjs server components best practices"
Search: "nextjs [feature] 2026"
```

---

## Project Structure (App Router)
```
src/
├── app/
│   ├── layout.tsx           # Root layout
│   ├── page.tsx             # Home
│   ├── loading.tsx          # Suspense fallback
│   ├── error.tsx            # Error boundary
│   ├── not-found.tsx        # 404
│   ├── (auth)/              # Route group (no URL segment)
│   │   ├── login/page.tsx
│   │   └── register/page.tsx
│   ├── dashboard/
│   │   ├── layout.tsx       # Nested layout
│   │   ├── page.tsx
│   │   └── settings/page.tsx
│   └── api/
│       └── [...trpc]/route.ts  # tRPC or API routes
├── components/
│   ├── ui/                  # Shadcn/UI components
│   └── [feature]/           # Feature components
├── lib/
│   ├── db.ts                # Prisma client
│   ├── auth.ts              # Auth config
│   ├── ai.ts                # AI client
│   └── utils.ts             # Helpers
├── server/
│   ├── actions/             # Server Actions
│   ├── queries/             # Data fetching
│   └── trpc/                # tRPC routers
└── hooks/                   # Client hooks
```

---

## Key 2026 Patterns

### 1. Server Components (default)
```tsx
// app/dashboard/page.tsx
// This is a SERVER component by default (no "use client")

import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { DashboardMetrics } from './metrics';

export default async function DashboardPage() {
  const session = await auth();
  if (!session) redirect('/login');

  // Direct DB access in server component
  const metrics = await db.metric.aggregate({
    where: { userId: session.user.id },
    _sum: { revenue: true },
    _count: { orders: true },
  });

  return (
    <div>
      <h1>Dashboard</h1>
      <DashboardMetrics data={metrics} />
    </div>
  );
}
```

### 2. Server Actions (mutations)
```tsx
// server/actions/orders.ts
'use server';

import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const CreateOrderSchema = z.object({
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.number().min(1),
  })),
});

export async function createOrder(formData: FormData) {
  const session = await auth();
  if (!session) throw new Error('Unauthorized');

  const data = CreateOrderSchema.parse({
    items: JSON.parse(formData.get('items') as string),
  });

  const order = await db.$transaction(async (tx) => {
    // Create order logic
    const order = await tx.order.create({
      data: {
        userId: session.user.id,
        items: { create: data.items },
      },
    });
    return order;
  });

  revalidatePath('/orders');
  return { success: true, orderId: order.id };
}

// Usage in component:
// <form action={createOrder}>...</form>
```

### 3. Data Fetching (cached by default)
```tsx
// server/queries/products.ts
import { db } from '@/lib/db';
import { unstable_cache } from 'next/cache';

export const getProducts = unstable_cache(
  async (categoryId?: string) => {
    return db.product.findMany({
      where: categoryId ? { categoryId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  },
  ['products'],
  { revalidate: 60, tags: ['products'] }
);

// Revalidate when needed:
// revalidateTag('products');
```

### 4. Client Components (interactive)
```tsx
// components/cart/add-to-cart.tsx
'use client';

import { useTransition } from 'react';
import { addToCart } from '@/server/actions/cart';
import { Button } from '@/components/ui/button';

export function AddToCartButton({ productId }: { productId: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      disabled={isPending}
      onClick={() => startTransition(() => addToCart(productId))}
    >
      {isPending ? 'Adding...' : 'Add to Cart'}
    </Button>
  );
}
```

### 5. tRPC Integration (type-safe API)
```tsx
// server/trpc/routers/orders.ts
import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';

export const ordersRouter = router({
  list: protectedProcedure
    .input(z.object({ cursor: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.order.findMany({
        where: { userId: ctx.session.user.id },
        take: 20,
        cursor: input.cursor ? { id: input.cursor } : undefined,
      });
    }),
    
  create: protectedProcedure
    .input(CreateOrderSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.db.order.create({ data: { ...input, userId: ctx.session.user.id } });
    }),
});

// Client usage:
// const { data } = trpc.orders.list.useQuery({});
```

### 6. AI Streaming (Vercel AI SDK)
```tsx
// app/api/chat/route.ts
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = await streamText({
    model: openai('gpt-4o'),
    messages,
    system: await getPromptFromDB('chat-system'),
  });

  return result.toDataStreamResponse();
}

// Client component:
'use client';
import { useChat } from 'ai/react';

export function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();
  
  return (
    <form onSubmit={handleSubmit}>
      {messages.map(m => <div key={m.id}>{m.content}</div>)}
      <input value={input} onChange={handleInputChange} />
    </form>
  );
}
```

### 7. Middleware (auth, redirects)
```tsx
// middleware.ts
import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';

export default auth((req) => {
  const isLoggedIn = !!req.auth;
  const isAuthPage = req.nextUrl.pathname.startsWith('/login');
  const isDashboard = req.nextUrl.pathname.startsWith('/dashboard');

  if (isDashboard && !isLoggedIn) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  if (isAuthPage && isLoggedIn) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }
});

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
```

---

## Component Rules
```
SERVER COMPONENT (default):
✓ Data fetching
✓ DB access
✓ Secret access
✗ useState, useEffect
✗ Browser APIs
✗ Event handlers

CLIENT COMPONENT ("use client"):
✓ Interactivity
✓ Hooks
✓ Browser APIs
✗ Direct DB access
✗ Secrets in code
```

---

## Caching Strategy
| What | How | Revalidate |
|------|-----|------------|
| Static pages | Default | Build time |
| Dynamic pages | `export const dynamic = 'force-dynamic'` | Every request |
| API data | `unstable_cache()` | Time-based or tag |
| Mutations | Server Actions + `revalidatePath/Tag` | On demand |

---

## Verify
```bash
# Dev
npm run dev

# Build (catches errors)
npm run build

# Test
npm run test
```
