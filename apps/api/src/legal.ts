// The public pricing and policy pages served at the backend root alongside the
// landing page. Payment providers require a live, linked Terms of Service,
// Privacy Policy, Refund Policy and Pricing page before they will verify a
// merchant account, and they check that the site actually links to them.
//
// These are plain, self-contained HTML pages sharing the landing page's dark
// theme. No provider or vendor names appear anywhere.

import { PLAN_CATALOG, SUPPORT_EMAIL } from "@workcrew/contracts";

// Kept in one place so every policy shows the same "last updated" date and the
// pricing page can never drift from the plan catalog the app actually bills on.
const LAST_UPDATED = "7 August 2026";

function brandGlyph(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;flex:0 0 auto">
<defs>
<linearGradient id="lgMark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="0.55" stop-color="#7c3aed"/><stop offset="1" stop-color="#5b21b6"/></linearGradient>
<mask id="lgPlus"><rect width="100" height="100" fill="white"/><rect x="41" y="29" width="18" height="42" rx="9" fill="black"/><rect x="29" y="41" width="42" height="18" rx="9" fill="black"/></mask>
</defs>
<g mask="url(#lgPlus)" fill="url(#lgMark)"><circle cx="50" cy="28" r="22"/><circle cx="50" cy="72" r="22"/><circle cx="28" cy="50" r="22"/><circle cx="72" cy="50" r="22"/><rect x="28" y="28" width="44" height="44" rx="14"/></g>
</svg>`;
}

/** Shared shell: same palette as the landing page, with the cross-links every
 *  policy page must carry so a reviewer can reach all of them from any one. */
function shell(title: string, description: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | WorkCrew</title>
<meta name="description" content="${description}">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(brandGlyph(100))}">
<style>
:root{--bg:#1b1a19;--panel:#262523;--line:#393634;--text:#f1efec;--muted:#a8a39d;--accent:#8b5cf6;--accent2:#a78bfa}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',-apple-system,system-ui,Arial,sans-serif;line-height:1.65;-webkit-font-smoothing:antialiased}
a{color:var(--accent2)}
.wrap{max-width:780px;margin:0 auto;padding:0 22px}
header{border-bottom:1px solid var(--line);padding:18px 0}
header .row{display:flex;align-items:center;gap:10px}
header .name{font-weight:700;font-size:18px}
main{padding:44px 0 20px}
h1{font-size:34px;line-height:1.2;margin:0 0 6px}
.updated{color:var(--muted);font-size:14px;margin:0 0 34px}
h2{font-size:20px;margin:34px 0 10px}
p,li{color:#ded9d3}
ul{padding-left:20px}
table{width:100%;border-collapse:collapse;margin:18px 0}
th,td{border:1px solid var(--line);padding:12px 14px;text-align:left}
th{background:var(--panel);font-size:14px;color:var(--muted);font-weight:600}
.plan{font-weight:700}
.note{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:16px 18px;margin:20px 0}
footer{border-top:1px solid var(--line);margin-top:54px;padding:26px 0;color:var(--muted);font-size:13px}
footer a{margin-right:16px}
</style></head><body>
<header><div class="wrap row">${brandGlyph(28)}<span class="name">WorkCrew</span></div></header>
<main><div class="wrap">
${body}
</div></main>
<footer><div class="wrap">
  <a href="/">Home</a><a href="/pricing">Pricing</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refund-policy">Refunds</a>
  <div style="margin-top:12px">Contact: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></div>
</div></footer>
</body></html>`;
}

export function pricingPage(): string {
  const pro = PLAN_CATALOG.pro;
  const ultra = PLAN_CATALOG.ultra;
  // Thousand separators, so a yearly price reads "$2,000" rather than "$2000".
  const money = (amount: number): string => `$${amount.toLocaleString("en-US")}`;
  return shell("Pricing", "WorkCrew plans and pricing. Start free, upgrade when you need more.", `
<h1>Pricing</h1>
<p class="updated">All prices in US dollars (USD). Billed by subscription.</p>

<table>
  <tr><th>Plan</th><th>Monthly</th><th>Yearly</th><th>What you get</th></tr>
  <tr>
    <td class="plan">Free trial</td><td>$0</td><td>&mdash;</td>
    <td>A one-time allowance of usage to try WorkCrew. No payment details required. It does not renew.</td>
  </tr>
  <tr>
    <td class="plan">${pro.name}</td><td>${money(pro.monthlyPriceUsd)}/month</td><td>${money(pro.yearlyPriceUsd)}/year</td>
    <td>Everyday use: chat, documents and spreadsheets, working in your folders, and automating your apps and browser. ${pro.devices} device.</td>
  </tr>
  <tr>
    <td class="plan">${ultra.name}</td><td>${money(ultra.monthlyPriceUsd)}/month</td><td>${money(ultra.yearlyPriceUsd)}/year</td>
    <td>Everything in ${pro.name}, with a much larger monthly usage allowance and stronger engines for demanding work. Up to ${ultra.devices} devices.</td>
  </tr>
</table>

<h2>How usage works</h2>
<p>Each plan includes a monthly usage allowance. Usage is consumed as you chat,
generate files, and run automations, and your remaining allowance is always
visible inside the app. Paying yearly costs less than paying monthly for the
same plan.</p>

<h2>Billing</h2>
<p>Subscriptions renew automatically at the end of each billing period, monthly
or yearly, until cancelled. You can cancel at any time from your account
settings; cancelling stops all future billing and you keep access until the end
of the period you have already paid for.</p>

<div class="note">Before you pay anything, you get a free trial with no payment
details required. Please see our <a href="/refund-policy">Refund Policy</a>.</div>
`);
}

export function termsPage(): string {
  return shell("Terms of Service", "The terms governing your use of WorkCrew.", `
<h1>Terms of Service</h1>
<p class="updated">Last updated: ${LAST_UPDATED}</p>

<p>These terms govern your use of WorkCrew (the "Service"). By creating an
account or using the Service you agree to them. If you do not agree, do not use
the Service.</p>

<h2>1. The Service</h2>
<p>WorkCrew is subscription software that helps you carry out work on your own
computer and in your browser: answering questions, creating and editing
documents and spreadsheets, reading files and folders you choose, and automating
tasks in applications you permit it to use. WorkCrew acts only with the
permissions you grant, and you can stop it at any time.</p>

<h2>2. Your account</h2>
<p>You must provide accurate information and keep your password secure. You are
responsible for activity under your account. You must be old enough to enter a
binding contract in your country. One person or organisation per account; do not
share credentials.</p>

<h2>3. Acceptable use</h2>
<p>You agree not to use WorkCrew to break the law, infringe anyone's rights,
send spam, attack or gain unauthorised access to systems, or automate a service
in a way that breaches that service's own terms. You are responsible for the
tasks you instruct WorkCrew to perform and for the content you provide.</p>

<h2>4. Subscriptions and payment</h2>
<p>Paid plans are billed in advance, monthly or yearly, and renew automatically
until cancelled. Prices are shown on our <a href="/pricing">Pricing page</a>. We
may change prices, and will give reasonable notice before a change affects your
renewal. Payments are processed by our payment provider, who may act as merchant
of record for the transaction. Taxes may be added where required.</p>

<h2>5. Cancellation and refunds</h2>
<p>You may cancel at any time from your account settings. Cancelling stops
future billing and you keep access until the end of the paid period. Refunds are
governed by our <a href="/refund-policy">Refund Policy</a>.</p>

<h2>6. Usage limits</h2>
<p>Each plan includes a usage allowance, and the Service may stop performing
paid work once an allowance is exhausted until it renews or you upgrade. We may
apply reasonable limits to protect the Service from abuse.</p>

<h2>7. Your content</h2>
<p>You keep ownership of everything you provide and everything WorkCrew produces
for you. You grant us only the permission needed to operate the Service for you.
See our <a href="/privacy">Privacy Policy</a>.</p>

<h2>8. Our intellectual property</h2>
<p>WorkCrew, its software, and its branding remain ours. Your subscription grants
you a personal, non-exclusive, non-transferable right to use the Service while
your subscription is active. You may not copy, resell, reverse engineer, or
redistribute the software.</p>

<h2>9. Automated output</h2>
<p>WorkCrew uses automated systems that can make mistakes. Output may be
inaccurate or incomplete. You are responsible for reviewing results before
relying on them, particularly for anything financial, legal, medical, or
otherwise consequential. WorkCrew is a tool, not professional advice.</p>

<h2>10. Availability</h2>
<p>We aim to keep the Service available but do not guarantee uninterrupted
service. We may modify, suspend, or discontinue features. If we discontinue a
paid plan entirely, we will give notice and refund any unused prepaid period.</p>

<h2>11. Suspension and termination</h2>
<p>We may suspend or close an account that breaches these terms, is used
unlawfully, or presents a security or payment-fraud risk. You may close your
account at any time from your account settings.</p>

<h2>12. Disclaimers and liability</h2>
<p>To the fullest extent permitted by law, the Service is provided "as is"
without warranties of any kind, and our total liability arising from the Service
is limited to the amount you paid us in the twelve months before the claim. We
are not liable for indirect or consequential loss, including lost profits or
lost data. Nothing here limits liability that cannot lawfully be limited, and
these limits do not affect the statutory rights of consumers.</p>

<h2>13. Changes to these terms</h2>
<p>We may update these terms. If a change is material we will give reasonable
notice. Continuing to use the Service after a change takes effect means you
accept the updated terms.</p>

<h2>14. Contact</h2>
<p>Questions about these terms: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
`);
}

export function privacyPage(): string {
  return shell("Privacy Policy", "What WorkCrew collects, why, and the control you have over it.", `
<h1>Privacy Policy</h1>
<p class="updated">Last updated: ${LAST_UPDATED}</p>

<p>This policy explains what we collect, why, and what control you have. WorkCrew
is designed so your work stays under your control: it acts only with permissions
you grant, and it does not roam your computer on its own.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Account details.</strong> Your email address, a securely hashed
  password, and your name if you provide one.</li>
  <li><strong>Conversations.</strong> The messages you send and the replies you
  receive, so your chat history is there when you return.</li>
  <li><strong>Usage records.</strong> How much of your plan allowance you have
  used, so we can show your remaining balance and enforce plan limits.</li>
  <li><strong>Subscription details.</strong> Your plan, status and renewal date.
  Card details are handled by our payment provider and never reach our
  servers.</li>
  <li><strong>Basic technical data.</strong> IP address and request information,
  used for security, abuse prevention and rate limiting.</li>
</ul>

<h2>What stays on your computer</h2>
<p>Files and folders you point WorkCrew at are read on your own machine. Their
contents are sent to our servers only insofar as they form part of a request you
make, and only for the purpose of answering that request. WorkCrew does not
browse, index or upload your drive.</p>

<h2>Automated processing</h2>
<p>To answer you, the content of your request is processed by third-party model
providers acting on our behalf under contract. They are not permitted to use
your content to train their models. We do not sell your data, and we do not use
your content for advertising.</p>

<h2>Optional analytics</h2>
<p>The application can send anonymous product analytics to help us find bugs and
improve features. This is <strong>off by default</strong> and can be turned on or
off at any time in Settings. It never includes the content of your
conversations or your files.</p>

<h2>Why we are allowed to process this</h2>
<p>We process your data to provide the service you have asked for and to perform
our contract with you, to comply with legal and tax obligations, and for our
legitimate interest in keeping the service secure and preventing abuse.</p>

<h2>How long we keep it</h2>
<p>We keep your account and conversation data while your account is open. If you
delete your account, we delete your personal data and conversations, except
records we must retain for legal, tax or accounting reasons, such as invoices.</p>

<h2>Security</h2>
<p>Passwords are stored hashed and never in readable form. Traffic is encrypted
in transit. Access to production data is restricted. No system is perfectly
secure, but we take reasonable measures appropriate to the data we hold.</p>

<h2>Your rights</h2>
<p>You can access, correct, export or delete your data. You can delete your
account and all associated data at any time from your account settings.
Depending on where you live, you may also have the right to object to or
restrict processing, and to complain to your data protection authority. To
exercise any of these, email
<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

<h2>International transfers</h2>
<p>Our service providers may process data in countries other than yours. Where
that happens we rely on appropriate safeguards for the transfer.</p>

<h2>Children</h2>
<p>WorkCrew is not intended for children, and we do not knowingly collect data
from anyone under 16.</p>

<h2>Changes</h2>
<p>We may update this policy and will change the date above when we do. Material
changes will be notified.</p>

<h2>Contact</h2>
<p>Privacy questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
`);
}

export function refundPolicyPage(): string {
  return shell("Refund Policy", "When WorkCrew refunds, and how cancelling works.", `
<h1>Refund Policy</h1>
<p class="updated">Last updated: ${LAST_UPDATED}</p>

<h2>Try before you pay</h2>
<p>Every WorkCrew account includes a free trial. No payment details are required
to start it. We provide the trial so you can evaluate WorkCrew fully before you
spend anything.</p>

<h2>Subscriptions</h2>
<p>Because a free trial is provided before any payment is taken,
<strong>subscription payments are non-refundable</strong>, except as set out
below.</p>

<h2>When we do refund</h2>
<ul>
  <li><strong>Duplicate charges</strong>, where you were billed more than once
  for the same period.</li>
  <li><strong>Accidental or unauthorised charges</strong>, including a renewal
  taken after you had already cancelled.</li>
  <li><strong>Any refund required by law.</strong> If you are a consumer in the
  European Union or the United Kingdom you have a statutory right to withdraw
  from a purchase of digital content within 14 days, subject to the conditions
  presented at checkout. Nothing in this policy limits that right.</li>
</ul>

<h2>Cancelling</h2>
<p>You can cancel at any time from your account settings. Cancelling stops all
future billing immediately. You keep full access until the end of the period you
have already paid for. There is no cancellation fee.</p>

<h2>If something is wrong</h2>
<p>If WorkCrew is not working as described, please contact us before requesting
a chargeback from your bank. We would rather fix the problem or make it right,
and most issues are resolved the same day.</p>

<h2>Contact</h2>
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
`);
}
