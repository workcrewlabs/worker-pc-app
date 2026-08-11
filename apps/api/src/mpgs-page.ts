import { config } from "./config.js";

/**
 * The page that hands the payer over to the bank.
 *
 * It carries no card fields of its own: the gateway's own script draws the
 * payment form, so card numbers go straight from the payer's browser to the bank
 * and never touch this server. All this page contributes is the session id, which
 * is useless to anyone else, and a place to land.
 */
export function mpgsCheckoutPage(input: { sessionId: string; orderId: string; planName: string; amount: string }): string {
  // Everything interpolated below is either server-generated (ids, prices) or
  // from the plan catalog, but it is escaped anyway: a page that hands over to a
  // payment form is the last place to rely on a value being tame.
  const escape = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Complete your payment</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #FAF9F5; color: #22211F; font: 15px/1.55 "Segoe UI", system-ui, Arial, sans-serif;
  }
  .card { width: min(460px, 100%); padding: 28px; border: 1px solid #DCD8CC; border-radius: 16px; background: #fff; text-align: center; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  .muted { color: #6E6A60; font-size: 13px; }
  .amount { margin: 18px 0; font-size: 30px; font-weight: 700; }
  button { width: 100%; padding: 13px 16px; border: 0; border-radius: 10px; cursor: pointer; background: #8B5CF6; color: #fff; font: inherit; font-weight: 650; }
  button:hover { filter: brightness(1.06); }
  .note { margin-top: 16px; font-size: 12px; color: #6E6A60; }
  .err { margin-top: 14px; padding: 10px 12px; border-radius: 9px; background: #FAEAEA; color: #A22C34; font-size: 13px; display: none; }
  @media (prefers-color-scheme: dark) {
    body { background: #1F1E1D; color: #ECEAE4; }
    .card { background: #27262A; border-color: #393733; }
    .muted, .note { color: #9A938A; }
  }
</style>
<script src="${escape(config.mpgs.baseUrl)}/static/checkout/checkout.min.js"
        data-error="errorCallback" data-cancel="cancelCallback"></script>
<script>
  function errorCallback(error) {
    var box = document.getElementById("err");
    box.style.display = "block";
    box.textContent = "The payment could not be started. Please close this page and try again.";
    if (window.console) console.log(JSON.stringify(error));
  }
  function cancelCallback() {
    var box = document.getElementById("err");
    box.style.display = "block";
    box.textContent = "Payment cancelled. Nothing has been charged.";
  }
</script>
</head>
<body>
  <main class="card">
    <h1>WorkCrew ${escape(input.planName)}</h1>
    <p class="muted">Order ${escape(input.orderId)}</p>
    <div class="amount">$${escape(input.amount)}</div>
    <button id="pay" type="button">Pay by card</button>
    <div id="err" class="err"></div>
    <p class="note">Your card details are entered on Bank of Beirut's own secure page. WorkCrew never sees them.</p>
  </main>
<script>
  Checkout.configure({ session: { id: ${JSON.stringify(input.sessionId)} } });
  document.getElementById("pay").addEventListener("click", function () {
    Checkout.showPaymentPage();
  });
</script>
</body>
</html>`;
}

/** The page the gateway returns the payer to once they are done. */
export function mpgsResultPage(input: { ok: boolean; heading: string; message: string }): string {
  const escape = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escape(input.heading)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #FAF9F5; color: #22211F; font: 15px/1.55 "Segoe UI", system-ui, Arial, sans-serif; }
  .card { width: min(460px, 100%); padding: 28px; border: 1px solid #DCD8CC; border-radius: 16px; background: #fff; text-align: center; }
  h1 { margin: 0 0 10px; font-size: 20px; color: ${input.ok ? "#1E6B3E" : "#A22C34"}; }
  p { margin: 0; color: #6E6A60; font-size: 14px; }
  @media (prefers-color-scheme: dark) {
    body { background: #1F1E1D; color: #ECEAE4; }
    .card { background: #27262A; border-color: #393733; }
    p { color: #9A938A; }
  }
</style>
</head>
<body><main class="card"><h1>${escape(input.heading)}</h1><p>${escape(input.message)}</p></main></body>
</html>`;
}
