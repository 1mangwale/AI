# MangwaleAI — Comprehensive Stack Audit

> **Generated**: 2026-02-26 | **Status**: Production (chat.mangwale.ai LIVE)
> **Repository**: github.com/skyagarwal/MangwaleAI (private)

---

## 1. Architecture Overview

### Service Topology

```
                         ┌─────────────────────────────┐
                         │        INTERNET              │
                         │  chat.mangwale.ai            │
                         │  admin.mangwale.ai           │
                         │  mangwale.ai                 │
                         └─────────┬───────────────────┘
                                   │ HTTPS (443)
                         ┌─────────▼───────────────────┐
                         │      Traefik (Docker)        │
                         │   Reverse Proxy + TLS/ACME   │
                         │   :80 → :443 redirect        │
                         └──┬──────────┬───────────────┘
                            │          │
              ┌─────────────▼──┐   ┌───▼──────────────────┐
              │  Next.js 16    │   │   NestJS Backend      │
              │  Frontend      │   │   (PM2, port 3200)    │
              │  (Docker:3005) │   │   73 modules           │
              │  106 pages     │   │   Socket.io WebSocket  │
              │  121 API routes│   │                        │
              └────────────────┘   └──┬──┬──┬──┬──┬──┬────┘
                                      │  │  │  │  │  │
          ┌───────────────────────────┘  │  │  │  │  └─────────────────┐
          │                              │  │  │  │                    │
   ┌──────▼──────┐  ┌──────────────▼─┐  │  │  │  │  ┌────────────────▼──┐
   │ PostgreSQL  │  │  Redis 7.2     │  │  │  │  │  │  Search API       │
   │ :5432       │  │  :6381         │  │  │  │  │  │  :3100 (NestJS)   │
   │ Sessions,   │  │  Session cache │  │  │  │  │  │  Hybrid BM25+KNN  │
   │ Flows, NLU  │  │  24h TTL       │  │  │  │  │  └──────┬───────────┘
   └─────────────┘  └────────────────┘  │  │  │  │         │
                                        │  │  │  │  ┌──────▼───────────┐
          ┌─────────────────────────────┘  │  │  │  │  OpenSearch 2.13 │
          │                                │  │  │  │  BM25 + HNSW KNN │
   ┌──────▼──────────┐                    │  │  │  │  16K food items   │
   │  PHP Laravel     │                    │  │  │  └──────────────────┘
   │  103.160.107.208 │                    │  │  │
   │  Orders, Auth    │                    │  │  │
   │  MySQL :3307     │                    │  │  └──────────────────────┐
   └──────────────────┘                    │  │                        │
                                           │  │  ┌────────────────────▼─┐
          ┌────────────────────────────────┘  │  │  vLLM (Docker)       │
          │                                   │  │  Qwen 2.5-7B AWQ     │
   ┌──────▼───────────────────────────┐      │  │  :8002                │
   │  Mercury GPU (192.168.0.151)     │      │  └──────────────────────┘
   │  RTX 3060 12GB                   │      │
   │                                  │      │  ┌──────────────────────┐
   │  NLU  :7012 (IndicBERTv2 BERT)  │      └──▶  Cloud LLMs          │
   │  NER  :7011 (MuRIL, 11 labels)  │         │  Groq, OpenAI,       │
   │  ASR  :7001 (Whisper)            │         │  Claude, Gemini,     │
   │  TTS  :7002 (Kokoro+Chatterbox) │         │  DeepSeek, Grok      │
   │  Voice:7000 (Orchestrator)       │         └──────────────────────┘
   │  Train:8082 (Training Server)    │
   └──────────────────────────────────┘
```

### Port Map (All Services)

| Port | Service | Host | Protocol |
|------|---------|------|----------|
| 80 | Traefik HTTP | Docker | HTTP → HTTPS redirect |
| 443 | Traefik HTTPS | Docker | TLS (Let's Encrypt ACME) |
| 3005 | Next.js Frontend | Docker (`mangwale-dashboard`) | HTTP |
| 3100 | Search API | Docker (`search-api`) | HTTP |
| 3101 | Embedding Service | Docker (`search-embedding-service`) | HTTP |
| 3200 | NestJS Backend | PM2 (host) | HTTP + WebSocket |
| 5432 | PostgreSQL | Docker (`mangwale_dev_postgres`) | TCP |
| 6381 | Redis | Docker (`mangwale_dev_redis`) | TCP |
| 8002 | vLLM (Qwen 7B) | Docker (`mangwale_vllm`) | HTTP (OpenAI-compat) |
| 8080 | Label Studio | Docker (`mangwale_dev_labelstudio`) | HTTP |
| 8888 | Traefik Dashboard | Docker | HTTP |
| 9000 | MinIO S3 | Docker (`mangwale_dev_minio`) | HTTP |
| 7012 | NLU (IndicBERTv2) | Mercury (192.168.0.151) | HTTP |
| 7011 | NER (MuRIL) | Mercury (192.168.0.151) | HTTP |
| 7001 | ASR (Whisper) | Mercury (192.168.0.151) | HTTP |
| 7002 | TTS (Kokoro/Chatterbox) | Mercury (192.168.0.151) | HTTP |
| 7000 | Voice Orchestrator | Mercury (192.168.0.151) | HTTP/WS |
| 8082 | Training Server | Mercury (192.168.0.151) | HTTP |

### Network Topology

- **Docker bridge**: Internal container networking via compose networks
- **traefik_default**: Shared network for Traefik routing
- **search_search-network** (172.25.0.0/16): Search stack internal
- **mangwale_unified_network**: Cross-stack communication
- **Tailscale**: Jupiter (this server) ↔ Mercury GPU server (192.168.0.151)
- **Public**: 103.160.107.208 (PHP Laravel backend)

### Docker Containers (20 running)

| Container | Status | Purpose |
|-----------|--------|---------|
| mangwale-dashboard | Up | Next.js frontend (port 3005) |
| traefik | Up | Reverse proxy (80/443) |
| search-api | Up (healthy) | Search API (port 3100) |
| search-opensearch | Up (healthy) | OpenSearch 2.13 |
| search-embedding-service | Up (healthy) | Embedding models |
| search-redpanda | Up (healthy) | Kafka-compatible broker |
| search-kafka-connect | Up (healthy) | Debezium CDC |
| search-cdc-consumer | Up | CDC → OpenSearch sync |
| search-poll-sync | Up | Fallback MySQL polling |
| search-mysql | Up (healthy) | MySQL 8.0 (search) |
| search-redis | Up (healthy) | Redis (search cache) |
| search-clickhouse | Up (healthy) | ClickHouse analytics |
| mangwale_dev_postgres | Up (healthy) | PostgreSQL (sessions, flows) |
| mangwale_dev_redis | Up (healthy) | Redis (session cache) |
| mangwale_dev_minio | Up (healthy) | MinIO S3 storage |
| mangwale_dev_labelstudio | Up | Label Studio |
| mangwale_vllm | Up | vLLM Qwen 2.5-7B |
| spa | Up | Static page |

---

## 2. NestJS Backend (73 Modules)

### Module Catalog by Category

#### Core Infrastructure (5)
| Module | Description |
|--------|-------------|
| DatabaseModule | PostgreSQL (Prisma) + conversation logging |
| ConfigModule | Dynamic runtime config, feature flags, A/B tests |
| ConfigValidationModule | Environment variable validation on startup |
| RedisModule | Centralized Redis pool (3 connections: client, subscriber, publisher) |
| CommonModule | Feature flags, circuit breaker, request queue, audit logging |

#### Auth & Security (1)
| Module | Description |
|--------|-------------|
| AuthModule | OTP login, centralized auth, user profile enrichment |

#### Channels (6)
| Module | Description |
|--------|-------------|
| WhatsAppModule | WhatsApp Cloud API (messages, voice, catalogs, flows) |
| TelegramModule | Telegram webhook (text + voice transcription via ASR) |
| SmsModule | SMS via MSG91/Twilio (DLT compliance) |
| VoiceModule | Voice IVR (Twilio/Exotel, ASR→AI→TTS pipeline) |
| InstagramModule | Instagram DM via Meta Messaging API |
| MessagingModule | Unified gateway (5-step smart routing, SYNC/ASYNC) |

#### NLU/NER Pipeline (1)
| Module | Description |
|--------|-------------|
| NluModule | IndicBERTv2 (39 intents, 82.26% accuracy) + MuRIL NER (11 labels, F1=0.95) + LLM fallback |

#### LLM & AI (3)
| Module | Description |
|--------|-------------|
| LlmModule | vLLM local + Cloud (OpenAI, Groq, Claude, Gemini, DeepSeek, Grok) with smart routing |
| AiModule | Vector memory (OpenSearch k-NN) + semantic caching |
| HealingModule | Self-healing (log analysis, error repair via LLM) |

#### Search & Discovery (1)
| Module | Description |
|--------|-------------|
| SearchModule | Hybrid search (OpenSearch BM25+KNN), analytics, suggestions, AI agent search |

#### Commerce & Orders (4)
| Module | Description |
|--------|-------------|
| OrderFlowModule | Order orchestration (state machine, payment, wallet, loyalty, coupons, BullMQ queues) |
| OrderModule | Order intelligence (complex parsing, group optimization, recommendations) |
| ParcelModule | Parcel delivery booking |
| PricingModule | Dynamic pricing, savings calculation vs competitors |

#### Payment (1)
| Module | Description |
|--------|-------------|
| PaymentModule | Razorpay webhooks (captured/failed/refund), UPI deep links, WhatsApp notifications |

#### Delivery & Logistics (2)
| Module | Description |
|--------|-------------|
| RoutingModule | Distance/time estimation via OSRM |
| ZonesModule | Zone detection, validation, store filtering by delivery zones |

#### PHP Integration (1)
| Module | Description |
|--------|-------------|
| PhpIntegrationModule | Auth, orders, payments, wallet, loyalty, coupons, reviews, stores, MySQL sync |

#### Conversation & Flows (3)
| Module | Description |
|--------|-------------|
| ConversationModule | Channel-agnostic conversation engine, auth bridge, user type routing |
| FlowEngineModule | State machine (40 executors, 26 flows, TypeScript + YAML V2) |
| FlowManagementModule | Flow builder, executor, validation services |

#### Gamification & Reviews (3)
| Module | Description |
|--------|-------------|
| GamificationModule | Quests, tiers, language master, tone detective, rider gamification |
| ReviewsModule | Sentiment analysis, aspect extraction, Google API, store enrichment |
| ApprovalModule | Approval workflow queue (CRUD API) |

#### Analytics & Monitoring (4)
| Module | Description |
|--------|-------------|
| AnalyticsModule | Conversion funnel, NLU accuracy, response time, order dissection, cohort retention |
| StatsModule | Dashboard statistics |
| MonitoringModule | Prometheus, Sentry, Loki, Docker metrics |
| MetricsModule | Global Prometheus metrics (gateway, channel, routing, errors) |

#### User/Context (4)
| Module | Description |
|--------|-------------|
| UserModule | AI user persistence, PHP→AI sync, preferences, conversation history |
| PersonalizationModule | LLM preference extraction, RFM scoring, behavioral analytics, recommendations |
| UserContextModule | Weather, date/time, festivals, city knowledge, local slang |
| VisitorModule | UUID tracking, device fingerprinting, cross-device merging |

#### Platform (3)
| Module | Description |
|--------|-------------|
| BroadcastModule | WhatsApp campaigns (timing, reorder triggers, weather/festival-based) |
| SchedulerModule | mOS scheduler (cron, auto-actions, smart discounts, campaign triggers) |
| ActionEngineModule | mOS action engine (asset generation, ad execution, approval gates) |

#### Admin & mOS (4)
| Module | Description |
|--------|-------------|
| AdminModule | JWT/OTP auth, roles, API keys, webhooks, activity logging |
| LearningModule | Mistake tracking, auto-approval, retraining, Label Studio |
| WhiteLabelModule | Multi-tenant branding (logos, colors, domains, CSS) |
| DataSourcesModule | Dynamic data source management for AI agents |

#### Utilities (7)
| Module | Description |
|--------|-------------|
| AsrModule | Speech-to-Text (Whisper local + cloud) |
| TtsModule | Text-to-Speech (XTTS local + cloud, voice presets) |
| VoiceCharactersModule | Voice persona management |
| ContextModule | User context (weather, festivals, local awareness) |
| StoresModule | Store schedules, hours, status |
| SettingsModule | System settings, connection tests |
| ModelsModule | AI models registry |

#### Advanced (5)
| Module | Description |
|--------|-------------|
| ExotelModule | Cloud telephony (IVR, click-to-call, number masking, AI voice calls) |
| TrainingModule | Model training pipeline (HuggingFace, Label Studio, datasets) |
| OrchestratorModule | Search orchestrator (OpenSearch vs PHP routing by intent) |
| ScraperModule | Competitor scraping (pricing, reviews, knowledge pipeline) |
| MarketingModule | Social trend analysis, ad attribution |

#### AI Agents (2)
| Module | Description |
|--------|-------------|
| AgentsModule | 7 agent types (FAQ, Search, Order, Complaints, Booking, Vendor, Rider) with tool-use, ReAct |
| DemandModule | Demand forecasting, dynamic pricing, smart discounts |

#### Session & Chat (2)
| Module | Description |
|--------|-------------|
| SessionModule | Redis-backed sessions, session identifier, sync service |
| ChatModule | WebSocket gateway (Socket.io, personalized init, LLM streaming) |

#### Testing, Health, Advanced Intelligence (6)
| Module | Description |
|--------|-------------|
| TestingModule | E2E testing endpoints for AI flows |
| HealthModule | Health checks (PHP, DB, sessions) |
| IntegrationsModule | Optional HTTP clients (payment, routing, Google Places) |
| ProfilesModule | Store/vendor/rider profile sync + scraper enrichment |
| StrategyModule | Strategy ledger, institutional memory for operations |
| McpModule | Model Context Protocol server (exposes commerce as MCP tools) |

---

## 3. Flow Engine

### Flow Definitions (26 active)

#### TypeScript Flows (18)
| Flow | Lines | Purpose |
|------|-------|---------|
| food-order.flow.ts | 6,300 | Food ordering with COD fallback & payment selection |
| parcel-delivery.flow.ts | 2,712 | Parcel/courier booking |
| order-tracking.flow.ts | 904 | Order history & real-time tracking |
| ecommerce-order.flow.ts | 886 | E-commerce with UPI/COD selection |
| support.flow.ts | 681 | Customer support & escalation |
| first-time-onboarding.flow.ts | 640 | New user onboarding |
| address-management.flow.ts | 518 | Address collection & management |
| auth.flow.ts | 345 | OTP-based authentication |
| campaign-action.flow.ts | 318 | mOS campaign execution |
| cart-recovery.flow.ts | 286 | Abandoned cart recovery |
| profile.flow.ts | 242 | Progressive profile collection |
| game-intro.flow.ts | 221 | Gamification intro & rewards |
| feedback.flow.ts | 134 | User feedback collection |
| chitchat.flow.ts | 107 | Casual conversation handler |
| greeting.flow.ts | 106 | Welcome with context injection |
| help.flow.ts | 85 | Help request handling |
| farewell.flow.ts | 71 | Conversation closure |

#### YAML V2 Flows (8)
| Flow | Lines | Module | Purpose |
|------|-------|--------|---------|
| delivery-orders.flow.yaml | 752 | delivery | Delivery partner order assignment |
| location-collection.flow.yaml | 543 | general | Address collection (Google Maps) |
| payment-completion.flow.yaml | 466 | general | Post-order payment verification |
| vendor-orders.flow.yaml | 428 | vendor | Vendor order management |
| customer-order-status.flow.yaml | 371 | customer | Customer order tracking |
| delivery-auth.flow.yaml | 318 | delivery | Delivery partner login |
| vendor-auth.flow.yaml | 304 | vendor | Vendor portal auth |
| user-type-detection.flow.yaml | 237 | general | Route users to role-specific flow |

### Action Executors (40)

| Category | Executors |
|----------|-----------|
| **Core** (6) | llm, nlu, pure-ner, search, response, agent |
| **User/Session** (4) | auth, session, profile, preference |
| **Address** (4) | address, saved-address-selector, distance, zone |
| **Search/Parse** (5) | multi-store-search, external-search, entity-resolution, complex-order-parser, group-order-search |
| **Cart** (4) | cart-manager, auto-cart, inventory, collections |
| **Order/Price** (4) | order, pricing, value-proposition, parcel |
| **NLU/Logic** (3) | nlu-condition, selection, adaptive |
| **Gamification** (3) | game, recommendation, quick-reorder |
| **Backend** (1) | php-api |
| **mOS/Notify** (6) | asset-generation, ad-execution, approval-gate, whatsapp-notify, broadcast, voice |

### State Machine Architecture

```
Flow Execution:
1. Load flow definition (5-min cache)
2. Create FlowRun record in PostgreSQL
3. Initialize FlowContext (user + system state)
4. Inject location, platform, conversation history

State Loop:
1. Check intent interruption (flow switching)
2. Execute state actions (via executors)
3. Evaluate conditions for transitions
4. Handle validation failures
5. Persist context to FlowRun
6. Transition → next state

Error Handling:
- Retry with exponential backoff (max 3)
- Strategies: continue | fail | retry
- Error context preserved in FlowContext
```

---

## 4. NLU/NER Learning Pipeline

### Models

| Model | Architecture | Params | Data | Accuracy | Location |
|-------|-------------|--------|------|----------|----------|
| NLU v9 | IndicBERTv2 (BERT) | 278M | 5,896 samples, 39 intents | 82.26% acc, 82.05% F1 | Mercury ~/mangwale-ai/models/indicbert_active |
| NER v7 | MuRIL (BERT) | ~110M | 1,066 samples, 11 labels | F1=0.95 | Mercury ~/mangwale-ai/models/ner_v7 |

### NLU Inference Pipeline

```
User Message
    │
    ▼
Heuristics (regex patterns for common intents)
    │ (if no match)
    ▼
IndicBERTv2 BERT (Mercury:7012, 39 intents)
    │ confidence < 0.65?
    ▼
LLM Fallback (vLLM Qwen 7B or Groq)
    │ (if still uncertain)
    ▼
Final Heuristics
```

### NER Labels (11)
`O, B-FOOD, I-FOOD, B-STORE, I-STORE, B-LOC, I-LOC, B-QTY, I-QTY, B-PREF, I-PREF`

### Self-Learning Loop

```
User Interaction → MistakeTracker → CorrectionTracker
    → Auto-Approval (if pattern matches)
    → Label Studio (if manual review needed)
    → RetrainingCoordinator → Training Server (Mercury:8082)
    → Model deployed → NLU service reloaded
```

### Training Scripts (Mercury ~/nlu-training/)
- `train_nlu_production.py` — IndicBERTv2, full fine-tune, 12 epochs, LR=3e-5
- `train_ner_v5_FIXED.py` — MuRIL NER, weighted trainer, 30 epochs

---

## 5. Search Stack

### Architecture

```
MySQL (PHP Backend, 103.160.107.208)
    │ binlog (ROW format)
    ▼
Debezium CDC (Kafka Connect)
    │
    ▼
Redpanda (Kafka-compatible)
    │
    ▼
CDC Consumer (Node.js)
    │ vectorize + enrich
    ▼
OpenSearch 2.13 (BM25 + HNSW KNN)
    │
    ▼
Search API (NestJS :3100)
```

### Search Features

| Feature | Implementation |
|---------|---------------|
| **Hybrid Search** | BM25 full-text + KNN vector (cosine similarity) |
| **Food Embeddings** | `jonny9f/food_embeddings` (768D, 99.1% Pearson) |
| **Ecom Embeddings** | `all-MiniLM-L6-v2` (384D) |
| **Synonyms** | 120+ groups (Hindi/Marathi/English food terms) |
| **Spell Check** | Levenshtein distance, 100+ term dictionary |
| **Transliteration** | Devanagari ↔ Latin (ITRANS-like + food dictionary) |
| **Query Understanding** | 8-intent classifier, filter recommendation |
| **Autocomplete** | Edge n-gram (2-15 grams) |
| **Geo Search** | Geo-distance filtering (lat/lon + radius) |
| **Zone Isolation** | Multi-tenant zone-based filtering |
| **CDC Sync** | Near real-time (<1s) via Debezium + Redpanda |
| **Poll Sync** | Fallback: 5-second polling from MySQL |

### Index Statistics
- **Food items**: 16,498 indexed
- **E-commerce items**: 225 indexed
- **Food stores**: 242 indexed
- **Modules**: 5 (Food=4, E-commerce=5, Grocery=6, Parcel=3, Pharmacy)

---

## 6. Next.js Frontend

### Overview
- **Framework**: Next.js 16.1.6 (App Router, React 19, Turbopack)
- **State**: Zustand 5 + persist middleware
- **Styling**: Tailwind CSS 4 + shadcn/ui (Radix primitives)
- **Real-time**: Socket.io client 4.8.1
- **Payments**: Razorpay SDK
- **PWA**: Service Worker support

### Page Counts
| Category | Pages |
|----------|-------|
| Public (chat, search, orders, profile, wallet) | 7 |
| Auth | 1 |
| Admin Dashboard | 99 |
| **Total** | **106** |

### Admin Pages (99)
- **Commerce** (9): Items, Stores, Categories CRUD
- **NLU/ML** (12): NLU testing, intents, models, LLM providers/analytics/cost/failover
- **Training** (7): Learning hub, Label Studio, datasets, jobs
- **Search** (9): Analytics, config, indices, testing, data sync, trending
- **Voice/Channels** (11): Voice, characters, Exotel, Nerve, broadcast, channels
- **Analytics** (13): Flow/intent analytics, monitoring, audit logs, agents, AI hub
- **Gamification** (5): Questions, analytics, settings, training samples
- **mOS** (14): Dashboard, approvals, customers, models, operations, campaigns, retention, demand, marketing, riders, scheduler, strategy, WhatsApp commerce
- **Vision** (5): A/B testing, multimodal, dashboard
- **Integrations** (14): Flows editor, Docker, RAG, secrets, webhooks, zones, tenants, scraper

### API Routes (121)
- Vision/Image Processing: 41 routes
- Voice/Audio: 14 routes
- Monitoring/Logging: 8 routes
- Settings/Config: 7 routes
- Auth/Admin: 6 routes
- Search/Discovery: 5 routes
- LLM/AI: 4 routes
- Others: 36 routes

### Key Frontend Components (52)
- Chat UI: 11 (ProductCard, VoiceInput, PaymentButton, RunningCart, etc.)
- Flow Builder: 6 (visual node editor with Decision/LLM/NLU/Voice nodes)
- Admin: 8 (agent detail tabs, modals, wizards)
- UI Primitives: 8 (shadcn/ui)
- Shared: 7 (ErrorBoundary, RoleGuard, Toast, etc.)
- Map/Location: 3 (LocationPicker, OSM, PlacesAutocomplete)

---

## 7. Payment & Order Pipeline

### End-to-End Flow

```
User Message ("I want biryani")
    │
    ▼
NLU → intent: search_food
    │
    ▼
Search API → hybrid BM25+KNN results
    │
    ▼
Flow Engine → food_order_v1 flow
    │
    ├─ Store selection
    ├─ Cart building (add/remove/modify)
    ├─ Address collection (saved or new via Google Maps)
    ├─ Zone validation (point-in-polygon via PHP)
    ├─ Price calculation (items + delivery + tax)
    │
    ▼
Payment Selection
    ├─ UPI/Online → Razorpay payment link
    │   ├─ Success → webhook: payment.captured
    │   └─ Timeout → COD fallback
    └─ COD → Direct order
    │
    ▼
Order Creation → PHP Backend API
    │
    ▼
WhatsApp Notifications
    ├─ Order Confirmed
    ├─ Order Picked Up
    └─ Order Delivered
```

### Razorpay Webhooks
- `payment.captured` → Order confirmed
- `payment.failed` → Payment retry or COD fallback
- `refund.processed` → Refund notification

---

## 8. External Integrations

| Integration | Purpose | Endpoint |
|-------------|---------|----------|
| **PHP Laravel** | Orders, auth, payments, wallet | https://new.mangwale.com |
| **Mercury NLU** | Intent classification (IndicBERTv2) | 192.168.0.151:7012 |
| **Mercury NER** | Entity extraction (MuRIL) | 192.168.0.151:7011 |
| **Mercury ASR** | Speech recognition (Whisper) | 192.168.0.151:7001 |
| **Mercury TTS** | Text-to-speech (Kokoro/Chatterbox/ElevenLabs/Deepgram) | 192.168.0.151:7002 |
| **Mercury Voice** | Voice orchestrator (VAD, turn management) | 192.168.0.151:7000 |
| **Mercury Training** | Model training server | 192.168.0.151:8082 |
| **vLLM** | Local LLM (Qwen 2.5-7B AWQ) | localhost:8002 |
| **Groq** | Cloud LLM (fast inference) | API |
| **OpenAI** | Cloud LLM (GPT-4) | API |
| **Claude** | Cloud LLM (Anthropic) | API |
| **Gemini** | Cloud LLM (Google) | API |
| **DeepSeek** | Cloud LLM | API |
| **Grok** | Cloud LLM (xAI) | API |
| **OpenRouter** | LLM routing | API |
| **WhatsApp Cloud API** | Messaging, catalogs, flows | Meta Graph API v24.0 |
| **Telegram** | Messaging | Bot API |
| **MSG91/Twilio** | SMS (DLT compliant) | API |
| **Razorpay** | Payment gateway | API + webhooks |
| **Google Maps/Places** | Geocoding, address autocomplete | API |
| **Exotel** | Cloud telephony (IVR, AI voice calls) | API |
| **Frappe/ERPNext** | Helpdesk integration | https://erp.sarvin.in |
| **Sentry** | Error tracking | DSN |
| **Label Studio** | Training data annotation | localhost:8080 |
| **MinIO** | S3-compatible object storage | localhost:9000 |
| **ClickHouse** | Analytics OLAP | Docker internal |

---

## 9. Smart Model Router

### Routing Strategy

```
Task → SmartModelRouterService.selectByCapability()
    │
    ├─ Priority 1: vLLM local (Qwen 7B) — free, fastest
    ├─ Priority 2: Groq — fast cloud, low cost
    ├─ Priority 3: OpenAI — highest quality
    └─ Priority 4: Claude/Gemini — fallback
```

### Task Types
| Type | Best Provider | Use Case |
|------|--------------|----------|
| extraction | vLLM | NER, entity parsing |
| classification | vLLM | Intent, sentiment |
| generation | Groq/OpenAI | Chat responses |
| creative | OpenAI/Claude | Marketing copy |
| reasoning | OpenAI/Claude | Complex analysis |
| analysis | vLLM/Groq | Data processing |

### Provider Config (7 providers)
OpenAI, Groq, OpenRouter, Gemini, Claude, DeepSeek, Grok

---

## 10. mOS (Neural Decision Dashboard)

### Implemented (Phase 1)
- **5 admin pages**: Dashboard, Models, Operations, Customers, Approvals
- **ApprovalModule**: `approval_requests` PG table, CRUD API at `/api/approvals`
- **CustomerHealthService**: RFM/churn/LTV scoring via `customer_health_scores` table
- **OrderDissectionService**: PHP MySQL order analytics
- **UnitEconomicsService**: Revenue/cost breakdown per order
- **SmartModelRouter**: Extended with `taskType` routing and `selectByCapability()`

### Planned (Phase 2-5)
- Retention strategies, demand forecasting
- Rider management, marketing optimization
- Multi-tenant operations

---

## 11. Voice Pipeline

```
Audio Input (WhatsApp voice note / Exotel IVR / Web mic)
    │
    ▼
ASR (Mercury:7001, Whisper)
    │ text transcription
    ▼
NLU (Mercury:7012, IndicBERTv2)
    │ intent + entities
    ▼
Flow Engine → state machine processing
    │ response text
    ▼
TTS (Mercury:7002)
    ├─ Kokoro (local, fast)
    ├─ Chatterbox (local, expressive)
    ├─ ElevenLabs (cloud, premium)
    └─ Deepgram (cloud, fast)
    │ audio output
    ▼
Response (voice note / IVR audio / Web playback)
```

---

## 12. Multi-Channel Architecture

### Supported Channels

| Channel | Status | Module | Features |
|---------|--------|--------|----------|
| WhatsApp | Production | WhatsAppModule | Text, voice, images, catalogs, flows, payments |
| Web Chat | Production | ChatModule | Socket.io, real-time, voice, PWA |
| Telegram | Production | TelegramModule | Text, voice transcription |
| SMS | Production | SmsModule | MSG91/Twilio, DLT compliance |
| Voice/IVR | Production | VoiceModule | Exotel/Twilio, ASR→AI→TTS |
| Instagram | Stub | InstagramModule | Meta DM API (basic) |

### Message Flow

```
Any Channel → MessagingModule (unified gateway)
    │
    ├─ Command handling (if /command)
    ├─ SYNC path (simple responses)
    └─ ASYNC path (complex flows)
        │
        ▼
    ContextRouterService (5-step smart routing)
        │
        ├─ Active flow? → FlowEngine (resume)
        ├─ New intent → FlowEngine (start flow)
        ├─ Chitchat → LLM direct response
        └─ Unknown → Agent system
```

---

## 13. Database Schema

### PostgreSQL (localhost:5432)
- **Sessions**: session data, flow state
- **Conversations**: message history, channel info
- **FlowRuns**: flow execution state, context JSON
- **FlowDefinitions**: database-driven flow configs
- **TrainingData**: NLU/NER training samples
- **ApprovalRequests**: mOS approval queue
- **CustomerHealthScores**: RFM/churn/LTV
- **BotConfig**: dynamic configuration

### MySQL (103.160.107.208:3307, readonly)
- **mangwale_db**: Orders, users, products, stores, categories, payments
- Used by PhpIntegrationModule for order verification and data sync

### Redis (localhost:6381)
- Session cache (24h TTL)
- Flow context cache
- Rate limiting counters
- Pub/sub for real-time events

---

## 14. Deployment & Operations

### Process Management
- **PM2**: NestJS backend (`mangwale-backend`, port 3200)
- **Docker Compose**: Frontend, search stack, infrastructure
- **systemd**: Mercury GPU services (NLU, NER, ASR, TTS, training)

### Backups
- PostgreSQL: Daily at 2 AM, 14-day retention, gzip
- Location: `/home/ubuntu/backups/db/`

### Monitoring
- **Sentry**: Error tracking (NestJS)
- **Prometheus**: Metrics collection
- **Loki**: Log aggregation (via Docker)
- **Health endpoints**: `/health` on each service

### Domains
| Domain | Purpose | Backend |
|--------|---------|---------|
| chat.mangwale.ai | Public chat interface | Frontend (3005) + Backend API (3200) |
| admin.mangwale.ai | Admin dashboard | Frontend (3005) |
| mangwale.ai | Landing page | Frontend (3005) |
| new.mangwale.com | PHP Laravel backend | 103.160.107.208 |

---

## 15. Summary Statistics

| Metric | Count |
|--------|-------|
| **NestJS Modules** | 73 |
| **Flow Definitions** | 26 (18 TypeScript + 8 YAML V2) |
| **Flow Executors** | 40 |
| **NLU Intents** | 39 |
| **NER Labels** | 11 |
| **Frontend Pages** | 106 (99 admin + 7 public) |
| **Frontend API Routes** | 121 |
| **Frontend Components** | 52 |
| **Docker Containers** | 20 |
| **LLM Providers** | 7 cloud + 1 local |
| **Search Items Indexed** | 16,723 (food + ecom) |
| **Mercury GPU Services** | 6 (NLU, NER, ASR, TTS, Voice, Training) |
| **External Integrations** | 25+ |
| **Messaging Channels** | 6 (WhatsApp, Web, Telegram, SMS, Voice, Instagram) |
| **Total Backend Code** | ~100K+ lines |
| **Total Flow Engine Code** | ~33K lines |

---

*This audit was generated on 2026-02-26 after fixing the production outage (Redis password mismatch + stale frontend container) and comprehensive codebase analysis.*
