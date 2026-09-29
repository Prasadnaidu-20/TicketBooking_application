# Marquee — Event Ticketing Platform
## Design Document v1 (pre-implementation)

**Author:** acting principal engineer
**Status:** proposed, awaiting sign-off
**Scope:** everything decided before the first line of application code

---

## 0. How to read this document

Sections 1–15 are design. Section 16 is the schedule. Section 17 is the list of things we are deliberately refusing to build, and it is as important as the rest. Section 18 is what we do today.

Every decision below is a recommendation with a stated reason and a stated alternative. If you disagree with one, say so before we start, because five of them are expensive to reverse later (database, ORM, ID strategy, inventory model, monorepo layout) and the rest are cheap.

---

## 1. Product definition

**Marquee is a ticketing platform where event organizers sell admission to scheduled events at physical venues, and customers hold, pay for, and receive tickets that can be scanned at the door.**

Three actors:

| Actor | What they do |
|---|---|
| **Customer** | Browses events, picks seats or a quantity, holds them for a few minutes, pays, receives a scannable ticket |
| **Organizer** | Belongs to an organization, creates venues and seat layouts, publishes events, sets prices and sale windows, sees sales and check-ins |
| **Platform admin** | Approves organizations, handles disputes and refunds, investigates incidents |

The product boundary matters more than the feature list. Marquee sells **primary inventory only**: the organizer is the seller, we take payment on their behalf, and the ticket is non-transferable in v1. We are not building a resale marketplace, not building dynamic pricing, and not building a discovery/recommendation engine. Those all change the domain model significantly, and adding them later is a deliberate project, not an afterthought.

### Why this domain is the right teaching vehicle

Ticketing has a property that most portfolio projects lack: **the correctness bar is absolute and the load profile is pathological.**

For 99% of its life, Marquee is a low-traffic CRUD application. Then a popular event goes on sale, and for ninety seconds you have ten thousand people contending over four thousand rows, all of whom will publicly complain if you sell the same seat twice. There is no way to satisfy that with caching or with more application servers, because the contention is on a shared mutable resource. That is precisely why it teaches transactions, locking, idempotency, queueing, and observability better than a chat app or a blog would: those systems let you get away with being sloppy, and this one does not.

The invariant we design the entire system around:

> **A seat, for a given event, is sold to at most one order. Ever. Under any concurrency, any crash, any duplicate request, any retried webhook.**

Everything else is negotiable.

---

## 2. Functional requirements

Numbered so we can reference them in commits, tests, and ADRs. `[Pn]` marks the phase where it lands.

### FR-1 Accounts and identity
- FR-1.1 Register with email + password `[P3]`
- FR-1.2 Verify email via single-use tokenized link `[P3]`
- FR-1.3 Log in, receive a short-lived access credential and a rotating refresh credential `[P3]`
- FR-1.4 Log out of current device; log out of all devices `[P3]`
- FR-1.5 List active sessions with device/IP/last-seen `[P3]`
- FR-1.6 Request password reset; reset with single-use token; all sessions revoked on reset `[P3]`
- FR-1.7 Update profile (display name, phone) `[P3]`
- FR-1.8 Role-based access: `customer`, `organizer_member`, `organizer_admin`, `platform_admin` `[P3]`

### FR-2 Organizations and venues
- FR-2.1 Create an organization; invite members with a role `[P4]`
- FR-2.2 Create a venue with address and IANA timezone `[P4]`
- FR-2.3 Define a versioned seat layout: sections → rows → seats `[P4]`
- FR-2.4 Sections are either reserved-seating or general-admission with a capacity `[P4]`
- FR-2.5 Publish a layout version; published versions are immutable `[P4]`

### FR-3 Events and inventory
- FR-3.1 Create a draft event bound to a venue and a published layout version `[P4]`
- FR-3.2 Define ticket types with price, currency, section binding, and per-type sale window `[P4]`
- FR-3.3 Publish an event; publishing materializes per-event seat inventory `[P4]`
- FR-3.4 Block individual seats (house seats, broken chairs, accessibility holds) `[P4]`
- FR-3.5 Browse and search published events by text, category, city, and date range `[P4]`
- FR-3.6 View event detail with per-ticket-type availability summary `[P4]`
- FR-3.7 View seat map with per-seat status `[P4]`
- FR-3.8 Cancel an event, which triggers full refunds for all paid orders `[P8]`

### FR-4 Booking
- FR-4.1 Hold specific seats for a bounded window `[P5]`
- FR-4.2 Hold a quantity of general-admission tickets for a bounded window `[P5]`
- FR-4.3 Best-available seat selection ("give me 3 together in this section") `[P5]`
- FR-4.4 Holds expire automatically and inventory returns to available `[P5]`
- FR-4.5 Customer may voluntarily release a hold `[P5]`
- FR-4.6 Per-order and per-event-per-customer ticket limits are enforced `[P5]`
- FR-4.7 Hold creation accepts an idempotency key; a retried request returns the original hold, not a second one `[P5]`
- FR-4.8 Convert a hold into an order and initiate payment `[P8]`
- FR-4.9 Issue one ticket per admitted person on payment confirmation `[P8]`
- FR-4.10 View order history and download/display tickets `[P8]`
- FR-4.11 Cancel an unpaid order `[P8]`
- FR-4.12 Request a refund subject to the event's refund policy `[P8]`

### FR-5 Payments
- FR-5.1 Create a provider payment intent for an order, with an idempotency key `[P8]`
- FR-5.2 Collect card details on provider-hosted UI; card data never reaches our servers `[P8]`
- FR-5.3 Confirm orders exclusively from verified provider signals `[P8]`
- FR-5.4 Handle duplicate, out-of-order, and late webhook deliveries without corrupting state `[P8]`
- FR-5.5 Allow a second payment attempt on a failed order while the hold survives `[P8]`
- FR-5.6 Full and partial refunds, tracked to provider refund IDs `[P8]`
- FR-5.7 Daily reconciliation of our payment records against the provider's `[P8]`

### FR-6 Notifications
- FR-6.1 Transactional email: verification, password reset, order confirmation with tickets, refund confirmation, event cancellation `[P9]`
- FR-6.2 All sending is asynchronous and retried; a mail outage never fails a booking `[P9]`

### FR-7 Door operations
- FR-7.1 Validate a ticket code at the door and mark it checked in exactly once `[P11+]`
- FR-7.2 Reject already-used, voided, refunded, and wrong-event tickets with distinguishable reasons `[P11+]`

---

## 3. Non-functional requirements

NFRs without numbers are decoration. These are the numbers we will actually measure, and the load test in Phase 11 exists to prove or disprove them.

### Correctness (non-negotiable)
| ID | Requirement | How verified |
|---|---|---|
| NFR-1.1 | Zero oversell. `sold_count ≤ capacity` for every ticket type at all times | DB `CHECK` constraint + invariant query after every integration run + concurrency test |
| NFR-1.2 | Zero double-sold seats | Composite primary key + status transition rules + concurrency test |
| NFR-1.3 | No paid order without tickets issued, no tickets issued without a paid order | Reconciliation job, alerting on non-zero mismatch |
| NFR-1.4 | Every state transition is legal per the state machine | Transition guard in one place + unit tests over the full transition matrix |
| NFR-1.5 | No money moved twice for one order | Provider idempotency keys + unique constraint on `(provider, provider_event_id)` |

### Performance targets (single API instance, 2 vCPU, PG on same LAN)
| ID | Operation | Target |
|---|---|---|
| NFR-2.1 | Event list / search | p95 ≤ 120 ms, p99 ≤ 300 ms |
| NFR-2.2 | Event detail | p95 ≤ 80 ms |
| NFR-2.3 | Seat map fetch (3,000 seats) | p95 ≤ 250 ms |
| NFR-2.4 | Create hold (uncontended) | p95 ≤ 150 ms |
| NFR-2.5 | Create hold (1,000 concurrent on one event) | p99 ≤ 2,000 ms, error rate ≤ 1% excluding legitimate 409s |
| NFR-2.6 | Sustained read throughput | ≥ 500 rps per instance |
| NFR-2.7 | Hold throughput on one hot event | ≥ 50 successful holds/sec |
| NFR-2.8 | Webhook ack | p99 ≤ 200 ms (we ack, then process asynchronously) |
| NFR-2.9 | Webhook to order-confirmed | p95 ≤ 5 s |

### Availability and recovery
- NFR-3.1 Read paths target 99.9% monthly availability.
- NFR-3.2 Booking degrades gracefully: if Redis is down, rate limiting fails **closed** on auth and **open** on reads, and caching is bypassed. If the queue is down, holds and payments still work and events accumulate in the outbox. If the payment provider is down, we surface a clear error and do not consume inventory.
- NFR-3.3 RPO ≤ 5 minutes, RTO ≤ 1 hour. Verified by an actual restore drill, not by the existence of backups.
- NFR-3.4 Deployments are zero-downtime, and old and new application versions must be able to run against the same schema simultaneously. This constrains every migration we write.

### Consistency model
- **Strongly consistent:** seat and GA inventory, orders, payments, tickets. Single PostgreSQL primary, synchronous, no exceptions.
- **Eventually consistent (bounded staleness, documented):** event listings and search (≤ 60 s), availability summaries on list pages (≤ 5 s), analytics and dashboards (≤ 5 min).
- The seat map the customer sees is **explicitly stale**. The hold attempt is the authority. Every UI affordance is designed around "your click may fail, and that is normal."

### Security and compliance
- NFR-5.1 No cardholder data touches our infrastructure (provider-hosted collection ⇒ PCI DSS SAQ-A scope).
- NFR-5.2 Passwords stored with Argon2id at OWASP-recommended parameters.
- NFR-5.3 PII (email, phone, name, IP) enumerable and deletable for a given user on request.
- NFR-5.4 All secrets injected at runtime; zero secrets in the repository, verified by CI secret scanning.
- NFR-5.5 Every privileged action (refund, event cancel, role change) written to an append-only audit log.

### Operability
- NFR-6.1 Every request carries a correlation ID that appears in every log line, every span, and every error response.
- NFR-6.2 A trace spans HTTP request → database → queue → worker as one connected trace.
- NFR-6.3 Any oversell or invariant violation pages a human immediately. Everything else has a documented severity.
- NFR-6.4 A new engineer can go from `git clone` to a running system with seeded data in one command and under ten minutes.

---

## 4. High-level architecture

### 4.1 Target shape at end of Phase 9

```
                        ┌──────────────────┐
                        │  Browser (React) │
                        └────────┬─────────┘
                                 │ HTTPS
                        ┌────────▼─────────┐
                        │  Reverse proxy   │  TLS, gzip, request-id,
                        │    (Caddy)       │  static assets, body limits
                        └────────┬─────────┘
                                 │
                   ┌─────────────▼─────────────┐
                   │   API (Fastify, Node)     │  stateless, N replicas
                   │  ┌─────────────────────┐  │
                   │  │ modules/            │  │
                   │  │  auth  users  orgs  │  │
                   │  │  venues events      │  │
                   │  │  bookings payments  │  │
                   │  │  notifications      │  │
                   │  └─────────────────────┘  │
                   └──┬────────┬────────┬──────┘
                      │        │        │
        ┌─────────────▼──┐  ┌──▼─────┐  │  ┌───────────────────┐
        │  PostgreSQL    │  │ Redis  │  └─►│ Payment provider  │
        │  primary       │  │        │     │ (Stripe)          │
        │                │  │ cache  │     └─────────┬─────────┘
        │  source of     │  │ locks  │               │ webhooks
        │  truth for     │  │ rate   │◄──────────────┘ (signed)
        │  inventory,    │  │ limits │
        │  orders,       │  └───┬────┘
        │  money,        │      │ BullMQ queues
        │  outbox        │      │
        └───────┬────────┘  ┌───▼──────────────────────┐
                │           │  Workers (same image,    │
                └──────────►│  different entrypoint)   │
              outbox relay  │  • outbox relay          │
                            │  • hold expiry sweeper   │
                            │  • ticket issuance       │
                            │  • email                 │
                            │  • webhook processor     │
                            │  • reconciliation (cron) │
                            └──────────┬───────────────┘
                                       │
                            ┌──────────▼───────────────┐
                            │  OTel Collector          │
                            │  → Prometheus (metrics)  │
                            │  → Tempo (traces)        │
                            │  → Loki (logs)           │
                            │  → Grafana (view/alert)  │
                            └──────────────────────────┘
```

### 4.2 The five architectural commitments

**1. Modular monolith, one codebase, two runtime roles.**
The API and the workers are the same Docker image with different entrypoints (`node dist/api.js` / `node dist/worker.js`). They share the domain layer, the database schema, and the type definitions. They scale and fail independently. This gives us most of the operational benefit of separate services (independent scaling, isolated crash domains, no worker OOM taking down the API) at none of the cost (no network calls between them, no schema versioning across repos, no distributed transaction, single deploy artifact).

Why not microservices now: see §17. Short version: our modules are not independently scalable in any way that matters, our team is one person, and every network boundary we introduce converts a compile-time error into a 3am pager.

**2. PostgreSQL is the only source of truth for anything that matters.**
Inventory, orders, money, tickets. Redis is a cache and a coordination primitive, and it is allowed to lose all its data at any moment without affecting correctness. This is a hard rule and it will be tempting to break it in Phase 6 when someone (me) suggests holding seats in Redis for speed. We will discuss why that is wrong when we get there, in detail, with the failure mode drawn out.

**3. Inventory has two representations, deliberately.**
Reserved seating is row-per-seat and uses row locking. General admission is a counter and uses conditional atomic update. They are different concurrency problems and forcing them into one mechanism makes both worse. Detail in §6.4.

**4. Every external side effect goes through the transactional outbox.**
We never write to the database and publish to a queue in the same logical operation, because there is no way to make those two writes atomic. We write the event to an `outbox` table in the same transaction as the state change, and a relay publishes it. This is the single most important reliability pattern in the project and it appears in Phase 7.

**5. The frontend is a rendering layer with no authority.**
It cannot confirm a payment, cannot decide a hold succeeded, and cannot be trusted about anything. Every claim it makes is re-derived server-side.

---

## 5. Technology stack

### 5.1 Decisions

| Layer | Choice | Version |
|---|---|---|
| Language | TypeScript, `strict: true`, `noUncheckedIndexedAccess: true` | 5.x |
| Runtime | Node.js LTS | 22.x |
| Package manager / repo | pnpm workspaces | 9.x |
| API framework | **Fastify** | 5.x |
| Validation / schema | **Zod** + `fastify-type-provider-zod` | — |
| Database | **PostgreSQL** | 17 |
| DB access | **Drizzle ORM** + `pg` (node-postgres) Pool | — |
| Migrations | drizzle-kit `generate` → hand-reviewed SQL files, applied by a custom runner | — |
| Cache / coordination | **Redis** + ioredis | 7.x |
| Queue | **BullMQ** (Phase 7) | 5.x |
| Payments | **Stripe** test mode, behind a provider port | — |
| Logging | **pino** | 9.x |
| Telemetry | OpenTelemetry SDK → OTel Collector → Prometheus / Tempo / Loki / Grafana | — |
| Testing | **Vitest** + **Testcontainers** + `fastify.inject()` + **Playwright** + **k6** | — |
| Frontend | React 19, Vite, TypeScript, React Router, TanStack Query, React Hook Form + Zod | — |
| Container | Docker multi-stage, distroless or `node:22-slim`, non-root | — |
| Local orchestration | Docker Compose | — |
| CI | GitHub Actions | — |

### 5.2 Justifications for the choices you can push back on

**Fastify over Express.** Three concrete reasons, not benchmarks. First, schema-first routes: you attach a request/response schema to a route, and Fastify validates input and *compiles a fast serializer* for output, which means a response schema also acts as a data-leak guard (fields not in the schema are stripped, so you cannot accidentally serialize `password_hash`). Second, the plugin system has real encapsulation and a defined lifecycle (`onRequest` → `preValidation` → `preHandler` → `handler` → `onSend` → `onResponse`), which gives us obvious homes for auth, rate limiting, and correlation IDs instead of an ordered pile of middleware. Third, its TypeScript story is first-party rather than `@types` archaeology.
*Alternative:* Express 5 is perfectly capable and has a bigger ecosystem. NestJS gives structure out of the box, but it also gives decorators, DI containers, and its own mental model, and you would spend your learning budget on Nest instead of on backend engineering. Declined for that reason.

**Drizzle over Prisma.** This is the decision most people will argue with, and it follows directly from your stated goal of understanding the SQL underneath. Drizzle is a typed query builder: the code you write maps almost one-to-one onto the SQL that executes, `SELECT ... FOR UPDATE` and `FOR UPDATE SKIP LOCKED` are first-class, CTEs and window functions are expressible, and dropping to `sql\`...\`` for a hand-tuned query is normal rather than an escape hatch. Prisma has better ergonomics and a nicer migration workflow, but it puts a query engine and its own DSL between you and the planner, `EXPLAIN ANALYZE` on Prisma-generated SQL is an exercise in archaeology, and the locking primitives we need most are only reachable through `$queryRaw` anyway.
*Alternative:* Prisma if you value DX over transparency. Kysely if you want an even thinner builder with no schema/migration opinion at all. If you pick Prisma, we can still hit every learning objective, but roughly 30% of the database-internals lessons become "here is the raw SQL we had to write to bypass the ORM."

**One Zod schema per boundary, types derived from it.** We define the schema once and derive the TypeScript type with `z.infer`, so runtime validation and compile-time types cannot drift. The same schema generates the OpenAPI document. This is also your best on-ramp to intermediate TypeScript: you will meet generics, conditional types, and inference through a tool you have a reason to care about.

**BullMQ before any real broker.** We already run Redis. BullMQ gives us delayed jobs (which is exactly how a hold expiry works), retries with backoff, concurrency limits, and a failed-job store that we can treat as a dead-letter queue. Kafka is the wrong tool for job queues (no per-message ack/retry, no delayed delivery, head-of-line blocking within a partition) and NATS/RabbitMQ would mean running another broker for capability we do not yet need. We will graduate deliberately, and §11 states the exact trigger.

**Stripe over Razorpay for learning.** Stripe's test mode, `stripe listen` CLI webhook forwarding, deterministic test cards for every failure mode, and documentation on idempotency and webhook ordering are the best available teaching material for payment architecture, and no real bank account is required. Razorpay is the right choice if you need live INR settlement. Because of that, the payment integration sits behind a `PaymentProvider` port from day one with a `StripeProvider` implementation and a `FakeProvider` for tests, so switching is a contained piece of work rather than a rewrite.

**pnpm monorepo from the start.** `apps/api`, `apps/web`, `packages/contracts`, `packages/config`. The cost is one `pnpm-workspace.yaml`. The benefit is that the API's Zod request/response schemas become the frontend's types, so a backend change that breaks the frontend fails `tsc` instead of failing in production. No Turborepo or Nx yet; plain pnpm scripts until build times actually hurt.

### 5.3 Repository layout (initial)

```
marquee/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── api.ts                 # HTTP entrypoint
│   │   │   ├── worker.ts              # worker entrypoint (Phase 7)
│   │   │   ├── app.ts                 # buildApp(): Fastify instance, no listen()
│   │   │   ├── modules/
│   │   │   │   └── health/
│   │   │   │       ├── health.routes.ts
│   │   │   │       └── health.service.ts
│   │   │   ├── infrastructure/
│   │   │   │   ├── db/
│   │   │   │   │   ├── client.ts      # Pool + Drizzle instance
│   │   │   │   │   ├── schema/        # Drizzle table definitions
│   │   │   │   │   └── migrations/    # generated + reviewed .sql
│   │   │   │   └── logging/logger.ts
│   │   │   └── shared/
│   │   │       ├── config/env.ts      # Zod-validated environment
│   │   │       └── errors/            # error taxonomy
│   │   └── test/
│   │       ├── integration/
│   │       └── support/               # Testcontainers harness, factories
│   └── web/
├── packages/
│   ├── contracts/                     # shared Zod schemas + inferred types
│   └── config/                        # shared tsconfig, eslint, prettier
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── API.md
│   ├── SECURITY.md
│   ├── OBSERVABILITY.md
│   ├── DEPLOYMENT.md
│   └── adr/
│       ├── 0001-modular-monolith.md
│       ├── 0002-postgresql-as-source-of-truth.md
│       ├── 0003-drizzle-over-prisma.md
│       └── 0004-uuidv7-primary-keys.md
├── docker-compose.yml
├── pnpm-workspace.yaml
└── README.md
```

Note `app.ts` exporting `buildApp()` separately from `api.ts` calling `listen()`. This is not decoration: it is what makes `fastify.inject()` API tests possible without binding a port, and it is the difference between a testable and an untestable Fastify app. We do it on day one.

---

## 6. Domain model

### 6.1 Aggregates and boundaries

```
Identity                Catalog                     Commerce
────────                ───────                     ────────
User                    Organization                Reservation ──┐
 ├─ Session             Venue                        └─ ReservationItem
 │   └─ RefreshToken     └─ VenueLayout             Order ────────┤
 └─ RoleAssignment          ├─ Section               ├─ Payment   │
                            │   ├─ SeatRow           │   └─ WebhookEvent
                            │   │   └─ Seat          ├─ Refund    │
                            │   └─ (GA capacity)     └─ Ticket    │
                        Event                                     │
                         ├─ TicketType ──────────────────────────┘
                         ├─ EventSeat        (reserved inventory)
                         └─ GaInventory      (GA inventory)
```

### 6.2 The three modeling decisions that matter

**Decision 1: physical seats and sellable inventory are different things.**

The tempting design puts `is_available` on the `seats` table. It is wrong, because a seat is a piece of furniture that exists across hundreds of events. Availability is a property of *(seat, event)*, not of *seat*. So `seats` is immutable reference data belonging to a venue layout, and `event_seats` is the mutable per-event inventory row. Publishing an event materializes one `event_seats` row per seat in the bound layout. That row, and only that row, is what we lock.

Corollary: layouts are versioned and immutable once published. If a venue rearranges its floor, that is a new layout version. Otherwise an edit to a layout silently mutates the inventory of every event that has already sold tickets against it, which is unrecoverable.

**Decision 2: Reservation, Order, and Ticket are three entities, not one `booking` row with a status column.**

They have different lifetimes and different owners:
- A **Reservation** is a short-lived claim on inventory. Most reservations die unconverted. It may exist without any intent to pay.
- An **Order** is a commercial record with a total, a currency, and one or more payment attempts. It exists once the customer commits to paying and it must outlive the reservation for accounting.
- A **Ticket** is the entitlement that gets scanned at the door. It has a holder, a code, and a check-in state. It must survive refund and cancellation as a voided record, because "was this ticket ever valid" is a question you get asked at the gate.

Collapsing these into one table is defensible for a simpler product, and I want to be straight with you that it is a judgment call. The deciding factor is that they change state on independent triggers (a timer, a payment webhook, a door scanner), and a single status column with a dozen values that different subsystems mutate concurrently is how state machines rot.

**Decision 3: reserved and GA inventory use different mechanisms.**

| | Reserved seating | General admission |
|---|---|---|
| Representation | One row per seat per event | One counter row per ticket type |
| Concurrency primitive | `SELECT ... FOR UPDATE` on specific rows | Conditional `UPDATE ... WHERE held+sold+n <= capacity` |
| Contention shape | Spread over thousands of rows; hot only on the good seats | Concentrated on one row; a hard serialization point |
| Failure mode to fear | Deadlock between overlapping multi-seat requests | Row-level contention throughput ceiling |
| Scaling escape hatch | Partition by event | Shard the counter into N rows |

The alternative is to materialize 500 fake seat rows for a 500-capacity GA area and use one code path. That is genuinely simpler and I have seen it in production. It fails when a festival has 50,000 GA tickets across 8 tiers, and it artificially serializes work that a counter does in one statement. We take the two-mechanism cost because both are worth learning and both are correct.

### 6.3 Booking state machines

**Seat / GA-unit inventory state:**

```
                    ┌─────────────┐
     ┌─────────────►│  AVAILABLE  │◄────────────┐
     │              └──────┬──────┘             │
     │  release/expire     │ hold               │ expire
     │                     ▼                    │
     │              ┌─────────────┐             │
     └──────────────┤    HELD     ├─────────────┘
                    └──────┬──────┘
                           │ order created
                           ▼
                    ┌─────────────────┐   payment failed &
                    │ PAYMENT_PENDING ├──► deadline passed ──► AVAILABLE
                    └──────┬──────────┘
                           │ payment succeeded
                           ▼
                    ┌─────────────┐
                    │    SOLD     ├──► refunded/cancelled ──► AVAILABLE
                    └─────────────┘

    BLOCKED  (admin-set, never enters the sales flow)
```

**Order state:**

```
PENDING ──► PAID ──► PARTIALLY_REFUNDED ──► REFUNDED
   │          │
   │          └──► REFUNDED
   ├──► FAILED ──► PENDING   (retry allowed while hold survives)
   └──► CANCELLED
```

**Payment state (mirrors the provider, deliberately):**

```
CREATED ──► PROCESSING ──► SUCCEEDED
   │            │
   │            └──► FAILED ──► (new payment row for retry, never reuse)
   └──► CANCELLED
```

Rules that will be enforced in code and in tests:
1. Transitions live in exactly one module per aggregate, exposed as `transition(from, to)` which throws on an illegal pair. Nothing else writes a status column.
2. The full transition matrix is unit-tested, including every illegal pair.
3. `SOLD` and `PAID` are terminal with respect to expiry. A timer can never revoke a paid seat.
4. A retried payment creates a **new** payment row. Payment rows are append-only attempts, not a mutable field.

### 6.4 Key schema notes before the DDL

**Primary keys: UUIDv7, generated in the application.** Not `bigint` sequences, because public IDs that count up leak volume and enable enumeration. Not `gen_random_uuid()`, because that is UUIDv4: random values scatter inserts across the whole B-tree, causing page splits, poor cache locality, and measurably bigger indexes on high-insert tables. UUIDv7 embeds a millisecond timestamp in the high bits, so it is globally unique like v4 but roughly time-ordered like a sequence, and inserts land at the right edge of the index. We generate it in Node (`uuidv7` package) so the application knows the ID before the round trip, which matters for the outbox and for logging.
*Alternative:* `bigint` internal PK plus a separate public ULID column. Two IDs per row, more joins, more code. Declined.

**`text` + `CHECK` instead of PostgreSQL `ENUM`.** Native enums cannot have values removed or reordered, and `ALTER TYPE ... ADD VALUE` has transactional restrictions that interact badly with migration runners. A `CHECK (status IN (...))` constraint is edited by a plain migration. Same type safety at the application boundary because the TypeScript union comes from Zod anyway.

**Money is `bigint` minor units plus `char(3)` currency.** Never floating point. Never a bare number without its currency in the same row.

**All timestamps are `timestamptz`, stored UTC.** The venue carries an IANA timezone string for display, because "the show starts at 8pm" is a local-time fact and rendering it from UTC without the venue's zone gives you the wrong day across DST boundaries.

---

## 7. Initial PostgreSQL schema

This is the Phase 2–5 target. Day 1 ships only the first migration (§18). Full DDL is given for the concurrency-critical tables because the constraints *are* the design; the rest is abbreviated.

### 7.1 Foundation

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_bytes for token hashing
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

CREATE TABLE users (
  id                 uuid PRIMARY KEY,
  email              citext NOT NULL UNIQUE,
  password_hash      text   NOT NULL,
  display_name       text   NOT NULL,
  email_verified_at  timestamptz,
  status             text   NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','locked','deleted')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
```

`citext` for email rather than lowercasing in the application: it makes the uniqueness guarantee a database property instead of a convention that one forgotten `.toLowerCase()` breaks.

### 7.2 Sessions and refresh tokens

```sql
CREATE TABLE sessions (
  id             uuid PRIMARY KEY,                   -- the `sid` claim
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent     text,
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text CHECK (revoked_reason IN
                   ('logout','logout_all','reuse_detected','password_reset','admin'))
);
CREATE INDEX sessions_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY,
  session_id  uuid  NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,        -- SHA-256 of the opaque token
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

One `sessions` row per device, a chain of `refresh_tokens` rows per session. Rotation appends to the chain and stamps `used_at` on the old one. If a token with `used_at IS NOT NULL` is ever presented, that token was stolen and replayed, and we revoke the entire session. This table shape is what makes reuse detection possible, and it is why refresh tokens cannot be JWTs.

### 7.3 Venues and layouts (abbreviated)

```sql
organizations   (id, name, slug UNIQUE, status, created_at)
org_members     (org_id, user_id, role, PRIMARY KEY (org_id, user_id))
venues          (id, org_id NULL, name, address_line1, city,
                 country_code char(2), timezone text NOT NULL, created_at)
venue_layouts   (id, venue_id, name, version int, published_at,
                 UNIQUE (venue_id, name, version))
sections        (id, layout_id, name, kind CHECK (kind IN ('reserved','ga')),
                 ga_capacity int, display_order,
                 CHECK ((kind = 'ga') = (ga_capacity IS NOT NULL)))
seat_rows       (id, section_id, label, display_order, UNIQUE (section_id, label))
seats           (id, row_id, label, x numeric, y numeric, UNIQUE (row_id, label))
```

That last `CHECK` is a small example of a habit worth building: it makes an illegal state (a GA section with no capacity, a reserved section with one) unrepresentable in the database rather than merely discouraged in the service layer.

### 7.4 Events and ticket types

```sql
CREATE TABLE events (
  id                   uuid PRIMARY KEY,
  org_id               uuid NOT NULL REFERENCES organizations(id),
  venue_id             uuid NOT NULL REFERENCES venues(id),
  layout_id            uuid NOT NULL REFERENCES venue_layouts(id),
  title                text NOT NULL,
  slug                 text NOT NULL UNIQUE,
  description          text,
  category             text NOT NULL
                         CHECK (category IN ('movie','concert','sports',
                                             'conference','theatre','other')),
  status               text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','published','on_sale',
                                           'sold_out','cancelled','completed')),
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz,
  doors_at             timestamptz,
  sales_start_at       timestamptz NOT NULL,
  sales_end_at         timestamptz NOT NULL,
  hold_ttl_seconds     int NOT NULL DEFAULT 600 CHECK (hold_ttl_seconds BETWEEN 60 AND 1800),
  max_per_order        int NOT NULL DEFAULT 6   CHECK (max_per_order BETWEEN 1 AND 20),
  max_per_customer     int NOT NULL DEFAULT 10,
  refund_policy        text NOT NULL DEFAULT 'until_7d_before'
                         CHECK (refund_policy IN ('none','until_7d_before','anytime')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (sales_end_at > sales_start_at)
);

-- Browse queries always filter on sellable status and order by date.
-- Partial index: excludes drafts and completed events from the index entirely,
-- which is most rows after a year of operation.
CREATE INDEX events_browse_idx ON events (starts_at, id)
  WHERE status IN ('published','on_sale');

CREATE TABLE ticket_types (
  id              uuid PRIMARY KEY,
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  section_id      uuid NOT NULL REFERENCES sections(id),
  name            text NOT NULL,
  price_cents     bigint NOT NULL CHECK (price_cents >= 0),
  currency        char(3) NOT NULL,
  sales_start_at  timestamptz,
  sales_end_at    timestamptz,
  UNIQUE (event_id, section_id, name)
);
```

### 7.5 Inventory — the tables the whole system is built around

```sql
CREATE TABLE event_seats (
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seat_id          uuid NOT NULL REFERENCES seats(id),
  ticket_type_id   uuid NOT NULL REFERENCES ticket_types(id),
  status           text NOT NULL DEFAULT 'available'
                     CHECK (status IN ('available','held','payment_pending',
                                       'sold','blocked')),
  reservation_id   uuid,
  hold_expires_at  timestamptz,
  order_id         uuid,
  version          int  NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (event_id, seat_id),

  -- Illegal states made unrepresentable:
  CHECK ((status IN ('held','payment_pending')) = (reservation_id IS NOT NULL)),
  CHECK ((status IN ('held','payment_pending')) = (hold_expires_at IS NOT NULL)),
  CHECK ((status = 'sold') = (order_id IS NOT NULL))
);

-- Seat map render: "all seats for this event". Composite PK leads with event_id,
-- so all of one event's seats are physically adjacent in the index.
-- No extra index needed for that access path.

-- Availability count for the event page.
CREATE INDEX event_seats_available_idx ON event_seats (event_id, ticket_type_id)
  WHERE status = 'available';

-- The expiry sweeper's only query. Partial: held rows are a tiny fraction.
CREATE INDEX event_seats_expiring_idx ON event_seats (hold_expires_at)
  WHERE status IN ('held','payment_pending');

-- "Which seats does this reservation hold?"
CREATE INDEX event_seats_reservation_idx ON event_seats (reservation_id)
  WHERE reservation_id IS NOT NULL;
```

```sql
CREATE TABLE ga_inventory (
  ticket_type_id uuid PRIMARY KEY REFERENCES ticket_types(id) ON DELETE CASCADE,
  capacity       int NOT NULL CHECK (capacity > 0),
  held           int NOT NULL DEFAULT 0 CHECK (held >= 0),
  sold           int NOT NULL DEFAULT 0 CHECK (sold >= 0),
  version        int NOT NULL DEFAULT 0,

  -- The single most valuable line in this schema.
  CONSTRAINT ga_no_oversell CHECK (held + sold <= capacity)
);
```

That constraint deserves a sentence of its own. Application code can be buggy, a service can be deployed in two versions at once, someone can run a manual `UPDATE` in psql at 2am during an incident. A `CHECK` constraint cannot be raced, cannot be forgotten, and cannot be bypassed. It is the difference between "we believe we do not oversell" and "we cannot oversell." Every invariant that can be expressed as a constraint should be.

### 7.6 Reservations, orders, payments, tickets

```sql
CREATE TABLE reservations (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  event_id        uuid NOT NULL REFERENCES events(id),
  status          text NOT NULL DEFAULT 'held'
                    CHECK (status IN ('held','payment_pending','converted',
                                      'expired','released')),
  expires_at      timestamptz NOT NULL,
  subtotal_cents  bigint NOT NULL,
  currency        char(3) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservations_expiring_idx ON reservations (expires_at)
  WHERE status IN ('held','payment_pending');
CREATE INDEX reservations_user_idx ON reservations (user_id, created_at DESC);

CREATE TABLE reservation_items (
  id                uuid PRIMARY KEY,
  reservation_id    uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  ticket_type_id    uuid NOT NULL REFERENCES ticket_types(id),
  seat_id           uuid,                      -- NULL for GA
  quantity          int  NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents  bigint NOT NULL,
  CHECK (seat_id IS NULL OR quantity = 1)
);

orders   (id, user_id, event_id, reservation_id UNIQUE, status, total_cents,
          currency, created_at, paid_at, updated_at)

payments (id, order_id, provider, provider_intent_id, status, amount_cents,
          currency, attempt int, failure_code, created_at, updated_at,
          UNIQUE (provider, provider_intent_id))

refunds  (id, order_id, payment_id, provider_refund_id, amount_cents, reason,
          status, created_at, UNIQUE (provider_refund_id))

tickets  (id, order_id, event_id, ticket_type_id, seat_id NULL, holder_name,
          code_hash bytea UNIQUE, status, issued_at, checked_in_at, checked_in_by)
```

### 7.7 Infrastructure tables

```sql
-- Every webhook we receive, stored before it is processed.
CREATE TABLE payment_webhook_events (
  id                 uuid PRIMARY KEY,
  provider           text NOT NULL,
  provider_event_id  text NOT NULL,
  type               text NOT NULL,
  payload            jsonb NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  error              text,
  UNIQUE (provider, provider_event_id)   -- duplicate delivery becomes a no-op
);

-- Transactional outbox.
CREATE TABLE outbox (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text  NOT NULL,
  aggregate_id   uuid  NOT NULL,
  type           text  NOT NULL,
  payload        jsonb NOT NULL,
  trace_context  jsonb,                  -- W3C traceparent, so traces survive the hop
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Consumer-side dedupe for at-least-once delivery.
CREATE TABLE processed_messages (
  consumer     text NOT NULL,
  message_id   text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);

-- API-level idempotency keys.
CREATE TABLE idempotency_keys (
  user_id         uuid NOT NULL,
  endpoint        text NOT NULL,
  key             text NOT NULL,
  request_hash    bytea NOT NULL,        -- reject key reuse with a different body
  state           text NOT NULL CHECK (state IN ('in_progress','completed')),
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint, key)
);

audit_log (id, actor_user_id, action, subject_type, subject_id, metadata jsonb,
           ip inet, created_at)
```

### 7.8 Connection pooling

Pool sizing per API instance starts at `min: 2, max: 10`. The constraint that catches people: `instances × pool_max + workers × pool_max` must stay comfortably below PostgreSQL's `max_connections` (default 100), and each PG connection is a process costing several MB. Four API instances at max 10, plus two workers at max 5, is 50 connections, which is fine. Twenty instances is not. When we reach that point (Phase 15) we introduce PgBouncer in transaction pooling mode, and we will then need to know that transaction-mode pooling breaks anything that relies on session state across statements, including session-level advisory locks and some prepared-statement patterns. This is a real constraint on how we implement locks, which is one reason I prefer row locks over advisory locks in §8.

---

## 8. Core booking workflow

### 8.1 The concurrency problem, stated precisely

Two requests, both wanting seat `A12` of event `E`. Naive implementation:

```
T1: SELECT status FROM event_seats WHERE event_id=E AND seat_id=A12;  -- 'available'
T2: SELECT status FROM event_seats WHERE event_id=E AND seat_id=A12;  -- 'available'
T1: UPDATE event_seats SET status='held', reservation_id=R1 WHERE ...;
T2: UPDATE event_seats SET status='held', reservation_id=R2 WHERE ...;
COMMIT; COMMIT;
```

Both succeed. `R2` overwrites `R1`. Two customers believe they hold `A12`; one of them will be turned away at the door, after paying.

This is the **lost update** anomaly. PostgreSQL's default isolation level, READ COMMITTED, permits it, and this is not a PostgreSQL flaw: READ COMMITTED guarantees you never read uncommitted data, and it says nothing about the gap between your read and your write. The window is as small as a millisecond and as large as your network latency, which means it will not reproduce in manual testing and will reproduce reliably on the night of a big onsale. Wrapping the two statements in `BEGIN`/`COMMIT` does not help at all, and believing that it does is the most common misconception in this area. A transaction gives you atomicity and isolation from *uncommitted* state; it does not give you mutual exclusion.

Three correct fixes exist:

| Approach | Mechanism | Cost | When it fits |
|---|---|---|---|
| **Pessimistic lock** | `SELECT ... FOR UPDATE`, then update | Writers queue on the row; a slow transaction blocks others | High contention, short transactions, specific known rows |
| **Optimistic lock** | `UPDATE ... WHERE version = $expected`, retry on 0 rows | No blocking; wasted work and retry loops under contention | Low contention, or long think-time between read and write |
| **Atomic conditional write** | `UPDATE ... WHERE <invariant still holds>` in one statement | Cheapest; only works when the decision is expressible in SQL | Counters, single-row state transitions |

We use pessimistic locking for reserved seats (high contention on specific rows, transaction is a few milliseconds) and atomic conditional writes for GA counters. We use optimistic version columns as a defensive extra on `event_seats` for detecting bugs, not as the primary mechanism.

### 8.2 Creating a hold on reserved seats

```sql
BEGIN;
SET LOCAL statement_timeout = '3s';        -- never let a lock wait forever
SET LOCAL lock_timeout      = '2s';

-- Step 1: lock the exact rows, in a deterministic order.
SELECT event_id, seat_id, ticket_type_id, status, hold_expires_at
FROM event_seats
WHERE event_id = $1
  AND seat_id  = ANY($2::uuid[])
  AND ( status = 'available'
        OR (status IN ('held','payment_pending') AND hold_expires_at <= now()) )
ORDER BY seat_id                            -- deadlock avoidance
FOR UPDATE;

-- If rowcount < requested count → ROLLBACK, return 409 with the unavailable seats.

-- Step 2: claim them.
UPDATE event_seats
SET status = 'held',
    reservation_id  = $3,
    hold_expires_at = now() + ($4 || ' seconds')::interval,
    version = version + 1,
    updated_at = now()
WHERE event_id = $1 AND seat_id = ANY($2::uuid[]);

-- Step 3: reservation + items + outbox event, same transaction.
INSERT INTO reservations (...) VALUES (...);
INSERT INTO reservation_items (...) SELECT ...;
INSERT INTO outbox (aggregate_type, aggregate_id, type, payload, trace_context)
VALUES ('reservation', $3, 'ReservationCreated', $5, $6);

COMMIT;
```

Four details worth dwelling on, each of which is a lesson:

**`ORDER BY seat_id` prevents deadlocks.** Customer 1 wants seats `{A1, A2}`, customer 2 wants `{A2, A1}`. Without a deterministic lock order, T1 locks A1 and waits for A2 while T2 locks A2 and waits for A1. PostgreSQL detects the cycle after `deadlock_timeout` (1s default) and kills one transaction with SQLSTATE `40P01`. Locking in a globally consistent order makes the cycle impossible. We will deliberately build the deadlock in Phase 5, watch it happen, then fix it with this one clause. That exercise is worth more than reading about it.

**The expiry predicate is in the `WHERE` clause, not delegated to a cleanup job.** A hold is expired *because `now() > hold_expires_at`*, not because a worker got around to updating a row. If correctness depended on the sweeper running, then a paused worker would mean seats stuck unavailable forever, and a laggy worker would mean a customer sees a seat as taken when it is free. The sweeper is a performance optimization that makes freed seats visible on the seat map sooner. Correctness lives in the predicate. This distinction generalizes to nearly every expiry problem you will meet.

**`FOR UPDATE`, not `FOR UPDATE SKIP LOCKED`.** The customer asked for these seats specifically. If someone else holds the lock, we must wait and then discover the truth, not silently skip them and report the wrong answer. `SKIP LOCKED` is exactly right for the *best-available* flow (FR-4.3), where the query means "give me any three adjacent free seats in this section" and skipping contended rows is the desired behavior. Same keyword, opposite correctness properties, chosen by what the user asked for. We will implement both.

**Timeouts are set inside the transaction.** Without `lock_timeout`, a request can block for as long as the holder takes. Under an onsale spike that turns a hot row into an unbounded queue, connections pile up, the pool exhausts, and an unrelated endpoint starts failing. Bounded waits convert a cascading outage into a handful of honest 503s.

### 8.3 Creating a hold on GA inventory

```sql
UPDATE ga_inventory
SET held = held + $2, version = version + 1
WHERE ticket_type_id = $1
  AND held + sold + $2 <= capacity
RETURNING capacity - held - sold AS remaining;
```

One statement. PostgreSQL takes the row lock implicitly for the duration, re-evaluates the predicate against the committed row, and returns zero rows if the tickets are gone. No explicit `SELECT ... FOR UPDATE` needed, no read-then-write window to lose an update in, and the `CHECK` constraint stands behind it as a backstop if we ever write a buggy query path. Zero rows returned means sold out, which is a 409 and not an error.

The cost: every GA purchase for that ticket type serializes on one row. At a few hundred writes per second that is fine. If it becomes the bottleneck, we shard the counter into N rows and pick one at random, accepting that the last few tickets fragment across shards and need a consolidation pass. We will measure before we do that, in Phase 26's load testing.

### 8.4 Full purchase sequence

```
Customer                API                     PostgreSQL         Stripe        Worker
   │                     │                          │                │             │
   │─ POST /holds ──────►│                          │                │             │
   │  Idempotency-Key    │─ BEGIN; FOR UPDATE ─────►│                │             │
   │                     │  claim seats             │                │             │
   │                     │  INSERT reservation      │                │             │
   │                     │  INSERT outbox           │                │             │
   │                     │─ COMMIT ────────────────►│                │             │
   │◄─ 201 {hold, exp} ──│                          │                │             │
   │                     │                          │                │             │
   │─ POST /orders ─────►│─ BEGIN ─────────────────►│                │             │
   │                     │  reservation still valid?│                │             │
   │                     │  seats → PAYMENT_PENDING │                │             │
   │                     │  extend deadline         │                │             │
   │                     │  INSERT order (PENDING)  │                │             │
   │                     │─ COMMIT ────────────────►│                │             │
   │                     │                          │                │             │
   │                     │═══ create PaymentIntent ═════════════════►│  ← OUTSIDE
   │                     │    idempotency_key = order_id             │    the txn
   │                     │◄══ intent + client_secret ════════════════│
   │                     │─ INSERT payment (CREATED)►│               │             │
   │◄─ 201 {clientSecret}│                          │                │             │
   │                     │                          │                │             │
   │══ card details ══════════════════════════════════════════════►  │             │
   │                     │                          │                │             │
   │                     │◄═══ POST /webhooks/stripe (signed) ═══════│             │
   │                     │─ verify sig; INSERT      │                │             │
   │                     │  webhook_event (UNIQUE) ►│                │             │
   │◄─ (polls order) ────│─ 200 OK ═════════════════════════════════►│             │
   │                     │─ enqueue processing ──────────────────────────────────► │
   │                     │                          │                │             │
   │                     │                          │◄─ BEGIN ───────────────────  │
   │                     │                          │   order → PAID               │
   │                     │                          │   seats → SOLD               │
   │                     │                          │   INSERT tickets             │
   │                     │                          │   INSERT outbox              │
   │                     │                          │◄─ COMMIT ──────────────────  │
   │◄─ 200 {PAID, tickets}                          │                │             │
```

### 8.5 The rule that governs all of it

**No database transaction may remain open across a network call to a third party.**

If we held the seat lock while calling Stripe, then a Stripe latency spike of 8 seconds would hold row locks for 8 seconds, block every other customer contending for those seats, exhaust the connection pool, and take down the API. Transactions are measured in milliseconds. External calls happen between transactions, and the state that survives between them lives in the database.

This is why the flow needs `PAYMENT_PENDING` as a distinct inventory state rather than just `HELD`: it records "an external process is in flight against this seat" durably, so that a crash between the two transactions is recoverable by reading the database rather than by hoping the request is retried.

### 8.6 Failure scenarios and their resolutions

| Scenario | What happens | Resolution |
|---|---|---|
| Two customers, same seat, same millisecond | One blocks on the row lock, then sees the other's committed state | First commit wins, second gets 409 with the specific seats |
| Customer's hold expires while they type card details | Seats revert to available and may be resold | Order creation extends the deadline to cover provider timeout; if the hold already expired at order time, fail *before* charging |
| Payment succeeds after the seats were released | Provider has the money, we have no inventory | Detected by the webhook processor finding no valid hold. Automatic full refund, customer notified, **and it pages a human**, because this means our deadline math is wrong |
| Stripe webhook arrives before the customer's browser returns | Very common, not an edge case | Confirmation is entirely webhook-driven and idempotent; the client polls order status and never asserts anything |
| We crash after `COMMIT` but before responding 201 | Customer sees a network error, retries | Idempotency key returns the original hold rather than creating a second one |
| We crash after creating the Stripe intent, before saving the payment row | Orphan intent at the provider | Reconciliation job finds provider intents with no local payment row and repairs or cancels |
| Duplicate webhook delivery (Stripe retries for 3 days) | Same event arrives 5 times | `UNIQUE (provider, provider_event_id)` makes insert 2–5 a no-op |
| Webhook arrives for an already-confirmed order | Reprocessing risk | The state machine rejects `PAID → PAID`; the handler is idempotent by construction |
| Sweeper worker down for two hours | Expired holds not cleaned up | Zero correctness impact. Seats are already claimable because the expiry predicate is in the query. Seat map is stale, availability counts undercount, and a metric alerts on sweeper lag |
| Deadlock between two multi-seat holds | PG kills one with `40P01` | Ordered locking prevents it; a bounded retry with jitter catches the residue; a metric counts deadlocks and non-zero is a bug to investigate |

---

## 9. Authentication architecture

### 9.1 Why `login → sign JWT → return JWT` is not an implementation

That design has no answer to any of these questions, all of which a system holding money must answer:

- A customer's laptop is stolen. How do you invalidate their access before the token expires?
- An attacker steals a token from a compromised browser extension. How do you detect it is being used?
- You fire an employee with admin rights. How fast can you cut access?
- A customer clicks "log out of all devices." What does that actually do?
- Your access token is stored in `localStorage` and you ship one XSS. What is the blast radius?

Stateless JWTs answer all of them with "wait for expiry," which is why real systems use short-lived credentials plus a revocable long-lived one plus server-side session state.

### 9.2 Design

**Password storage: Argon2id.** Parameters per OWASP: `memoryCost: 19456` (19 MiB), `timeCost: 2`, `parallelism: 1`, tuned upward against real hardware to land near 100–250ms per hash. Argon2id over bcrypt because bcrypt's cost factor only scales CPU time, while Argon2 is memory-hard and therefore far more expensive to attack with GPUs and ASICs; bcrypt also silently truncates input at 72 bytes. Bcrypt remains acceptable at cost ≥ 12 and we will compare them with real measurements rather than assertions. The hash string carries its own parameters, so a rehash-on-login upgrade path exists when we raise them.

**Access token: JWT, EdDSA (Ed25519), 10-minute TTL.** Claims: `sub` (user id), `sid` (session id), `jti`, `iat`, `exp`, `roles`, `perms`. Delivered in the response body, held in JavaScript memory only. Not `localStorage`, because any XSS reads it. Not a long-lived cookie, because we want it short.

**Refresh token: opaque, 256 bits from a CSPRNG, 30-day TTL, rotated on every use.** Stored in the database as a SHA-256 hash, so a database leak does not yield usable tokens. Delivered as `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth/refresh`. The path scoping matters: it means the token is not attached to every request, so it cannot be exfiltrated by anything that reads ordinary response traffic, and the attack surface is one endpoint. It is opaque rather than a JWT because a refresh token *must* be checkable against server state for rotation and reuse detection, so signing buys nothing and costs the temptation to trust it without a lookup.

**Rotation with reuse detection.** Every refresh returns a new refresh token and stamps `used_at` on the old one. Presenting an already-used token means one of two things: a legitimate client raced itself, or a stolen token is being replayed. We cannot distinguish them, so we assume theft and revoke the entire session family with `revoked_reason = 'reuse_detected'`, forcing re-authentication and emailing the user. Full detail in ADR-0005.

**Tiered verification, the trade-off made explicit.** Ordinary endpoints verify the JWT signature and expiry with no database or Redis lookup, accepting up to 10 minutes of staleness after a revocation. High-risk endpoints (create order, refund, change password, change role, delete account) additionally check that `sid` is live in Redis, falling back to PostgreSQL on a Redis miss. This buys near-zero-cost auth on the hot read path and immediate revocation where money and identity are involved. The alternative, checking every request, costs a round trip on every call; the alternative of never checking means "log out all devices" is a lie. Neither extreme is right.

**Sessions as first-class objects.** One row per device with user agent, IP, created and last-seen timestamps. This is what makes FR-1.5 (see your sessions) and FR-1.4 (revoke one or all) implementable, and it is what you inspect first during an account-takeover investigation.

**Email verification and password reset tokens.** 32 random bytes, hashed at rest, single-use, TTL 24h and 1h respectively, compared in constant time. Password reset revokes every session. Responses never reveal whether an email exists ("if that address is registered, we sent a link"), and the response time is normalized so timing does not leak it either.

**CSRF.** The refresh cookie is `SameSite=Lax` and reachable only at the refresh endpoint, which is a POST with no side effect other than rotation, so the classic CSRF risk is limited. Since the access token travels in an `Authorization` header rather than a cookie, the rest of the API is not CSRF-exposed by construction. If we ever move access tokens into cookies for SSR, we add double-submit tokens, and we will document why in an ADR rather than adding them reflexively now.

**Authorization: roles carry permissions; code checks permissions.** `organizer_admin` holds `event:publish`, `event:cancel`, `refund:issue`, and so on. Route handlers assert permissions rather than roles, because roles are a packaging decision that changes and permissions are the actual requirement. On top of that sits tenant scoping: every organizer-facing query is filtered by the caller's `org_id`, enforced in the repository layer rather than remembered per query, because broken object-level authorization is the most common serious web vulnerability and it is always caused by one forgotten `WHERE`.

---

## 10. Payment architecture

### 10.1 The core principle

**The frontend is never evidence of payment.** Not the redirect, not the JavaScript callback, not the query parameter. Reasons, in order of how often they bite:

1. The browser closes, the phone dies, the tunnel drops. Legitimate paid customers frequently never reach the success page. If confirmation depends on their browser, those customers pay and get nothing.
2. `POST /api/orders/123/confirm` from the client is forgeable. Anyone can call it with curl. If it confirms an order, tickets are free.
3. The provider's own flow can complete server-side after the client is gone (3DS challenges, bank redirects, delayed payment methods).

The only trustworthy signals are (a) a webhook whose signature verifies against our endpoint secret and (b) a server-to-server fetch of the intent from the provider. Both are things an attacker cannot fabricate.

### 10.2 Design

**Provider-hosted collection.** Stripe Elements or Checkout collects the card; card numbers never transit our servers. This keeps us in PCI DSS SAQ-A, the lightest possible scope, and it is the single biggest security decision in the project.

**One intent per order attempt, keyed by an idempotency key.** We send `Idempotency-Key: order:<order_id>:attempt:<n>` on intent creation. If our request times out and we retry, the provider returns the *same* intent rather than creating a second one. Without this, a network blip becomes a double charge. Retries on any state-changing provider call are unsafe without an idempotency key, and this is the concrete reason the concept exists.

**Webhook endpoint: verify, persist, ack, then process.**

```
POST /webhooks/stripe
  1. Read the RAW body. Signature is over raw bytes; any JSON middleware
     that re-serializes it breaks verification. This is the #1 webhook bug.
  2. Verify the signature and the timestamp tolerance (replay defense).
  3. INSERT INTO payment_webhook_events ... ON CONFLICT DO NOTHING.
       → conflict means duplicate delivery → return 200 immediately.
  4. Enqueue a processing job carrying the stored row id.
  5. Return 200 in under 200ms.
```

Processing happens in a worker, not in the request. Providers retry on non-2xx and on timeout, so slow synchronous processing produces duplicate deliveries and retry storms exactly when the system is already struggling. Acking fast and processing asynchronously also means a bug in our confirmation logic does not cause Stripe to disable our endpoint.

**Processing is idempotent and order-independent.** Webhooks arrive out of order. `payment_intent.succeeded` can land before `payment_intent.processing`. The handler loads current state, asks the state machine whether the transition is legal, and no-ops on transitions that are already applied or that would move backwards. It never assumes it is the first or only delivery.

**Reconciliation is not optional.** A nightly job lists provider payments and refunds for the previous 48 hours and diffs them against ours, looking for four classes of mismatch: provider succeeded but our order is not paid (lost webhook), our order is paid but the provider has no record (a serious bug), provider intents with no local payment row (crash after creation), and amount mismatches. Every mismatch class has a documented action, and the count is a metric with an alert. This is how you find out that you have been quietly losing 0.1% of payments to a webhook path that has been broken for a month.

**Refunds.** Full and partial, always initiated server-side, always recorded with the provider refund ID under a unique constraint. Refunding releases inventory back to available and voids the tickets. Event cancellation fans out to a refund job per paid order, executed with a concurrency limit so we do not trip provider rate limits.

### 10.3 Payment failure scenarios

| Scenario | Handling |
|---|---|
| Provider times out during intent creation | Retry with the same idempotency key, bounded, exponential backoff with jitter. Circuit breaker after repeated failures |
| Card declined | Payment row → FAILED; order stays PENDING; hold survives; customer may retry, which creates a *new* payment row |
| Webhook never arrives | Reconciliation catches it within 24h; the customer-facing order status page also does a live provider fetch on demand |
| Webhook arrives 3 days late | Signature tolerance rejects stale timestamps, but the reconciler has already resolved the order by then |
| We crash mid-confirmation | The confirming transaction is atomic; on restart the job retries and finds either "nothing done" or "already done." No partial ticket issuance |
| Duplicate refund request | Unique provider refund ID plus a check on already-refunded amount |
| Payment succeeded, no inventory available | Auto-refund, notify, page a human. This should be impossible; treat every occurrence as a bug |

### 10.4 When to retry, and when not to

The rule is not "retry idempotent operations." It is **"retry when the operation is idempotent *and* you do not know whether it happened."**

| Situation | Retry? | Why |
|---|---|---|
| Timeout creating a payment intent, idempotency key present | Yes | Outcome unknown, retry provably cannot double-charge |
| Timeout creating a payment intent, no idempotency key | **No** | Outcome unknown and a retry may double-charge. Fail, reconcile later |
| HTTP 500 from provider | Yes, with backoff | Transient, unknown outcome |
| HTTP 402 card declined | No | Definitive answer. Retrying an identical request gets an identical decline and looks like fraud to the issuer |
| HTTP 400 invalid request | No | Our bug. Retrying is just load |
| Deadlock (`40P01`) in a hold transaction | Yes, up to 3 times with jitter | Transactional, rolled back cleanly, likely to succeed |
| Serialization failure (`40001`) | Yes | Same reasoning |
| Unique violation on an idempotency key | No | Means the work is already done. Return the stored response |
| Anything after `COMMIT` succeeded | No | It happened. Retrying would duplicate it |

---

## 11. Caching strategy

### 11.1 The three storage tiers

| | In-process memory | Redis | PostgreSQL |
|---|---|---|---|
| Latency | ~50 ns | ~0.5 ms (LAN round trip) | 1–20 ms |
| Shared across instances | No | Yes | Yes |
| Survives restart | No | Configurably | Yes |
| Durability guarantee | None | Weak (async persistence, replica lag) | Strong |
| Capacity | Heap-bound | RAM-bound | Disk-bound |
| Blast radius if lost | Nothing | Nothing, by design | Business over |
| Right for | Hot config, tiny values, 1s TTL shields | Cache, counters, locks, ephemeral coordination | Anything that must be true |

Reading down the "durability guarantee" column tells you the whole rule: **nothing whose loss would be a business problem may live only in Redis.** Redis can lose the last second of writes on failover, and its default persistence is not a durability guarantee. So inventory, orders, and money live in PostgreSQL. Full stop.

### 11.2 What we cache

| Data | Store | TTL | Invalidation |
|---|---|---|---|
| Event list / search page | Redis | 60 s | TTL only; staleness is acceptable and documented |
| Event detail | Redis | 60 s | Explicit delete on publish/update/cancel |
| Venue layout geometry (immutable) | Redis + in-process LRU | 24 h | Never; key includes layout version |
| Per-ticket-type availability summary | Redis | 5 s | TTL only |
| Seat map statuses | **Not cached as truth** | — | Served from PG; optional 1–2 s Redis shield on hot events |
| Session liveness (`sid` set) | Redis | session TTL | Deleted on logout/revoke; PG is the fallback source |
| Rate limit counters | Redis | window | Expiry |
| JWKS / public keys | In-process | 1 h | On rotation |

The seat map row is the important one. We show the customer a snapshot that may be a second or two old, because the alternative (a perfectly live seat map) costs a database read per seat per viewer and buys nothing: with 3,000 people looking at 4,000 seats, the map is wrong the instant it renders no matter what we do. So we design the UI around it. The hold attempt is authoritative, a failed hold is a normal outcome rather than an error, and the frontend re-fetches and highlights what changed. Trying to make the map authoritative is the single most common way people accidentally build a system that cannot scale.

### 11.3 Cache failure modes

**Stampede (thundering herd).** A hot key expires and 2,000 concurrent requests all miss and all hit the database at once. Fix: single-flight. The first requester takes a short Redis lock and recomputes; everyone else either waits briefly or serves the stale value. Combined with stale-while-revalidate (store `{value, softExpiry, hardExpiry}` and refresh in the background after soft expiry), the database sees one query instead of two thousand.

**Penetration.** Requests for keys that do not exist (`/events/does-not-exist`, often from a scanner) bypass the cache entirely and hit the database every time. Fix: negative caching with a short TTL, plus rate limiting per IP.

**Hot key.** One event is so popular that a single Redis key saturates one Redis connection or shard. Fix: a per-instance in-process LRU with a 1-second TTL in front of Redis, which converts thousands of Redis reads per second into one per instance per second. Small local cache, big effect.

**Inconsistency after write.** Cache-aside with delete-after-commit has a window where a concurrent reader repopulates the cache with the pre-write value. Mitigations: delete after commit rather than before, short TTLs so any anomaly self-heals, and version-stamped keys for anything where staleness would be visibly wrong.

**Redis is down entirely.** Reads bypass the cache and hit PostgreSQL, which is slower but correct, so we need to be certain PG can survive the uncached load (a load-test scenario in Phase 11). Rate limiting fails **closed** on authentication and payment endpoints, because an unlimited login endpoint invites credential stuffing, and fails **open** on browse endpoints, because blocking all browsing to protect a counter is worse than the counter being unenforced for ten minutes. That asymmetry is a policy decision, and it is exactly the kind of thing that should be written down before an incident rather than argued about during one.

### 11.4 Rate limiting

Naive in-memory rate limiting fails the moment you run more than one instance: with a limit of 10 requests per minute and 4 instances behind a round-robin load balancer, the effective limit is 40, and it drifts as instances scale or restart. It is not a limit, it is a suggestion.

Algorithm choice: **sliding window log for auth endpoints** (precise, low volume, worth the memory) and **token bucket for general API traffic** (allows legitimate bursts, smooth refill, cheap). Fixed windows are rejected because of the boundary problem: a limit of 100/minute permits 200 requests in the two seconds spanning a window edge. Implementation is a Lua script executed in Redis so that check-and-increment is atomic, because doing it as `GET` then `INCR` from Node is the same lost-update race as the seat bug, in a different costume.

Initial limits:

| Endpoint | Limit |
|---|---|
| `POST /auth/login` | 5 / 15 min per email **and** 20 / 15 min per IP |
| `POST /auth/register` | 3 / hour per IP |
| `POST /auth/password-reset` | 3 / hour per email, 10 / hour per IP |
| `POST /holds` | 10 / min per user, 30 / min per IP |
| Authenticated reads | 300 / min per user |
| Anonymous reads | 60 / min per IP |
| `POST /webhooks/*` | Not limited by IP; protected by signature verification |

The per-email limit on login alongside the per-IP limit is deliberate: per-IP alone does nothing against a distributed credential-stuffing botnet hitting one account, and per-email alone lets one IP spray thousands of accounts. You need both dimensions.

---

## 12. Message queue strategy

### 12.1 Why a queue at all

Three distinct reasons, and it matters that they are distinct:

1. **Latency shedding.** Sending a confirmation email takes 300ms and can fail. That must not be inside the customer's request.
2. **Failure isolation.** The mail provider being down must not fail bookings. A queue with retries converts a dependency outage into a delay.
3. **Scheduled work.** Hold expiry is naturally a delayed job. Reconciliation is naturally a cron job.

### 12.2 Choice: BullMQ on Redis

We already run Redis, so this adds no new operational surface. BullMQ gives delayed jobs (exactly what a hold expiry is), per-job retries with configurable backoff, per-queue concurrency limits, repeatable/cron jobs, and a failed-job store we treat as a dead-letter queue.

Queues:

| Queue | Trigger | Notes |
|---|---|---|
| `outbox-relay` | Polling (200ms) + notify | Reads unpublished outbox rows, publishes, marks published |
| `reservation-expiry` | Delayed job at `expires_at` | Best-effort cleanup; correctness does not depend on it |
| `expiry-sweeper` | Cron, every 30 s | Backstop for lost delayed jobs. Single-runner via Redis lock |
| `webhook-processing` | Enqueued by the webhook endpoint | Confirms orders |
| `ticket-issuance` | `OrderPaid` event | Generates codes, renders passes |
| `email` | Various events | Retries up to 5× over ~1h |
| `reconciliation` | Cron, nightly | Diffs against the provider |
| `analytics` | Fire-and-forget | Lowest priority, droppable |

Two mechanisms for hold expiry (a delayed job *and* a cron sweeper) is not redundancy for its own sake: delayed jobs live in Redis, Redis can lose them, and neither mechanism affects correctness because of the `WHERE` clause in §8.2. The sweeper's job is to bound how long a freed seat stays invisible.

### 12.3 The transactional outbox, and the dual-write problem it solves

The broken version:

```ts
await db.transaction(async (tx) => { /* claim seats, insert reservation */ });
await queue.add('ReservationCreated', payload);   // ← may never run
```

If the process dies between those lines, the reservation exists and the event does not. No email, no analytics, no downstream reaction, and no record that anything is missing. Swapping the order is worse: now you can publish an event for a reservation that was rolled back. There is no ordering of two independent systems that makes two writes atomic. The problem is not the ordering; it is the assumption.

The fix is to make the event part of the same transaction:

```ts
await db.transaction(async (tx) => {
  /* claim seats, insert reservation */
  await tx.insert(outbox).values({
    aggregateType: 'reservation',
    aggregateId: reservationId,
    type: 'ReservationCreated',
    payload,
    traceContext: currentTraceContext(),   // so the worker's span joins this trace
  });
});
// A separate relay publishes it. At-least-once, guaranteed eventually.
```

Now the state change and the intent to publish commit or roll back together. The relay may publish a message twice (it can crash after publishing, before marking `published_at`), which is why every consumer must be idempotent. At-least-once plus idempotent consumers is the standard, achievable guarantee. "Exactly-once delivery" does not exist over an unreliable network; what exists is at-least-once delivery with exactly-once *effects*, achieved consumer-side:

```sql
INSERT INTO processed_messages (consumer, message_id)
VALUES ($1, $2)
ON CONFLICT DO NOTHING;
-- 0 rows inserted → already handled → ack and return.
```

That insert goes in the same transaction as the consumer's side effect, which makes "did the work" and "recorded that I did the work" atomic.

### 12.4 Retries, DLQ, and poison messages

Backoff is exponential with jitter: `min(2^attempt × 1s, 5min) × random(0.5, 1.5)`. Jitter matters because without it a dependency outage produces synchronized retry waves that hit the recovering dependency all at once and knock it back down.

After max attempts a job moves to the failed set (our DLQ) and increments a metric. A poison message (one that will fail forever, usually because of a code bug or malformed payload) must not block the queue: per-job retries plus concurrency > 1 means head-of-line blocking is not possible in BullMQ, which is a real advantage over a partitioned log for this workload. DLQ depth is an alerting metric with a documented runbook: inspect, fix, replay.

### 12.5 When we graduate away from BullMQ

Trigger conditions, written now so the decision is not made on vibes later:

- **Multiple independent consumers need the same event stream** with independent progress. Queues are point-to-point; this wants a log with per-consumer offsets. → Kafka, Redpanda, or NATS JetStream.
- **We need replay** of the last N days of events to rebuild a projection. → a log with retention.
- **Ordering guarantees per key** across a partition. → partitioned log.
- **Throughput above what a single Redis can absorb** while also serving cache traffic.

None of these are true today, and I want to be blunt: reaching for Kafka in Phase 7 would be the most common form of resume-driven architecture. When we do adopt it, we will adopt it for one named requirement, and we will keep BullMQ for job-like work, because a log is bad at delayed jobs and per-message retry.

---

## 13. Observability strategy

### 13.1 The mindset

For every feature we build, the design is not done until we answer: **"how will we know this broke in production, before a customer tells us?"** Observability is not logging added at the end. It is part of the acceptance criteria for each phase.

### 13.2 Logs

pino, structured JSON, one line per event, to stdout (the container collects it; the application never writes log files).

Every line carries: `timestamp`, `level`, `request_id`, `trace_id`, `span_id`, `user_id` when authenticated, `module`, `msg`. Business-significant lines add domain identifiers: `event_id`, `reservation_id`, `order_id`, `payment_id`.

`request_id` is generated at the proxy (or by Fastify's `genReqId` if absent), returned in a response header, echoed in every error body, and propagated into every queue job. When a customer emails "my booking failed at 8:04pm, here is the reference," one grep should produce the entire causal chain including worker activity.

Redaction is configured in pino, not left to reviewer discipline: `password`, `password_hash`, `token`, `refresh_token`, `authorization`, `cookie`, `client_secret`, `card`, `cvc`, and full email addresses at info level and below. A redaction unit test asserts that a payload containing each of these serializes without them.

Levels, used consistently: `error` = a human must eventually look; `warn` = a handled anomaly worth counting; `info` = state transitions and request summaries; `debug` = off in production, on for one request via a header in staging.

### 13.3 Metrics

Prometheus, scraped from `/metrics`.

HTTP (the RED method): `http_request_duration_seconds` histogram by `{method, route, status_class}`, request rate, error rate.
Resources (the USE method): `pg_pool_{total,idle,waiting}`, event loop lag, heap, `redis_command_duration_seconds`.
Domain (the ones that actually matter):

```
booking_hold_attempts_total{result="created|conflict|error"}
booking_hold_duration_seconds
booking_conversion_ratio               (holds → paid orders)
inventory_oversell_total               ← must be 0, alert on any increment
payment_attempts_total{result, failure_code}
payment_webhook_lag_seconds            (provider timestamp → processed)
reconciliation_mismatches_total{class}
queue_depth{queue}
queue_job_duration_seconds{queue}
queue_dlq_size{queue}
sweeper_lag_seconds
cache_requests_total{cache, result="hit|miss"}
db_deadlocks_total
```

**The cardinality rule.** Never put `event_id`, `user_id`, `order_id`, or a raw URL path into a Prometheus label. Each distinct label combination is a separate time series stored forever; one high-cardinality label takes down your monitoring, which means you lose observability exactly when you need it. Route templates (`/events/:id`), not paths. Per-entity questions are answered by traces and logs, which are indexed for exactly that. This is a mistake almost everyone makes once, and it is expensive.

### 13.4 Traces

OpenTelemetry, auto-instrumentation for Fastify, `pg`, ioredis, and outbound HTTP, plus manual spans around domain operations worth naming (`booking.hold`, `booking.lock_seats`, `payment.create_intent`, `webhook.process`).

The target trace:

```
POST /api/v1/holds                                        183 ms
├── auth.verify_jwt                                         1 ms
├── ratelimit.check (redis)                                 2 ms
├── booking.hold                                          178 ms
│   ├── db.transaction                                    174 ms
│   │   ├── SELECT ... FOR UPDATE       ← 151 ms of lock wait!
│   │   ├── UPDATE event_seats                              4 ms
│   │   ├── INSERT reservations                             2 ms
│   │   └── INSERT outbox                                   1 ms
│   └── (commit)                                            3 ms
└── serialize response                                      1 ms

... asynchronously, same trace:
worker: outbox-relay → publish ReservationCreated           4 ms
worker: email → send hold confirmation                    312 ms
```

That trace shows at a glance that a slow hold is lock contention rather than a slow query, which is a completely different fix. Getting from HTTP to worker in one trace requires propagating the W3C `traceparent` through the outbox row and job payload and re-attaching it in the consumer, which is why `trace_context jsonb` is in the outbox table from the start. Retrofitting that later means rewriting every producer.

Sampling: 100% in development, head-based ~10% in production with a rule that always samples errors and always samples the booking and payment paths.

### 13.5 Dashboards and alerts

Grafana dashboards: booking funnel (views → holds → orders → paid), API golden signals, dependency health, queue health, database health.

Alerts, with severity attached because a system that pages for everything trains you to ignore pages:

| Severity | Condition |
|---|---|
| **Page** | `inventory_oversell_total > 0`; database unreachable; payment success rate < 80% over 10 min; reconciliation mismatch class "paid locally, absent at provider" |
| **Ticket** | DLQ non-empty; webhook lag p95 > 60 s; sweeper lag > 5 min; error rate > 1% for 15 min; pool waiting > 0 sustained |
| **Dashboard** | Cache hit rate drop; conversion rate anomaly; latency drift within SLO |

---

## 14. Security strategy

### 14.1 Assets and adversaries

| Asset | Adversary | Consequence if lost |
|---|---|---|
| Password hashes | Credential stuffer, DB thief | Account takeover across sites |
| Session/refresh tokens | XSS, malicious extension, network attacker | Account takeover, fraudulent purchases |
| Money movement | Fraudster, insider | Direct financial loss, chargebacks |
| Ticket inventory | Scalper bot, competitor | Denial of inventory, revenue loss, reputational damage |
| Ticket codes | Forger, sharer | People at the door with fake tickets |
| Customer PII | DB thief, curious insider | Regulatory exposure, harm to users |
| Tenant isolation | Malicious organizer | One organizer reads or edits another's sales |

### 14.2 Controls mapped to OWASP Top 10

| Risk | Controls |
|---|---|
| **A01 Broken access control** | Permission checks at route level; tenant scoping enforced in the repository layer, not per query; unguessable UUIDv7 IDs (defense in depth, never the control); an integration test per endpoint asserting cross-tenant access returns 404 |
| **A02 Cryptographic failures** | TLS everywhere; Argon2id passwords; SHA-256-hashed tokens at rest; secrets from a secret manager; no card data in scope at all |
| **A03 Injection** | Parameterized queries only, enforced by an ESLint rule banning string interpolation into `sql\`\``; Zod validation at every boundary; output encoded by React |
| **A04 Insecure design** | Explicit state machines; DB constraints as invariants; threat model per feature; ADRs recording rejected alternatives |
| **A05 Misconfiguration** | Zod-validated environment that refuses to boot on a missing or malformed secret; security headers via `@fastify/helmet`; CORS allowlist, never `*` with credentials; body size limits; stack traces never returned to clients |
| **A06 Vulnerable components** | Dependabot; `pnpm audit` in CI; Trivy image scan blocking on high severity |
| **A07 Auth failures** | Rate limits on both email and IP dimensions; account lockout with backoff; refresh rotation with reuse detection; no account-existence leakage; constant-time comparisons |
| **A08 Data integrity failures** | Webhook signature verification over the raw body; timestamp tolerance for replay; signed ticket codes; lockfile committed and CI installs frozen |
| **A09 Logging failures** | Structured logs with correlation IDs; audit log for privileged actions; alerts that page; redaction tested |
| **A10 SSRF** | The only user-supplied URL is the organizer webhook, if we ever build it. Allowlist scheme and port, block RFC1918 and link-local ranges, resolve DNS then validate the resolved IP, no redirect following |

### 14.3 Ticketing-specific threats

**Denial of inventory.** This is the attack most people miss because it is not in any generic checklist. A bot does not need to buy tickets to ruin an onsale; it only needs to *hold* them and let them expire, repeatedly, so no real customer can ever get one. Standard rate limiting does not stop it because each request looks legitimate. Layered defenses: a cap on concurrent holds per user per event, hold quantity limits, email verification required before holding, account-age or payment-history heuristics for high-demand events, CAPTCHA at onsale, and a waiting-room queue (deliberately deferred, see §17). This is a good example of a threat that only exists because of the domain, which is why threat modeling per feature beats running down a generic list.

**Ticket forgery and sharing.** A ticket code must be unguessable (32 random bytes) and verifiable offline at the door. We store only the hash. For higher-value events, rotating time-based codes in an app beat static QR codes, since a static code can be screenshotted and sold to five people. Check-in marks the ticket used in a single atomic conditional update, so two scanners racing at two doors cannot both admit.

**Refund and chargeback abuse.** Refund eligibility is derived from the event's policy server-side, never from the request. Every refund is audit-logged with an actor. Rate limits on refund requests per user.

**Webhook replay.** Signature plus timestamp tolerance plus the unique provider event ID. Any two of these would probably be enough; all three cost nothing.

### 14.4 Secrets and configuration

Configuration is a Zod schema parsed once at boot. Missing or malformed values crash the process immediately with a clear message, because a service that starts with `JWT_SECRET=undefined` and serves traffic is far worse than one that refuses to start. No `process.env` access anywhere except that one module, enforced by lint.

Local development uses `.env` (gitignored, with a committed `.env.example` containing only placeholder values). Production uses GCP Secret Manager injected as environment variables at deploy time. CI runs secret scanning (gitleaks) on every push and on history. Rotation procedure is documented per secret, and the auth design supports key rotation via a `kid` claim and an overlapping-validity window, so rotating the signing key does not log everyone out.

### 14.5 Security testing

Phase 12 is an actual security review, not a checklist read-through. For each of the top risks we write an exploit against our own local instance, watch it work, fix it, and keep the exploit as a regression test. Working through "here is the request that steals another organizer's revenue report, and here is the one-line repository change that stops it" teaches broken access control in a way no amount of reading does. All of it stays local, against our own system.

---


## 15. Testing strategy

### 15.1 The shape of the pyramid, and why it is shaped that way

```
        ╱ E2E ╲             ~10 tests    Playwright, real browser, happy paths
      ╱─────────╲                        Slow, brittle, high confidence
    ╱ API tests  ╲          ~80 tests    fastify.inject() + real PG/Redis
  ╱───────────────╲                      Contract-level: status codes, authz, shapes
 ╱ Integration     ╲       ~150 tests    Real PG via Testcontainers
╱───────────────────╲                    Repositories, transactions, constraints
──── Unit ───────────      ~400 tests    Pure functions, state machines, pricing
                                         Milliseconds, no I/O
                        ┌──────────────┐
                        │ CONCURRENCY  │  ~15 tests, first-class
                        │ Real parallel│  Do not fit the pyramid; the most
                        │ transactions │  valuable tests in the project
                        └──────────────┘
```

The pyramid's shape follows from cost per test and diagnostic precision. A unit test that fails tells you which function is wrong. An E2E failure tells you something, somewhere, broke. Both are useful; you want many of the cheap precise ones and few of the expensive vague ones.

The deviation from orthodoxy: **integration tests run against real PostgreSQL, always. We never mock the database.** Mocking it would mean testing our beliefs about PostgreSQL rather than PostgreSQL. Since the entire correctness story rests on transactions, locks, and constraints, a mocked database tests nothing that matters. Testcontainers makes a real PG cheap enough that there is no excuse.

### 15.2 The concurrency test, in detail

This is the test that justifies the project, so it gets designed up front:

```ts
it('sells a seat to exactly one of 100 simultaneous buyers', async () => {
  const { eventId, seatId } = await seedEventWithSeats({ seats: 1 });

  // A barrier so all 100 requests are genuinely in flight together.
  // Sequential requests would pass trivially and prove nothing.
  const gate = new Barrier(100);
  const results = await Promise.all(
    range(100).map(async (i) => {
      const token = await tokenForUser(users[i]);
      await gate.wait();
      return app.inject({
        method: 'POST', url: '/api/v1/holds',
        headers: { authorization: `Bearer ${token}` },
        payload: { eventId, seatIds: [seatId] },
      });
    }),
  );

  expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
  expect(results.filter((r) => r.statusCode === 409)).toHaveLength(99);
  expect(results.filter((r) => r.statusCode >= 500)).toHaveLength(0);

  // Never trust the API's own report. Assert the database directly.
  const rows = await db.select().from(eventSeats).where(eq(eventSeats.eventId, eventId));
  expect(rows.filter((s) => s.status === 'held')).toHaveLength(1);
});
```

The last assertion is the point. A test that only checks response codes would pass against an implementation that returns 201 once and corrupts the database anyway. Test the invariant, not the story the code tells about itself.

Companion tests:
- 500 concurrent buyers, 100 GA tickets → exactly 100 succeed, `held + sold == 100`, zero constraint violations.
- Two overlapping multi-seat requests in opposite orders → assert deadlocks occur, then apply ordered locking and assert they stop. Both assertions are kept, because the "before" test documents why the `ORDER BY` exists.
- Hold expiry racing a payment webhook → assert the money-safe outcome, whichever side wins.
- Same idempotency key sent 50 times concurrently → exactly one hold created.

**Test isolation for concurrency tests.** The usual trick of wrapping each test in a transaction and rolling back does not work here, because concurrency tests need genuinely concurrent *committed* transactions. So: a PostgreSQL template database created once with the schema, cloned per test file (`CREATE DATABASE x TEMPLATE y` is fast), and truncation between tests within a file. Slower than transaction rollback, and unavoidable.

**An invariant check after every integration suite.** A single query asserting global sanity: no seat sold twice, no `held + sold > capacity`, no paid order without tickets, no ticket without a paid order. It runs at the end of every integration run, so any test that corrupts state anywhere gets caught even if no test asserted it directly.

### 15.3 Coverage and CI gates

Coverage is measured but not worshipped. Targets: ≥ 90% on domain and service layers (where the logic is), no target on route wiring and infrastructure glue (where coverage measures effort rather than confidence). The mandatory gates in CI are lint, typecheck, unit, integration, and the concurrency suite. A build cannot merge if the concurrency suite fails, ever, no exceptions, because that suite is the product's core promise.

### 15.4 Load testing (Phase 11+)

k6 scenarios, each with a hypothesis to confirm or refute:
1. Browse-heavy steady state → 500 rps, hypothesis: cache absorbs it, PG stays under 20% CPU.
2. Onsale spike → 0 to 2,000 VUs in 10 s on one event, hypothesis: p99 hold latency stays under 2 s and no 500s.
3. Redis killed mid-test → hypothesis: correctness holds, latency rises, nothing 500s.
4. Sustained soak, 1 hour → hypothesis: no memory growth, no connection leak.

For each we record rps, p50/p95/p99, error rate, CPU, memory, PG connections and `pg_stat_statements` top queries, Redis ops/sec, and queue lag. Then we find the bottleneck by measurement rather than intuition: check saturation signals in order (event loop lag → pool waiting → PG CPU → lock waits → Redis latency), because a guess about the bottleneck is wrong more often than not, and optimizing the wrong layer is how weeks disappear.

---

## 16. Development roadmap

Estimates assume 8–12 focused hours per week. Total: roughly 8 months. The point is depth, so the estimates are deliberately unhurried, and phase boundaries are where we stop and review rather than deadlines.

| M | Phase | Weeks | Definition of done |
|---|---|---|---|
| **M0** | Engineering setup | 1 | Monorepo, strict TS, Fastify boots, lint/format/typecheck in CI, Compose with PG, first migration applied, `/health` and `/ready` distinguish correctly, one integration test green, ADRs 0001–0004 written, initial commit |
| **M1** | Domain modeling | 1 | Entities, relationships, state machines, and invariants written in `DATABASE.md`; transition matrix unit-tested with no implementation behind it yet |
| **M2** | PostgreSQL schema | 2–3 | Full schema migrated; every invariant expressed as a constraint; seed script produces a realistic venue and event; repository layer with real-PG integration tests; first `EXPLAIN ANALYZE` session on browse queries; keyset pagination implemented and compared against `OFFSET` |
| **M3** | Authentication | 3 | Register, verify, login, refresh with rotation and reuse detection, logout one/all, session list, password reset; RBAC permissions; the full auth test suite including a scripted token-theft scenario |
| **M4** | Events and venues | 3 | Organizer CRUD, layout versioning, event publish materializing inventory, browse/search with PG full-text, seat map endpoint, tenant isolation tests |
| **M5** | **Booking engine** | 4–5 | Holds (specific + best-available + GA), expiry, idempotency keys, release, the whole concurrency suite green, deadlock demonstrated then fixed, load-tested onsale spike. **The centrepiece phase** |
| **M6** | Redis | 2 | Cache-aside with single-flight and stale-while-revalidate, distributed rate limiting in Lua, distributed lock for the sweeper, degradation tests with Redis killed |
| **M7** | Messaging | 3 | BullMQ, worker entrypoint, outbox + relay, idempotent consumers, retries with jitter, DLQ with a runbook, dual-write failure demonstrated before the outbox exists |
| **M8** | Payments | 4 | Stripe behind a provider port, intents with idempotency keys, webhook verify/persist/ack/process, order confirmation, ticket issuance, refunds, reconciliation job, every failure scenario in §10.3 tested |
| **M9** | Notifications | 1–2 | Templated transactional email, async and retried, provider-outage test |
| **M10** | Observability | 2–3 | pino with correlation IDs and tested redaction, OTel traces spanning HTTP→PG→queue→worker, Prometheus metrics, Grafana dashboards, alert rules, a full Compose observability stack |
| **M11** | Testing and load | 2–3 | Playwright E2E, k6 scenarios, documented bottleneck hunt with before/after numbers |
| **M12** | Security review | 2 | Threat model per module, self-exploitation of the top risks kept as regression tests, dependency and image scanning, `SECURITY.md` |
| **M13** | Production infra | 3–4 | Multi-stage non-root images, Caddy in front, GCP: VPC, firewall, IAM, Cloud SQL, Memorystore, Secret Manager, Artifact Registry, Cloud Run or a VM MIG, backups plus a **rehearsed restore** |
| **M14** | CI/CD | 2 | Full pipeline through image scan and deploy, migration strategy for zero-downtime, rollback rehearsed |
| **M15** | Scaling | 3 | Multiple instances behind a load balancer, PgBouncer, read replica for analytics, index and query tuning with measurements, cache and queue scaling |
| **M16** | Distributed systems | 3 | Extract one service (notifications is the honest candidate) to feel the cost first-hand; saga for a multi-step flow; CAP and consistency models mapped to what we built |
| **M17** | Production simulation | ongoing | Game days: break something without warning, detect it from dashboards alone, write a blameless postmortem |

At the end of each milestone you get the review block you asked for in §43: what you learned, what we built, why, which production problems it solves, remaining weaknesses, exercises, and what comes next.

---

## 17. What we are deliberately NOT building yet

This list exists so that "we should add X" has a documented answer, and so that adding X later is a decision rather than a drift. Each item has the trigger that would change my mind.

| Not building | Why not | Build it when |
|---|---|---|
| **Microservices** | Our modules have no independent scaling need; a network boundary turns compile errors into pager duty; one engineer cannot operate eight services | A module has a genuinely different scaling profile or needs an independent release cadence, and the monolith's boundaries are already clean enough that extraction is mechanical |
| **Kubernetes** | It solves multi-service orchestration, bin-packing, and self-healing at a scale we do not have. Cloud Run or a managed instance group covers us for a long time | We run more than ~5 services, need sophisticated rollout control, or have a team to operate a cluster |
| **Kafka** | Wrong tool for job queues; enormous operational surface | One of the four triggers in §12.5 |
| **Read replicas** | Adds replication lag as a correctness hazard for read-your-writes | Read load actually saturates the primary. First fix indexes and caching, in that order |
| **Sharding / partitioning** | Massive complexity for a dataset that will fit in RAM for years | `event_seats` grows past ~100M rows. Then partition by event, not before |
| **Elasticsearch** | PG full-text search with a GIN index handles our corpus fine | We need fuzzy matching, faceting, and relevance tuning that PG cannot express, with measured proof |
| **CQRS / event sourcing** | Doubles the model count and makes every simple query a projection | A read model's shape diverges so badly from the write model that queries become unmaintainable |
| **Waiting room / virtual queue** | Correct answer to onsale spikes; significant infrastructure | We prove with load tests that hold-endpoint contention cannot be solved with locking and rate limits alone |
| **Seat map visual editor** | Weeks of frontend work, zero backend learning | Never in this project. JSON layout import is enough |
| **Ticket resale marketplace** | Changes the domain model fundamentally (ownership transfer, escrow, price caps) | A separate project |
| **Dynamic pricing** | Needs a pricing engine, price history, and audit; distracts from concurrency | Not in scope |
| **Multi-currency / i18n** | Currency is in the schema so we are not painted into a corner, but FX, rounding, and settlement are a large domain | Not in scope |
| **Terraform / IaC** | Learning GCP by clicking first makes the IaC meaningful rather than magical | M13, after the console version works and we understand what we are declaring |
| **Feature flags** | One deploy target, one engineer | Multiple environments and a need for trunk-based dark launches |
| **Mobile app** | No backend learning | Never in this project. The API stays mobile-ready |
| **Admin UI** | Backend admin endpoints plus psql are enough at first | M12+, and only the screens we have actually needed twice |
| **GraphQL** | REST plus generated OpenAPI types serves one known client well; GraphQL's N+1 and complexity-limiting problems are a project of their own | Multiple clients with genuinely divergent data needs |
| **Multi-region** | Cross-region consistency for inventory is a research problem | Not in scope |

The meta-point: every one of these is a *good* technology that would be *wrong right now*. Engineering maturity is mostly the ability to hold both of those thoughts at once.

---

## 18. Day-1 implementation plan

Small, real, and finished today. Every step earns its place.

### Steps

1. **Repository and tooling.** Initialize git, pnpm workspace (`apps/api`, `packages/config`), `.gitignore`, `.nvmrc` pinning Node 22, conventional-commit config. Branch strategy: trunk-based on `main` with short-lived `feat/*` branches and PRs, even solo, because reviewing your own diff catches things.

2. **TypeScript, configured strictly.** `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`, `verbatimModuleSyntax: true`, ESM, `moduleResolution: "bundler"` or `"node16"`, target ES2023. Shared base config in `packages/config`. Turning the strict flags on now costs an hour; turning them on in month four costs a week.

3. **ESLint + Prettier.** Flat config, `typescript-eslint` with type-aware rules, `no-floating-promises` and `no-misused-promises` as errors (in Node, a forgotten `await` is a silent data-loss bug, not a style issue).

4. **Environment configuration.** `src/shared/config/env.ts`: a Zod schema for `NODE_ENV`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`, parsed once at boot, exported as a frozen typed object. Process exits with a readable message on invalid input. `.env.example` committed; `.env` gitignored. This is also your first practical encounter with `z.infer`.

5. **Docker Compose.** PostgreSQL 17 with a named volume, a real `healthcheck` using `pg_isready`, port 5432, and a separate database for tests. No application container yet; the API runs on the host with hot reload while the dependency runs in Docker. Fewer moving parts on day 1.

6. **Database client.** `pg.Pool` with explicit `min`, `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`, `statement_timeout`, and `application_name` (so `pg_stat_activity` tells you which process is holding a lock, which you will want in Phase 5). Drizzle instance wrapping the pool. Graceful shutdown that drains the pool on SIGTERM, because a container killed mid-transaction leaves locks behind.

7. **First migration.** `0001_init.sql`: enable `pgcrypto` and `citext`, create `users` exactly as in §7.1. No auth logic, no routes, just the table. Plus a migration runner that records applied migrations in a `_migrations` table inside a transaction and takes a PostgreSQL advisory lock so two instances starting simultaneously cannot both apply it. That lock is the whole reason we write the runner rather than shelling out to a tool: it is a five-minute lesson in why concurrent deploys corrupt schemas.

8. **Fastify app.** `app.ts` exports `buildApp()` returning a configured instance without listening. `api.ts` imports it, listens, and handles SIGTERM/SIGINT with a graceful close. Registered from the start: pino logger with `genReqId` and a `x-request-id` response header, `@fastify/helmet`, `@fastify/cors` with an allowlist, a 1 MB body limit, and the Zod type provider.

9. **Health endpoints, done properly.** Three, not one, because they answer different questions:
   - `GET /health/live` → is the process alive? Returns 200 with no dependency checks. Kubernetes and Cloud Run restart the container when this fails, so checking the database here means a database blip restarts every one of your app instances and turns a small outage into a large one.
   - `GET /health/ready` → can this instance serve traffic? Checks `SELECT 1` with a 1-second timeout. Failing removes the instance from the load balancer without killing it.
   - `GET /health` → human-readable detail: version, commit SHA, uptime, per-dependency status and latency.

   Getting liveness and readiness backwards is one of the most common and most damaging deployment mistakes, which is why it is a day-1 lesson rather than a Phase 13 footnote.

10. **Error handling foundation.** A base `AppError` with `code`, `httpStatus`, and `isOperational`; a Fastify `setErrorHandler` that emits a consistent envelope (`{ error: { code, message, requestId, details? } }`), logs operational errors at `warn` and unexpected ones at `error` with the stack, and never leaks internals to the client. Also `process.on('unhandledRejection')` and `'uncaughtException'` that log and exit non-zero rather than continuing in an unknown state.

11. **Test harness.** Vitest, plus a Testcontainers helper that starts a real PostgreSQL, runs migrations, and yields a connection string. Three tests: liveness returns 200 with the database stopped; readiness returns 503 with the database stopped and 200 with it running; the `users` table exists with the expected constraints after migration. That third test is really a test of the migration runner, which is the piece most likely to bite us later.

12. **CI pipeline (minimal).** GitHub Actions on push and PR: install with a frozen lockfile, lint, typecheck, unit tests, integration tests with a PG service container. Nothing else yet.

13. **Frontend skeleton.** Vite + React + TS, one page that calls `GET /health` and renders the result, TanStack Query wired up, Vite proxy to the API. This proves the full local loop end to end and nothing more.

14. **Documentation and ADRs.** `README.md` with a working quickstart; skeleton `ARCHITECTURE.md`, `DATABASE.md`, `API.md`; ADRs 0001 (modular monolith), 0002 (PostgreSQL as source of truth), 0003 (Drizzle over Prisma), 0004 (UUIDv7 primary keys), each with context, decision, alternatives, trade-offs, consequences.

15. **Commit.** Conventional commits, a handful of logical commits rather than one `initial commit`, then tag `v0.0.1`.

### Day-1 definition of done

- `docker compose up -d && pnpm install && pnpm migrate && pnpm dev` gives a running API and frontend on a clean machine.
- `pnpm test` passes, including a test that runs against a real PostgreSQL.
- `pnpm lint && pnpm typecheck` are clean with strict TypeScript.
- Stopping PostgreSQL makes readiness fail and liveness pass.
- CI is green on the first PR.
- Four ADRs explain the four decisions that are expensive to reverse.

### Explicitly not on day 1

No JWT, no bcrypt, no Redis, no queue, no Stripe, no Kubernetes, no OpenTelemetry, no seats, no events. Not because they are hard, but because introducing them before there is a problem they solve means you learn the library instead of the concept.

---

## 19. Selected references

Kept short on purpose; each one is worth reading in full when we reach the relevant phase.

- **PostgreSQL manual, ch. 13 "Concurrency Control."** The primary source on MVCC, isolation levels, and explicit locking. Read before M5. Everything else written about PG isolation is a summary of this.
- **Kleppmann, *Designing Data-Intensive Applications*, ch. 7 (Transactions) and 9 (Consistency and Consensus).** The best available treatment of why the anomalies in §8.1 exist. Read alongside M5 and M16.
- **Stripe docs: "Idempotent requests" and "Best practices for using webhooks."** Short, specific, and directly applicable in M8.
- **OWASP Application Security Verification Standard, plus the Password Storage and Session Management cheat sheets.** Our M3 and M12 checklist.
- **microservices.io: Transactional Outbox, Saga, Database per Service.** Reference patterns for M7 and M16.
- **Google SRE Workbook, ch. 2 "Implementing SLOs" and ch. 5 "Alerting on SLOs."** Turns §13.5 from a list of metrics into a policy.
- **Kleppmann, "Please stop calling databases CP or AP" (2015).** Read before M16, so we discuss CAP precisely rather than as a slogan.
- **Bailis & Ghodsi, "Eventual Consistency Today" (CACM, 2013).** Good grounding for the consistency-model discussion in M16.

---

## 20. Decisions needing your sign-off

Five are expensive to reverse. Say yes, or tell me which to change and why.

1. **Drizzle over Prisma.** Chosen for SQL transparency. If you would rather have Prisma's DX, say so now; the migration cost after M2 is significant.
2. **UUIDv7 primary keys generated in the application.** The alternative is `bigint` internal plus a public ULID.
3. **Two inventory mechanisms** (row-per-seat for reserved, counter for GA) rather than one unified fake-seat model.
4. **Reservation / Order / Ticket as three entities** rather than one `booking` table with a status column.
5. **pnpm monorepo** with a shared contracts package, rather than two separate repositories.

Cheap to change later, listed for awareness: Fastify, Zod, BullMQ, Stripe test mode, Caddy, Vitest.

Also useful to confirm: your Node and pnpm versions, your OS (affects Docker and Testcontainers setup), and whether you eventually need real INR settlement, which would move us from Stripe to Razorpay behind the same provider port.