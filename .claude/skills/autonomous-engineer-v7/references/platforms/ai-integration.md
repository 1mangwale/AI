# AI Integration Patterns (2026)

## Before Coding
```bash
# ALWAYS search first — AI moves FAST
Search: "openai gpt latest model 2026"
Search: "anthropic claude latest model"
Search: "vercel ai sdk latest features"
Search: "[use case] best llm model 2026"
```

---

## 2026 AI Landscape (Quick Reference)

### Models
| Provider | Model | Best For | Cost |
|----------|-------|----------|------|
| OpenAI | GPT-4o | General, vision | $$$ |
| OpenAI | GPT-4o-mini | Fast, cheap | $ |
| Anthropic | Claude 3.5 Sonnet | Coding, analysis | $$ |
| Anthropic | Claude 3 Haiku | Fast, cheap | $ |
| Google | Gemini 1.5 Pro | Long context | $$ |
| Local | Llama 3.1 70B | Privacy, offline | Free (compute) |

### When to Use What
```
CHAT/ASSISTANT:     GPT-4o or Claude Sonnet
FAST RESPONSES:     GPT-4o-mini or Claude Haiku
CODE GENERATION:    Claude Sonnet (best at coding)
LONG DOCUMENTS:     Gemini 1.5 Pro (1M context)
PRIVACY REQUIRED:   Local Llama or Mistral
STRUCTURED OUTPUT:  GPT-4o with JSON mode
VISION/IMAGES:      GPT-4o or Claude Sonnet
```

---

## Architecture Pattern

```
┌─────────────────────────────────────────────────────────┐
│  Client Request                                         │
└─────────────────────────┬───────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────┐
│  AI Gateway / Router                                    │
│  - Check budget                                         │
│  - Select model (cost/quality/latency)                  │
│  - Load prompt from DB                                  │
└─────────────────────────┬───────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────┐
│  LLM Provider (OpenAI / Anthropic / Local)              │
│  - Streaming response                                   │
│  - Tool/function calls                                  │
└─────────────────────────┬───────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Post-Processing                                        │
│  - Log usage + cost                                     │
│  - Cache if applicable                                  │
│  - Validate output                                      │
└─────────────────────────────────────────────────────────┘
```

---

## Key Patterns

### 1. Prompts in Database (versioned)
```sql
-- ai_prompts table
CREATE TABLE ai_prompts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         VARCHAR(100) UNIQUE NOT NULL,  -- 'order-summary', 'chat-system'
  version     INTEGER NOT NULL DEFAULT 1,
  template    TEXT NOT NULL,
  model       VARCHAR(50),                    -- default model for this prompt
  max_tokens  INTEGER,
  temperature DECIMAL(2,1),
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Usage: SELECT * FROM ai_prompts WHERE key = 'chat-system' AND active = true;
```

```typescript
// services/prompt.service.ts
class PromptService {
  async get(key: string): Promise<Prompt> {
    const cached = await redis.get(`prompt:${key}`);
    if (cached) return JSON.parse(cached);

    const prompt = await db.aiPrompt.findFirst({
      where: { key, active: true },
      orderBy: { version: 'desc' },
    });

    await redis.setex(`prompt:${key}`, 300, JSON.stringify(prompt));
    return prompt;
  }

  render(template: string, vars: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
  }
}
```

### 2. Cost Tracking
```sql
-- ai_cost_log table
CREATE TABLE ai_cost_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id),
  model        VARCHAR(50) NOT NULL,
  prompt_key   VARCHAR(100),
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd     DECIMAL(10,6) NOT NULL,
  latency_ms   INTEGER,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Monthly budget
CREATE TABLE ai_budgets (
  id             UUID PRIMARY KEY,
  scope          VARCHAR(50) NOT NULL,  -- 'global', 'user:123', 'tenant:456'
  monthly_limit  DECIMAL(10,2) NOT NULL,
  alert_at_pct   INTEGER DEFAULT 80
);
```

```typescript
// services/cost-tracker.ts
const PRICING = {
  'gpt-4o': { input: 0.005, output: 0.015 },        // per 1K tokens
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
  'claude-3-haiku': { input: 0.00025, output: 0.00125 },
};

class CostTracker {
  async log(model: string, usage: { inputTokens: number; outputTokens: number }) {
    const pricing = PRICING[model];
    const cost = 
      (usage.inputTokens / 1000) * pricing.input +
      (usage.outputTokens / 1000) * pricing.output;

    await db.aiCostLog.create({
      data: { model, ...usage, costUsd: cost },
    });

    return cost;
  }

  async checkBudget(scope: string): Promise<boolean> {
    const budget = await db.aiBudget.findUnique({ where: { scope } });
    if (!budget) return true;

    const spent = await this.getMonthlyTotal(scope);
    return spent < budget.monthlyLimit;
  }
}
```

### 3. Model Router (cost/quality tradeoff)
```typescript
// services/model-router.ts
type RouteStrategy = 'quality' | 'balanced' | 'cost';

const ROUTES: Record<RouteStrategy, string[]> = {
  quality: ['gpt-4o', 'claude-3-5-sonnet'],
  balanced: ['gpt-4o-mini', 'claude-3-haiku', 'gpt-4o'],
  cost: ['gpt-4o-mini', 'claude-3-haiku'],
};

class ModelRouter {
  async route(strategy: RouteStrategy, fallback = true): Promise<string> {
    const models = ROUTES[strategy];
    
    for (const model of models) {
      if (await this.isAvailable(model)) {
        return model;
      }
    }

    if (fallback) return models.at(-1)!;
    throw new Error('No models available');
  }

  private async isAvailable(model: string): Promise<boolean> {
    // Check rate limits, health, etc.
    return true;
  }
}
```

### 4. Streaming (always for user-facing)
```typescript
// Next.js API route with Vercel AI SDK
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { messages, promptKey } = await req.json();

  // Load prompt from DB
  const systemPrompt = await promptService.get(promptKey);

  // Check budget
  if (!await costTracker.checkBudget(`user:${userId}`)) {
    return new Response('Budget exceeded', { status: 429 });
  }

  const result = await streamText({
    model: openai('gpt-4o'),
    system: systemPrompt.template,
    messages,
    onFinish: async ({ usage }) => {
      await costTracker.log('gpt-4o', {
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
      });
    },
  });

  return result.toDataStreamResponse();
}
```

### 5. RAG (Retrieval Augmented Generation)
```typescript
// services/rag.service.ts
class RAGService {
  constructor(
    private embeddings: EmbeddingsService,
    private vectorDb: VectorDbService,
  ) {}

  async query(question: string, options: { topK?: number } = {}) {
    // 1. Embed the question
    const questionEmbedding = await this.embeddings.embed(question);

    // 2. Search similar documents
    const docs = await this.vectorDb.search(questionEmbedding, {
      topK: options.topK ?? 5,
    });

    // 3. Build context
    const context = docs.map(d => d.content).join('\n\n');

    // 4. Generate answer with context
    const prompt = await promptService.get('rag-qa');
    const rendered = promptService.render(prompt.template, {
      context,
      question,
    });

    return this.llm.complete(rendered);
  }

  async ingest(documents: Document[]) {
    for (const doc of documents) {
      // Chunk document
      const chunks = this.chunk(doc.content, { maxTokens: 500 });
      
      // Embed each chunk
      for (const chunk of chunks) {
        const embedding = await this.embeddings.embed(chunk);
        await this.vectorDb.upsert({
          id: `${doc.id}-${chunk.index}`,
          embedding,
          content: chunk.text,
          metadata: { docId: doc.id, ...doc.metadata },
        });
      }
    }
  }
}
```

### 6. Tool Use / Function Calling
```typescript
// Structured tool definition
const tools = [
  {
    type: 'function',
    function: {
      name: 'search_orders',
      description: 'Search customer orders by status or date',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'shipped', 'delivered'] },
          dateFrom: { type: 'string', format: 'date' },
          dateTo: { type: 'string', format: 'date' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_support_ticket',
      description: 'Create a support ticket for the customer',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['subject'],
      },
    },
  },
];

// Execute tool calls
async function executeTool(name: string, args: any) {
  switch (name) {
    case 'search_orders':
      return orderService.search(args);
    case 'create_support_ticket':
      return ticketService.create(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

### 7. Structured Output (JSON mode)
```typescript
import { generateObject } from 'ai';
import { z } from 'zod';

const ProductSchema = z.object({
  name: z.string(),
  description: z.string(),
  price: z.number(),
  category: z.enum(['electronics', 'clothing', 'food']),
  tags: z.array(z.string()),
});

const result = await generateObject({
  model: openai('gpt-4o'),
  schema: ProductSchema,
  prompt: 'Generate a product listing for a wireless mouse',
});

// result.object is typed as z.infer<typeof ProductSchema>
```

---

## Vector Databases
| DB | Best For | Hosted |
|----|----------|--------|
| pgvector | Postgres users, simple | Supabase, Neon |
| Pinecone | Scale, managed | Yes |
| Weaviate | Hybrid search | Yes + self-host |
| Qdrant | Performance | Yes + self-host |
| Chroma | Local dev, simple | Self-host |

---

## Checklist
```
□ Prompts in DB (not hardcoded)
□ Cost tracking enabled
□ Budget checks before calls
□ Streaming for user-facing
□ Fallback chain configured
□ Rate limiting applied
□ Errors handled gracefully
□ Usage logged for analytics
```

---

## Verify
```bash
# Test prompt loading
curl -X POST /api/chat -d '{"messages":[{"role":"user","content":"hello"}]}'

# Check costs
SELECT SUM(cost_usd) FROM ai_cost_log WHERE created_at > NOW() - INTERVAL '1 month';
```
