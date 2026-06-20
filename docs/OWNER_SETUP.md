# WorkCrew owner setup and launch checklist

This is the list of things only you can do, because they involve identity,
banking, contracts, or accounts. For each item, create the account, then copy
the values listed into the in-app Settings screen (being built) or send them to
be placed in the server secret store. Do not paste secrets into chat.

The app already runs end to end in a local mode (real local accounts, a
simulated paywall, and mock AI), so building and testing continues without any
of these. Each item below switches one part from local or simulated to real.

## Priority order

1. Anthropic API key (makes the AI actually respond).
2. Decide the company jurisdiction for Stripe (this gates real payments).
3. Supabase project (real cloud accounts).
4. Stripe account and products (real subscriptions).
5. Backend hosting and a domain (so it is a real online product, not local only).
6. Transactional email sender (verification and password reset).
7. Windows code signing certificate (trusted installer).
8. Legal documents and brand clearance.

## 1. Anthropic (the AI engine)

- Create an account at console.anthropic.com.
- Add a small amount of credit (for example 10 to 20 dollars to start).
- Create an API key.
- Collect: the API key (starts with sk-ant-).

This is the only item needed to see real answers and real automation planning.
Everything else can wait. Until this is set, the app uses mock responses.

## 2. Company jurisdiction (gates Stripe)

Stripe requires a registered business and a bank account in a supported
country. If the operating company is in a country Stripe does not support
(Lebanon is not supported, for example), real card payments are blocked until
you either use a company and bank in a supported country, or we switch to a
merchant of record provider that handles global payments and tax for you
(Paddle or Lemon Squeezy are the common alternatives).

- Decide: which country and legal entity will collect payments.
- If unsupported by Stripe, decide: form a supported entity, or use Paddle or
  Lemon Squeezy instead. Tell me which and I will wire that provider.

## 3. Supabase (real accounts in the cloud)

- Create a project at supabase.com (pick a region near your users, set and save
  the database password).
- In Project Settings, then API, collect:
  - Project URL.
  - anon public key.
  - service_role secret key (used only by the backend, never shipped).
- In Authentication settings, enable email and password sign up, and turn on
  email confirmation for production.

## 4. Stripe (real subscriptions)

Start in test mode (no real money, test cards).

- Create a Stripe account and keep the dashboard in Test mode.
- In Developers, then API keys, collect:
  - Secret key (starts with sk_test_).
  - Publishable key (starts with pk_test_).
- Products and prices: you do not need to create these by hand. Send me the test
  secret key and I will create the four prices and return their ids, or you
  create them and collect the four Price ids:
  - Pro monthly, 27 dollars.
  - Pro yearly, 270 dollars.
  - Ultra monthly, 200 dollars.
  - Ultra yearly, 2000 dollars.
- Webhook signing secret (starts with whsec_). For local testing this comes from
  the Stripe CLI. For production it comes from the webhook you register against
  the hosted backend URL.
- For going live later: complete Stripe identity, business, tax, and bank
  verification, then repeat with the live keys.

## 5. Backend hosting and domain (turns local into a real product)

Right now the backend (the part that holds the AI key, the database, and the
payment logic) runs on your own PC. For a real launched product with many users
and real payments, that backend must run on a server with a public address.

- Choose a host for the backend service (Railway, Render, or Fly.io are simple
  options). I will provide the deployment configuration.
- Choose a database for production (the current local database can move to a
  hosted libSQL or Turso, or to the Supabase Postgres database).
- Buy a domain name (for the backend, the marketing and legal pages, and email).
- Collect: the host account, the domain, and (once deployed) the public backend
  URL to point the desktop app at.

## 6. Transactional email sender (production email)

For verification and password reset emails in production, a real sender is
needed so messages are not marked as spam.

- Create an account at Resend or Postmark.
- Verify your domain (add the DNS records they provide).
- Collect: the sending API key and the from address (for example
  no-reply@yourdomain).

## 7. Windows code signing (trusted installer)

Without signing, Windows SmartScreen warns users on first install.

- Buy a code signing certificate from a certificate authority (DigiCert or
  Sectigo). An OV certificate is the minimum, an EV certificate avoids the
  SmartScreen warning entirely but costs more and ships on hardware.
- Collect: the certificate and its password, or run the signing step on a
  machine that holds the certificate. I will wire the signing into the build.

## 8. Legal and brand

- Provide your business name, address, and a support email.
- We will draft Terms of Service, Privacy Policy, Refund and Cancellation
  Policy, and an Acceptable Use Policy. A lawyer should review them before
  taking real payments.
- Run a trademark and domain check on the name WorkCrew before public launch.

## What I will build in the meantime (no owner action needed)

- The chat experience (ask anything, streamed answers, history).
- Document upload and chat with your files.
- Real browser automation on your Chrome and real Windows automation.
- Routines (scheduled automations).
- The Settings screen where you paste the keys above.
- The real Supabase and Stripe adapters, so switching from local and simulated
  to real is a configuration change, not a rewrite.
