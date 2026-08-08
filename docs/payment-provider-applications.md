# Payment provider application pack

Answers to copy straight into a Merchant of Record (MoR) application, replacing
Stripe. WorkCrew is operated from Lebanon by an individual with no registered
company, so an MoR is required rather than a payment gateway: the MoR becomes the
legal seller, handles global VAT and sales tax, and pays out to Payoneer.

## You do not need a registered company

Verified 2026-08-07 against the providers' own docs, because Paddle's "Business
Identification" page looks like it demands company papers. That page is the
**registered company** path. Paddle's identity-verification page says: *"If you
are an individual or sole trader, you will be the person required to do the
identity verification check."* Paddle *"does not require that you establish a
separate legal entity."* Dodo says the same.

**At sign-up choose "Individual", not "Business."** The shareholder-ownership
documents then never apply.

Registration is not the blocker. **Payouts are.**

## Priority order (payout rail is what decides it)

| # | Provider | Payoneer payout? | Notes |
|---|----------|------------------|-------|
| 1 | Paddle | **Yes, documented** | Wire or Payoneer. Min payout $100. Lebanon not on the unsupported-seller list. Best product. |
| 2 | Dodo Payments | **Yes, documented** | No registered company required. Fastest approval. |
| 3 | 2Checkout / Verifone | Unconfirmed | Historically permissive with hard-to-serve countries. |
| 4 | FastSpring | **No** | Pays via HyperWallet and PayPal. PayPal receiving in Lebanon is restricted, so it likely cannot pay out at all. Demoted for that reason. |
| 5 | Gumroad | No (PayPal) | Emergency bridge only, same PayPal problem. |

**Paddle payout timing:** balance converts on the 1st if over $100, sends by the
15th, arrives up to 3 working days later. Budget roughly a month from first sale
to first money received.

## The one question worth asking

Payout rails are answered above. The only thing no provider publishes is seller
eligibility, decided case by case by compliance:

> "I am an individual based in **Lebanon** with no registered company, applying
> as an Individual seller. Can I onboard and receive payouts to Payoneer?"

**Where to ask:** the support chat widget on their site, or the "anything else we
should know" free-text field on the application, or by replying to the onboarding
email once a reviewer is assigned. That last one is most reliable.

## Disclose the previous termination

The earlier setup traded on a **family member's Stripe account under their
company**, and was banned. Trading through someone else's account violates the
terms of every processor, so **do not repeat it**. The MoR structure removes the
need: the MoR is the legal seller, so no borrowed company is required.

When asked "have you ever been terminated by a payment processor?", answer
**yes**:

> "A previous account was held under a family member's company because Stripe
> does not support Lebanon as a seller country. That account was closed. I am now
> applying in my own name, for my own product, and want the arrangement to be
> correct from the start."

A truthful disclosure is a normal underwriting conversation. A false answer found
later is grounds for termination **and withholding funds already collected from
customers**, which is far worse than a rejection. Expect the domain to possibly
carry a risk flag, which is why several applications run in parallel.

## Live policy URLs (deployed, verified 2026-08-07)

- https://getworkcrew.com/pricing
- https://getworkcrew.com/terms
- https://getworkcrew.com/privacy
- https://getworkcrew.com/refund-policy

The homepage footer links to all four, which providers require and check.

## Application answers

**Business / product name:** WorkCrew
**Website:** https://getworkcrew.com

**What do you sell?**
A subscription software product (SaaS). WorkCrew is an AI assistant for Windows,
also available in the browser, that helps people do office work on their own
computer: answering questions in chat, creating and editing Excel spreadsheets
and documents, reading local files and folders, and automating repetitive tasks
across the user's applications and browser.

**Business model**
Recurring monthly and annual subscriptions, sold directly to the end user from
our website and from inside the desktop application. No physical goods, no
one-time purchases, no marketplace, no user-to-user payments.

**Pricing**
- Free trial: a one-time usage allowance at sign-up, no card required, does not renew.
- Pro: 27 USD per month, or 270 USD per year.
- Ultra: 200 USD per month, or 2,000 USD per year.

**Who are your customers?**
Small business owners, founders, freelancers and independent professionals
(sales, marketing, finance, consulting, admin) automating routine computer work.
Mainly English-speaking customers worldwide, largest share in North America,
Europe and the Middle East.

**Expected monthly volume**
Early stage, initially under 5,000 USD per month, growing through the year.
Average order value 27 USD monthly or 270 USD annually.

**How do you acquire customers?**
Direct sign-ups on our website, word of mouth, and an in-product referral
programme. No affiliate networks, no cold outbound, no paid lead resellers.

**Refund policy**
Every user gets a free trial before paying, with no card required, so the product
can be evaluated fully before any charge. Subscriptions are therefore
non-refundable, except where required by law and except for duplicate or
accidental charges, which are always refunded. Customers can cancel at any time
from their account; cancelling stops future billing immediately and access
continues to the end of the paid period. Published at /refund-policy.

**Delivery method**
Instant digital delivery. On payment the account upgrades automatically and
access is immediate in the app and on the web. Nothing is shipped.

**Chargeback and fraud controls**
All access is tied to a verified email account. Plans are granted only after the
provider confirms payment via a signature-verified webhook, never on a button
click, so access cannot be obtained without a completed payment. Usage is metered
and capped per account, limiting the value of a stolen-card signup.

**Do you sell anything restricted?**
No. No adult content, gambling, firearms, pharmaceuticals, financial advice,
crypto trading, or regulated services. A general-purpose productivity tool.

**Technical integration**
Hosted checkout plus webhooks. The backend already grants plans exclusively from
a signature-verified webhook, matching how every MoR expects integration to work.

## Documents to have ready

Government photo ID, proof of address, possibly a selfie or liveness check, and
Payoneer account details for payouts.

## After approval

Do not paste API keys into chat. Put them into the backend's environment
variables in the Render dashboard.

## What changes in the code

Everything Stripe-specific is behind six functions in `apps/api/src/billing.ts`:
`createCheckout`, `changePlan`, `cancelSubscriptionForDeletion`, `createPortal`,
`handleStripeWebhook`, `isEntitledStatus`. `server.ts` touches billing only
through those plus the `/v1/billing/*` routes and the `/billing/success` and
`/billing/cancel` pages.

The architecture already matches how MoRs work: plans are granted **only** from a
verified webhook, and every handler is replay-safe (guarded by `stripe_events`,
with `usage_ledger.dedupe_id` enforcing single-grant on credits). That is usually
the part that has to be rebuilt, and it is already correct.

No provider abstraction was written yet, deliberately: the seams cannot be drawn
correctly until there is a real second implementation to draw them against.

### Keep these when swapping
- Grant plans only from the verified webhook, never from a client call.
- Keep the raw body for signature verification (Fastify `rawBody` is configured).
- Keep handlers idempotent so a replayed webhook cannot double-grant.
- The free plan must never reach the provider: `paidPlanIdSchema` enforces this.
