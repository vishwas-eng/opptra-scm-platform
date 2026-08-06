# Connector doctrine

How we integrate a channel, and why. Written after the 2026-08-06 research pass; it
overrides the earlier "reverse-engineering-first" note, which optimised for the wrong
thing.

## The ladder

Pick the highest rung the channel actually supports. Never a lower one for convenience.

| Rung | Transport | Channels | Why it wins |
|---|---|---|---|
| 1 | **Official API** | Amazon SP-API (IN/AE/SA), Flipkart Seller API | Documented, rate-limited on purpose, survives password changes, cannot get the account flagged |
| 2 | **Partner API** | Blinkit (vendor ID whitelisted), JioMart (creds from the category manager) | Real API, but access is granted per integrator/vendor, ask, don't scrape |
| 3 | **Email PO ingestion** | Zepto, Swiggy Instamart, BigBasket, Flipkart Minutes | For Indian quick commerce this IS the industry transport. Unicommerce, EasyEcom and Fynd all do exactly this |
| 4 | **Portal session (RE)** | Myntra, Nykaa, Ajio, noon, Namshi, 6th Street, Home Centre | Only when nothing above exists |

**Rung 4 is a last resort, not a default.** The earlier plan treated every channel as a
reverse-engineering target. That would have meant building scrapers for four
quick-commerce portals whose data arrives by email anyway, while walking past AWS WAF
(Zepto), reCAPTCHA v3 (BigBasket) and a custom token header (Instamart) to get it.

## Ride Unicommerce where it already goes

Unicommerce ingests **Blinkit, Zepto, Instamart, BigBasket and Flipkart Minutes** today.
We already have a first-class Unicommerce connector. Building direct connectors for
those five would duplicate work we can simply read.

What Unicommerce does **not** do, and therefore what is actually worth building:

- no catalog sync, no inventory push
- **no status flow-back to the channel** (it is a one-way PO import)
- nothing on **appointment booking**, **ASN↔GRN reconciliation**, **fill-rate / OTIF**,
  or **debit-note disputes**

Those gaps are the product. The PO import is not.

## Rules for rung 4 (portal sessions)

Every RE connector calls through `createPortalGuard()` from `@opptra/connectors-sdk`.
Not optional, the guard is what keeps a portal session from looking like a bot:

1. **Serial per portal.** One session, one in-flight request. Parallel fan-out from a
   single cookie is the loudest bot signal there is.
2. **Paced with jitter.** A metronomic interval is itself a fingerprint.
3. **Obey the server.** `Retry-After` is honoured exactly, capped so a hostile header
   cannot park a worker.
4. **Never retry a block.** 403, CAPTCHA or a login redirect stops the call dead.
   Retrying into a challenge is what turns a soft block into a ban.
5. **Circuit breaker.** Repeated blocks halt the connector until a human resets it.
   Time alone never resumes traffic.
6. **Daily budget.** A runaway loop cannot issue 100k requests overnight.

Defaults are deliberately timid (≈1 request/second with jitter, 5k/day). A connector
that needs more must say so explicitly in its policy.

Also: identify honestly in the User-Agent, reuse one session rather than opening many,
and never parallelise a single account across workers.

## Credentials

Modelled on n8n's credential system: credentials are typed, stored once, and injected by
the connector, never pasted into a workflow step.

- Everything lands in `connector_credentials`, sealed with AES-256-GCM
  (`packages/core/src/secretBox.js`). The column stores ciphertext; `getConnectorSecret`
  returns the opened value and only the worker calls it.
- OAuth grants (Amazon) are keyed per marketplace, so `in`, `ae` and `sa` are three
  independent authorizations.
- Captures never persist live session material: it is lifted, sealed, and the stored
  capture is redacted (`packages/capture/src/redact.js`).

## Adding a channel

1. Establish its rung. Check for a developer portal, then ask the account manager, then
   check whether Unicommerce already ingests it. Only then consider RE.
2. Record the finding in `packages/connectors-stubs/src/index.js` (`transport`,
   `viaUnicommerce`, `note`) so nobody re-researches it.
3. Rungs 1–2: build a typed client against the docs.
   Rung 3: parse the mailbox, not the portal.
   Rung 4: run a capture (`docs/CONNECT-FLOW.md`), then build behind a PortalGuard.
4. Register actions with real `inputSchema`s, the schema is enforced, not documentation.
5. Add it to `LIVE_CONNECTOR_IDS` **only after a real call against the real account
   succeeds.** A scaffold existing is never grounds for going live.

## Verified traps

Each of these would have sent a build in the wrong direction:

- **Flipkart's `hyperlocal` listings API is not Flipkart Minutes.** It dates to 2018 and
  serves Flipkart Quick. "Flipkart Minutes" appears in no Flipkart API doc.
- **Swiggy's `mcp.swiggy.com` Instamart tools are consumer-side ordering** for AI agents, `search_products`, `checkout`, `track_order`. Nothing brand-side.
- **"Unicommerce integrates with Swiggy Networks" is not Instamart.** Swiggy Networks is
  the B2B kirana-distribution arm.
- **Amazon India Vendor Central is `vendorcentral.in`**, not `vendorcentral.amazon.in`
  (India is the only region that breaks the pattern). Its OAuth consent flow is
  documented-broken upstream, treat India vendor APIs as unverified until tested live.
- **`partner.blinkit.com` and `vendor.zeptonow.com` do not exist**, despite many blogs
  citing them. Correct hosts are in `packages/connectors-stubs/src/index.js`.
