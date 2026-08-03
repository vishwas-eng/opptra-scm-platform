# Opptra: The Supply-Chain Agent Workspace

**From an automation panel to an AI operations platform for supply-chain teams.**

Version 0.1 · 31 Jul 2026 · Owner: Vishwas · Status: plan for review

---

## 0. The one-paragraph thesis

Today Opptra SCM is a web app where an ops person clicks a button and one hard-coded automation runs against Unicommerce. The next version is a **workspace where any supply-chain user assembles their own agents from a library of connectors** — Amazon, Flipkart, Unicommerce, Sheets, Drive, WhatsApp, Slack, couriers — and lets those agents run their daily work (packing mail, stock sync, exception chasing, report pulls) on a schedule or on a trigger, with a human approving anything that touches money or customers. We are not building "another Zapier." We are building the **vertical agent platform for Indian/GCC marketplace operations** — the domain we already run inside Opptra, with connectors and playbooks nobody else has bothered to build. Dogfood on our own ops first; sell the same workspace to other sellers and 3PLs second.

---

## 1. Why this is the right bet, honestly

**The market is real and forming now.** McKinsey projects agentic commerce could reach ~$1T of US retail by 2030; 90+ startups are already building; three protocols (Anthropic's MCP, Google's A2A, OpenAI/Stripe's ACP) are becoming the connector-layer standard. Horizontal players — Zapier Agents (7,000+ apps), Lindy, Gumloop, n8n — own generic office automation. **None of them speak supply chain.** They don't know what a GRN is, that a Zepto B2B SO cancels differently from a Myntra one, that an e-way bill needs a 15-char transporter GSTIN, or that Home Centre runs on Vinculum with an RSA-encrypted login. That domain knowledge is our moat, and we already have it in code.

**The honest risks, up front:**
- **Connector access is gated, not free.** Amazon SP-API needs a Professional seller account + developer registration + identity verification; Flipkart needs seller approval (3–5 days); WhatsApp needs a Meta Business account and per-message billing. These are weeks of paperwork per marketplace, not an afternoon of coding. The plan sequences around this.
- **"Very high-end AGI that will fuck the supply chain industry" is the north star, not the MVP.** The winning move is narrow and deep: 3–4 connectors + 5 killer playbooks that save a real ops team hours a day, proven on our own floor, before we widen.
- **We must not become an inventory/OMS business by accident.** Sell software and services; UC/marketplaces stay as connectors. (This is already the stated vision — keep it.)

**Why we're well-positioned:** the current codebase is *already* 70% of an agent runtime without anyone naming it that. See §2.

---

## 2. What we already have (the platform is hiding in the repo)

The survey of `opptra-scm-platform` shows the hard parts are done. Re-labeled in platform terms:

| Agent-platform primitive | Already exists as | Where |
|---|---|---|
| **Connector interface** | 11 `@opptra/*` packages, each a dependency-injected client with mockable wrappers | `packages/uc-client`, `integrations-google`, `integrations-vinculum`, `automation-*` |
| **Connector: Unicommerce** | Full two-layer client (bearer + session), rate-limited, facility-aware, 975 mapped endpoints in `unicommerce-engine/` | `packages/uc-client` |
| **Connector: Google (Sheets/Drive/Gmail)** | 3 auth modes incl. per-user OAuth consent + token vault | `packages/integrations-google`, `core/googleOAuth.js`, `user_google_oauth` table |
| **Connector: Vinculum/Home Centre** | RSA login + order mapper + configurable fulfill runner | `packages/integrations-vinculum` |
| **Credential vault** | Postgres token stores: shared + per-user Google OAuth, UC session singleton, ingest tokens (hashed) | `core`, migrations 002/004/006 |
| **Job runtime / agent executor** | BullMQ worker, 17 job types, single-concurrency where correctness needs it, self-re-enqueue for long flows | `apps/worker`, `handlers.js` |
| **Run ledger / observability** | `runs` table (input/result/status/artifacts), `audit_log`, KPI endpoint, Slack alerts | `core/runs.js`, `routes/admin.js` |
| **Approval / human-in-the-loop** | Draft-first packing mail, dry-run e-way, `pending_retry` resumable states | `automation-packing`, `automation-ewaybill`, `automation-return` |
| **Idempotency** | `step_ledger` (memoStep) — a step never double-fires on retry | migration 003 |
| **Machine/agent auth** | `OPS_AGENT_TOKEN` + `/api/ops/summary` (agents skip SSO) | `routes/ops.js` |
| **RBAC + multi-user** | `users` (admin/ops/viewer), per-request DB role check, per-user rate limits | `plugins/auth.js` |
| **Scheduling** | BullMQ repeatable jobs (keepalive, sheet-sync) | `worker.js` |
| **Workspace shell** | Sidebar with an "Agents" group, KPI dashboard, region toggle | `apps/web/public` |

**The one thing genuinely missing: there is no LLM anywhere.** No `anthropic`/`openai` dependency, no agent loop, no natural-language layer, no connector *registry* (connectors are hard-wired into handlers, not discoverable/composable). That gap — plus a credential vault generalized beyond Google/UC — *is the build*. Everything else is refactoring what exists into named, reusable shapes.

---

## 3. Target architecture

Five layers. We already have layers 1, 4, and most of 5.

```
┌──────────────────────────────────────────────────────────────────────┐
│ 5. WORKSPACE UI                                                        │
│    Agent builder · connector gallery · run inbox · approvals ·         │
│    schedules · KPI  (evolve today's SPA; later a proper app)           │
├──────────────────────────────────────────────────────────────────────┤
│ 4. AGENT RUNTIME                                                       │
│    Trigger (schedule / webhook / manual / event)                       │
│      → Planner (LLM w/ tool schemas)  →  Tool calls (connectors)        │
│      → Approval gate (money/customer-facing steps pause for a human)    │
│      → Run ledger + memory   [BullMQ worker, extended]                 │
├──────────────────────────────────────────────────────────────────────┤
│ 3. CONNECTOR LAYER  (the moat)                                         │
│    A uniform Connector SDK. Each connector = auth + typed actions +     │
│    triggers + a tool manifest the LLM can call.                        │
│    Native: Unicommerce, Google, Vinculum (have) · Amazon SP-API,       │
│    Flipkart, WhatsApp, Slack, Shiprocket/Delhivery, Waypoint,          │
│    Postgres/Sheet (build).  Long-tail: proxy via MCP/Composio/Nango.   │
├──────────────────────────────────────────────────────────────────────┤
│ 2. CREDENTIAL VAULT + IDENTITY                                         │
│    Per-workspace, per-connector encrypted credentials (OAuth tokens,   │
│    API keys, sessions). Generalize today's Google/UC token stores.     │
├──────────────────────────────────────────────────────────────────────┤
│ 1. CORE PLATFORM  (have)                                               │
│    Fastify API · BullMQ · Postgres · Redis · RBAC · audit · GCP VM     │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 The Connector SDK (the single most important new abstraction)

Every connector — ours or third-party — implements one shape so the runtime, the UI gallery, and the LLM all treat them identically:

```
Connector = {
  id, name, category, icon,
  auth:     { kind: 'oauth2' | 'apikey' | 'session' | 'basic', ...config },
  actions:  [ { id, title, inputSchema (zod/JSON-schema), outputSchema, run(ctx, input) } ],
  triggers: [ { id, title, kind: 'poll' | 'webhook', schedule?, emit(ctx) } ],
  toolManifest(): ToolSpec[]   // what the LLM planner sees — derived from actions
}
```

- **Refactor the existing `automation-*` packages into this shape.** `automation-ewaybill.generateOne` becomes `unicommerce.generateEwayBill` action; `automation-packing.createDrafts` becomes `packing` playbook composed of `sheets.read` + `drive.find` + `gmail.draft`. This is renaming + interface-fitting, not a rewrite.
- **`toolManifest()` is the LLM bridge:** an action's `inputSchema` *is* the tool-use schema. One converter turns every connector action into an Anthropic tool definition. Adding a connector automatically gives every agent new abilities — no runtime changes.
- **`ctx`** carries: the workspace's vaulted credentials for that connector, a scoped logger, the run id, and an `approve()` primitive that pauses for human sign-off.

### 3.2 The Agent Runtime

An agent is config, not code:

```
Agent = {
  id, workspaceId, name, instructions (natural language),
  connectors: [ids the agent may use],
  trigger: { schedule | webhook | manual | event },
  approvalPolicy: { autoRun: [...safe actions], requireApproval: [...money/customer actions] },
  model: 'claude-...'
}
```

Execution loop (extends the current worker, doesn't replace it):
1. Trigger fires → enqueue a `agent.run` job (reuse BullMQ + `runs` ledger).
2. Planner: Claude with the union of the agent's connectors' tool manifests + the agent's instructions + relevant memory.
3. Each tool call executes the connector action; **money/customer-facing actions hit the approval gate** → run parks in `pending_approval` (a new `runs.status`, mirrors the existing `pending_retry` mechanic) → a human approves in the run inbox → resume.
4. Everything is logged to `runs`/`audit_log`; artifacts (PDFs, drafts) attach as today.

Reuse verbatim: idempotency (`step_ledger`), rate limits, single-concurrency for UC, Slack alerting, resumable-run pattern.

### 3.3 Multi-tenancy (the SaaS turn)

Today it's single-workspace (Opptra). To sell it: add a `workspaces` table, stamp `workspace_id` on `users`, `runs`, `agents`, `connector_credentials`; scope every query. This is a well-understood migration and can wait until after the internal MVP proves value — but design the schema for it now (add the column, default it to the Opptra workspace).

---

## 4. Connector roadmap (build order = access-difficulty × value)

| Connector | Access reality | Value | Phase |
|---|---|---|---|
| **Unicommerce** | ✅ have it | core | done |
| **Google Sheets/Drive/Gmail** | ✅ have it | core | done |
| **Vinculum/Home Centre** | ⚠️ have code, creds invalid | med | fix creds |
| **Waypoint (Neon)** | ✅ direct DB read | high | done |
| **Slack** | easy — outbound have; add inbound bot (Events API) | high (agent I/O channel) | Phase 1 |
| **WhatsApp Business** | Meta Business acct + per-msg billing (₹0.13 utility); no monthly floor | very high (warehouse comms) | Phase 1–2 |
| **Shiprocket / Delhivery** | seller signup; Shiprocket aggregates 17 couriers under one API | high (tracking/manifest agents) | Phase 2 |
| **Amazon SP-API** | Pro seller + dev registration + ID verify (~weeks) | very high | Phase 2 (start paperwork Phase 1) |
| **Flipkart Seller API** | seller approval, 3–5 days | very high | Phase 2 |
| **Meesho / Zepto / Blinkit / Swiggy Instamart** | varies; some no public API → seller-portal automation | high | Phase 3 |
| **Long-tail (Notion, Jira, etc.)** | proxy via **MCP registry / Composio (~$29/mo, ~1000 tools) / Nango (OSS, own the stack)** | breadth | Phase 3 |

**Build-vs-buy rule:** hand-build the supply-chain connectors that are our moat (marketplaces, UC, couriers, WhatsApp). For generic SaaS breadth, **wrap an existing aggregator** (Composio for speed, Nango if we want to own it) rather than writing 500 connectors. MCP is the lingua franca — expose our own connectors *as* MCP servers so external agents (and Claude itself) can call them, and consume external MCP servers as connectors.

---

## 5. Playbooks — the things that actually save hours (ship these, not "a chat box")

An agent workspace is worthless without killer default agents. These are compositions of connectors we can ship as templates:

1. **Packing Autopilot** (have most of it) — every morning: pull today's CREATED SOs → draft per-warehouse packing mail with label+appointment → wait for approval → send → follow up with invoice+e-way in-thread. *Connectors: UC, Sheets, Drive, Gmail/WhatsApp.*
2. **Stock Sync Guardian** — watch marketplace inventory vs UC; when they drift, flag or auto-correct with approval. *Connectors: Amazon/Flipkart, UC, Slack.*
3. **Exception Autopilot** ("Supply Brain") — a running exception feed: stuck SOs, appointment-expiry cancellations, short-GRN, failed e-way. Each exception carries a one-click playbook. *Connectors: UC, Waypoint, Slack/WhatsApp.*
4. **Appointment & Label Chaser** — pull appointment letters/labels from Drive/Amazon by date, attach, nudge warehouses on WhatsApp. *Connectors: Drive, Amazon, WhatsApp.*
5. **Daily Ops Digest** — one WhatsApp/Slack message per morning: what shipped, what's stuck, what needs a human. *Connectors: UC, Waypoint, Slack/WhatsApp.*
6. **Report Puller** (have the FMCG version in Python) — scheduled inventory/batch pulls to Sheets/GCS. *Connectors: UC, Sheets/GCS.*

Each is a template a user can clone and tweak in natural language. **The chat/agent-builder is the wrapper; the playbooks are the product.**

---

## 6. Phased delivery

**Phase 0 — Name the platform (2–3 wks, no new external access needed).**
Refactor `automation-*` into the Connector SDK shape; build the connector *registry* + `toolManifest()`; add the credential-vault generalization + `workspaces`/`workspace_id` columns (defaulted). Ship the first real LLM agent loop behind a flag, driving **only existing UC/Google actions**. Outcome: "type an instruction, it runs one of our automations" — internal only. *This is mostly renaming and wiring; low risk, high leverage.*

**Phase 1 — First outside connectors + approvals UI (3–4 wks).**
Slack inbound bot + WhatsApp Business (start the Meta paperwork day 1). Run inbox with approve/reject. Ship **Packing Autopilot** and **Daily Ops Digest** as templated agents on our own floor. Start Amazon/Flipkart developer registration now (long lead time).

**Phase 2 — Marketplace connectors + exception autopilot (6–8 wks).**
Amazon SP-API + Flipkart (as approvals land) + Shiprocket/Delhivery. Ship **Stock Sync Guardian** and **Exception Autopilot**. This is the "wow" moment — cross-system agents.

**Phase 3 — Open the workspace (SaaS) (ongoing).**
Flip on multi-tenancy, self-serve connector auth, connector gallery, MCP in/out, Composio/Nango for the long tail. Onboard the first external seller/3PL beyond Opptra.

**Sequencing rule:** every phase must leave a working, dogfooded system. No big-bang rewrite — the current platform keeps running the whole time.

---

## 7. Decisions needed from you (blockers in bold)

1. **Which LLM + budget posture?** Recommend Claude (we already run on it; tool-use + MCP native). Per-run cost is real — the AGENTS.md cost-discipline applies double to agent loops.
2. **Which 2 connectors first after Slack/WhatsApp — Amazon or Flipkart?** Whichever seller account we control most cleanly. **Start that developer registration this week** (weeks of lead time).
3. **Internal-only how long before first external customer?** Recommend: prove 3 playbooks on Opptra for ~6–8 weeks before selling.
4. **Buy vs build the long tail?** Recommend Composio to start (fast, cheap), keep the option to move to Nango (own it) once volume justifies.
5. **Do we expose our connectors as public MCP servers?** Recommend yes eventually — it makes Opptra callable from Claude/any agent, a distribution channel.

---

## 8. What I'd do first if you say go

1. Write the `Connector` interface + registry, and refactor `automation-ewaybill` and `automation-packing` into it as the two reference connectors (proves the shape on one simple and one composite automation).
2. Add the `toolManifest()` → Anthropic-tool converter and a minimal `agent.run` worker job that can call those two via Claude, behind a feature flag.
3. Generalize the credential vault (one `connector_credentials` table, per-workspace) and add the `workspaces` scaffolding.
4. Build the run-inbox + approval gate UI on the existing SPA.
5. Kick off Amazon/Flipkart/WhatsApp access paperwork in parallel (non-eng, long lead).

None of this breaks a single thing running today — it's additive, and the first agent drives automations we've already proven.

---

## Sources

Agent-platform landscape: [Engini — Best AI Agent Builders 2026](https://engini.ai/blog/ai-agent-builder-guide-top-platforms-tools-enterprise-solutions), [Lindy — Gumloop vs Zapier vs Lindy](https://www.lindy.ai/blog/gumloop-vs-zapier), [Lindy — n8n alternatives](https://www.lindy.ai/blog/n8n-alternatives). Agentic commerce: [CommerceIQ](https://www.commerceiq.ai/blog/powering-the-future-of-agentic-commerce), [commercetools — 7 AI trends](https://commercetools.com/blog/ai-trends-shaping-agentic-commerce), [nshift](https://nshift.com/blog/agentic-commerce-ai-shopping-agents-2026). MCP + connector platforms: [modelcontextprotocol.io architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture), [WorkOS — MCP in 2026](https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026), [Composio — Nango alternatives](https://composio.dev/content/nango-alternatives-ai-agents), [Nango — Composio vs Nango](https://nango.dev/blog/composio-vs-nango/). Marketplace/comms/logistics APIs: [Amazon SP-API registration](https://developer-docs.amazon.com/sp-api/docs/registering-your-application), [Flipkart Seller API v3](https://seller.flipkart.com/api-docs/FMSAPI.html), [WhatsApp Business API India pricing](https://richautomate.in/blog/whatsapp-business-api-cost-india-2026), [Shiprocket courier integrations](https://www.shiprocket.in/carrier-integrations/delhivery/).
