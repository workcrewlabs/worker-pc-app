/**
 * The admin dashboard, served as one self-contained page at /admin.
 *
 * It holds no secret. It signs in with a normal WorkCrew account through the
 * public auth route, keeps the resulting access token in memory only (never in
 * localStorage, so closing the tab ends the session), and calls the /v1/admin
 * routes with it. The backend decides who is an admin; this page is only a face
 * for those routes and shows nothing until one of them answers.
 *
 * No external stylesheet, font, or script: the page must work under the strict
 * connect-src 'self' policy the route sets.
 */
export function adminPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>WorkCrew admin</title>
<style>
  :root {
    --bg: #1F1E1D; --panel: #27262A; --line: #393733; --text: #ECEAE4; --muted: #9A938A;
    --accent: #8B5CF6; --danger: #ff7979; --ok: #6ee7a8; --warn: #efc26a;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: var(--bg); color: var(--text);
    font: 14px/1.5 "Segoe UI", system-ui, Arial, sans-serif;
  }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .sub { margin: 0 0 22px; color: var(--muted); font-size: 13px; }
  .card { max-width: 1180px; margin: 0 auto 18px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
  .signin { max-width: 380px; margin: 8vh auto; }
  label { display: block; margin-bottom: 12px; font-size: 12px; font-weight: 600; color: var(--muted); }
  input, select {
    width: 100%; margin-top: 5px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px;
    background: #1a1917; color: var(--text); font: inherit;
  }
  input:focus, select:focus { outline: 0; border-color: var(--accent); }
  button {
    padding: 9px 14px; border: 1px solid var(--accent); border-radius: 9px; cursor: pointer;
    background: var(--accent); color: #fff; font: inherit; font-weight: 600;
  }
  button.ghost { border-color: var(--line); background: transparent; color: var(--text); font-weight: 500; }
  button.danger { border-color: #6e3e43; background: transparent; color: var(--danger); font-weight: 500; }
  button:disabled { opacity: .55; cursor: default; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
  .row > label { flex: 1 1 150px; margin-bottom: 0; }
  .grow { flex: 1 1 220px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 9px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .4px; }
  td.actions { white-space: nowrap; text-align: right; }
  td.actions button { margin-left: 6px; padding: 6px 10px; font-size: 12px; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 99px; font-size: 11px; font-weight: 600; }
  .pill-paid { background: #15241b; color: var(--ok); }
  .pill-free { background: #2a2825; color: var(--muted); }
  .pill-soon { background: #241e12; color: var(--warn); }
  .pill-expired { background: #281619; color: #ffc3c3; }
  /* Spend against the monthly allowance: the figures, then a bar that colours
     as the account approaches its cap, so a heavy month is visible at a glance
     down the column without reading a single number. */
  .usage { min-width: 148px; }
  .usage-nums { font-size: 12px; white-space: nowrap; }
  .usage-pct { float: right; color: var(--muted); }
  .bar { height: 5px; margin-top: 5px; border-radius: 99px; background: #2a2825; overflow: hidden; }
  .bar span { display: block; height: 100%; border-radius: 99px; }
  .bar-ok { background: var(--ok); }
  .bar-warm { background: var(--warn); }
  .bar-hot { background: var(--danger); }
  .notice { margin: 12px 0 0; padding: 10px 12px; border-radius: 9px; font-size: 13px; }
  .notice-error { background: #281619; color: #ffc3c3; }
  .notice-ok { background: #15241b; color: var(--ok); }
  .muted { color: var(--muted); }
  .hidden { display: none; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
  .foot { max-width: 1180px; margin: 0 auto; color: var(--muted); font-size: 12px; }
  .audit { font-size: 12px; }
  @media (max-width: 720px) {
    body { padding: 12px; }
    td.actions { white-space: normal; text-align: left; }
    td.actions button { margin: 4px 6px 0 0; }
  }
</style>
</head>
<body>

<section id="signin" class="card signin">
  <h1>WorkCrew admin</h1>
  <p class="sub">Sign in with your own WorkCrew account.</p>
  <form id="signin-form">
    <label>Email<input id="signin-email" type="email" autocomplete="username" required /></label>
    <label>Password<input id="signin-password" type="password" autocomplete="current-password" required /></label>
    <button id="signin-button" type="submit">Sign in</button>
  </form>
  <div id="signin-error" class="notice notice-error hidden"></div>
</section>

<main id="app" class="hidden">
  <section class="card">
    <div class="head">
      <div>
        <h1>Customers</h1>
        <p class="sub" id="summary">Loading...</p>
      </div>
      <button class="ghost" id="signout" type="button">Sign out</button>
    </div>
    <div class="row">
      <label class="grow">Search by email<input id="search" type="search" placeholder="name@example.com" /></label>
      <label>Show<select id="filter">
        <option value="all">Everyone</option>
        <option value="paid">Paying now</option>
        <option value="expiring">Expiring within 7 days</option>
        <option value="expired">Already lapsed</option>
        <option value="free">Free plan only</option>
      </select></label>
      <button class="ghost" id="refresh" type="button">Refresh</button>
    </div>
    <table>
      <thead>
        <tr><th>Email</th><th>Plan</th><th>Paid until</th><th>Days left</th><th>Used this month</th><th></th></tr>
      </thead>
      <tbody id="rows"><tr><td colspan="6" class="muted">Loading...</td></tr></tbody>
    </table>
    <div id="list-note" class="notice hidden"></div>
  </section>

  <section class="card">
    <h1>Add a customer</h1>
    <p class="sub">Creates the account and switches their access on. They can sign in straight away.</p>
    <form id="create-form">
      <div class="row">
        <label class="grow">Their email<input id="new-email" type="email" required /></label>
        <label class="grow">Password you give them<input id="new-password" type="text" minlength="10" required placeholder="At least 10 characters" /></label>
        <label>Plan<select id="new-plan"><option value="pro">Pro</option><option value="ultra">Ultra</option></select></label>
        <label>Months<input id="new-months" type="number" min="1" max="24" value="1" required /></label>
        <button id="create-button" type="submit">Create</button>
      </div>
    </form>
    <div id="create-note" class="notice hidden"></div>
  </section>

  <section class="card" id="card-test-card">
    <h1>Test a card payment</h1>
    <p class="sub">Opens the bank's payment page for your own account, using the test gateway. No real money moves, and your customers are unaffected.</p>
    <div class="row">
      <label>Plan<select id="pay-plan"><option value="pro">Pro</option><option value="ultra">Ultra</option></select></label>
      <label>Billing<select id="pay-interval"><option value="month">Monthly</option><option value="year">Yearly</option></select></label>
      <button id="pay-button" type="button">Open payment page</button>
    </div>
    <div id="pay-note" class="notice hidden"></div>
    <div class="row" style="margin-top:14px">
      <label class="grow">Link for someone outside the business (for example the bank's tester)<input id="link-label" type="text" placeholder="Bank of Beirut test" /></label>
      <button class="ghost" id="link-button" type="button">Create shareable link</button>
    </div>
    <div id="link-note" class="notice hidden"></div>
    <table class="audit" id="attempts-table">
      <thead><tr><th>When</th><th>Plan</th><th>Amount</th><th>Result</th></tr></thead>
      <tbody id="attempt-rows"><tr><td colspan="4" class="muted">No attempts yet.</td></tr></tbody>
    </table>
  </section>

  <section class="card">
    <h1>Recent activity</h1>
    <table class="audit">
      <thead><tr><th>When</th><th>Who</th><th>Did what</th><th>To</th></tr></thead>
      <tbody id="audit-rows"><tr><td colspan="4" class="muted">Loading...</td></tr></tbody>
    </table>
  </section>
</main>

<p class="foot">Access ends by itself on the paid-until date. Nothing has to be switched off by hand.</p>

<script>
(function () {
  // The access token lives only in this closure: not in localStorage, not in a
  // cookie, so closing the tab signs out and nothing is left on the machine.
  var token = "";
  var customers = [];

  var $ = function (id) { return document.getElementById(id); };

  function show(el, on) { el.classList.toggle("hidden", !on); }

  function note(el, message, ok) {
    el.textContent = message;
    el.className = "notice " + (ok ? "notice-ok" : "notice-error");
    show(el, Boolean(message));
  }

  function api(path, options) {
    options = options || {};
    var headers = { "authorization": "Bearer " + token };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var message = payload && payload.error ? payload.error : "That did not work. Please try again.";
          if (response.status === 404 && String(path).indexOf("/v1/admin") === 0) {
            message = "This account is not an admin.";
          }
          throw new Error(message);
        }
        return payload;
      });
    });
  }

  function formatDate(ms) {
    if (!ms) return "-";
    var d = new Date(ms);
    return d.getDate() + " " + d.toLocaleString("en", { month: "short" }) + " " + d.getFullYear();
  }

  // Microdollars are the ledger's unit: a millionth of a dollar, which the app
  // shows customers as one token. Here it reads as money, because what this
  // column is for is knowing what an account costs to serve.
  function money(microdollars) {
    return "$" + (Number(microdollars) / 1000000).toFixed(2);
  }

  function usageCell(row) {
    // Null means no allowance to be a share of (an account with no plan row),
    // which is a dash rather than a bar resting at zero.
    if (row.monthlyPercent === null || row.monthlyPercent === undefined) return '<span class="muted">-</span>';
    // Re-clamped here because this one goes into a style attribute rather than
    // into text, so it must be a number this page produced, not a string the
    // response happened to carry.
    var pct = Math.max(0, Math.min(100, Number(row.monthlyPercent) || 0));
    var tone = pct >= 90 ? "bar-hot" : pct >= 60 ? "bar-warm" : "bar-ok";
    return '<div class="usage">' +
      '<div class="usage-nums">' + escapeText(money(row.monthlySpentMicrodollars)) +
        ' <span class="muted">of ' + escapeText(money(row.monthlyLimitMicrodollars)) + "</span>" +
        '<span class="usage-pct">' + pct + "%</span></div>" +
      '<div class="bar"><span class="' + tone + '" style="width:' + pct + '%"></span></div>' +
    "</div>";
  }

  function planPill(row) {
    if (row.expired) return '<span class="pill pill-expired">Expired ' + escapeText(row.plan) + "</span>";
    if (!row.hasAccess) return '<span class="pill pill-free">Free</span>';
    var soon = row.daysLeft !== null && row.daysLeft <= 7;
    return '<span class="pill ' + (soon ? "pill-soon" : "pill-paid") + '">' + escapeText(row.plan) + "</span>";
  }

  // Every value from the API is inserted as text, never as markup.
  function escapeText(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function visibleRows() {
    var filter = $("filter").value;
    return customers.filter(function (row) {
      if (filter === "paid") return row.hasAccess;
      if (filter === "expired") return row.expired;
      if (filter === "free") return !row.hasAccess && !row.expired;
      if (filter === "expiring") return row.hasAccess && row.daysLeft !== null && row.daysLeft <= 7;
      return true;
    });
  }

  function renderRows() {
    var rows = visibleRows();
    var body = $("rows");
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="muted">Nobody here.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function (row) {
      var paid = row.hasAccess;
      return "<tr>" +
        "<td>" + escapeText(row.email) + "</td>" +
        "<td>" + planPill(row) + "</td>" +
        "<td>" + ((paid || row.expired) ? escapeText(formatDate(row.currentPeriodEndMs)) : '<span class="muted">-</span>') + "</td>" +
        "<td>" + (row.daysLeft === null ? '<span class="muted">-</span>' : escapeText(row.daysLeft)) + "</td>" +
        "<td>" + usageCell(row) + "</td>" +
        '<td class="actions">' +
          '<button class="ghost" data-act="grant" data-id="' + escapeText(row.userId) + '">Add month</button>' +
          '<button class="ghost" data-act="password" data-id="' + escapeText(row.userId) + '">Set password</button>' +
          ((paid || row.expired) ? '<button class="danger" data-act="revoke" data-id="' + escapeText(row.userId) + '">Revoke</button>' : "") +
        "</td>" +
      "</tr>";
    }).join("");
  }

  function loadCustomers() {
    var search = $("search").value.trim();
    var path = "/v1/admin/customers?limit=100" + (search ? "&search=" + encodeURIComponent(search) : "");
    return api(path).then(function (payload) {
      customers = payload.customers || [];
      var paying = customers.filter(function (r) { return r.hasAccess; }).length;
      var soon = customers.filter(function (r) { return r.hasAccess && r.daysLeft !== null && r.daysLeft <= 7; }).length;
      var lapsed = customers.filter(function (r) { return r.expired; }).length;
      // What the accounts on this page have run up so far in their current
      // month. Each account renews on its own date, so this is a running total
      // of live periods rather than one calendar month's bill.
      var spend = customers.reduce(function (total, r) { return total + (Number(r.monthlySpentMicrodollars) || 0); }, 0);
      $("summary").textContent =
        payload.total + " account" + (payload.total === 1 ? "" : "s") + ", " +
        paying + " paying, " + soon + " expiring within 7 days, " + lapsed + " already lapsed. " +
        "Using " + money(spend) + " of API this period.";
      renderRows();
      note($("list-note"), "", true);
    }).catch(function (error) {
      $("rows").innerHTML = '<tr><td colspan="6" class="muted">Could not load.</td></tr>';
      note($("list-note"), error.message, false);
    });
  }

  function loadActivity() {
    return api("/v1/admin/activity").then(function (payload) {
      var actions = payload.actions || [];
      $("audit-rows").innerHTML = actions.length === 0
        ? '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>'
        : actions.map(function (item) {
            return "<tr>" +
              "<td>" + escapeText(formatDate(item.createdAtMs)) + "</td>" +
              "<td>" + escapeText(item.actorEmail) + "</td>" +
              "<td>" + escapeText(String(item.action).replace(/_/g, " ")) +
                (item.detail ? ' <span class="muted">(' + escapeText(item.detail) + ")</span>" : "") + "</td>" +
              "<td>" + escapeText(item.targetEmail || "-") + "</td>" +
            "</tr>";
          }).join("");
    }).catch(function () {
      $("audit-rows").innerHTML = '<tr><td colspan="4" class="muted">Could not load.</td></tr>';
    });
  }

  // The gateway's own words for any refused payment. Without this the operator
  // sees only the generic error the backend shows users, which names no cause.
  function loadAttempts() {
    return api("/v1/admin/card-attempts").then(function (payload) {
      var attempts = payload.attempts || [];
      $("attempt-rows").innerHTML = attempts.length === 0
        ? '<tr><td colspan="4" class="muted">No attempts yet.</td></tr>'
        : attempts.map(function (a) {
            var ok = a.status === "paid";
            var result = ok
              ? '<span class="pill pill-paid">paid</span>'
              : '<span class="pill pill-expired">' + escapeText(a.status) + "</span>" +
                (a.failureReason ? ' <span class="muted">' + escapeText(a.failureReason) + "</span>" : "");
            return "<tr>" +
              "<td>" + escapeText(formatDate(a.createdAtMs)) + "</td>" +
              "<td>" + escapeText(a.plan + " " + a.interval) + "</td>" +
              "<td>$" + escapeText((a.amountCents / 100).toFixed(2)) + "</td>" +
              "<td>" + result + "</td>" +
            "</tr>";
          }).join("");
    }).catch(function () {
      $("attempt-rows").innerHTML = '<tr><td colspan="4" class="muted">Could not load.</td></tr>';
    });
  }

  function refreshAll() { return Promise.all([loadCustomers(), loadActivity(), loadAttempts()]); }

  $("signin-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var button = $("signin-button");
    button.disabled = true;
    note($("signin-error"), "", false);
    fetch("/v1/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: $("signin-email").value.trim(), password: $("signin-password").value })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok || !payload.session) throw new Error(payload.error || "Sign in failed.");
        return payload.session.accessToken;
      });
    }).then(function (accessToken) {
      token = accessToken;
      // Prove admin rights before revealing the dashboard, so a normal account
      // never sees an empty shell it cannot use.
      return api("/v1/admin/customers?limit=1");
    }).then(function () {
      $("signin-password").value = "";
      show($("signin"), false);
      show($("app"), true);
      return refreshAll();
    }).catch(function (error) {
      token = "";
      note($("signin-error"), error.message, false);
    }).finally(function () {
      button.disabled = false;
    });
  });

  $("signout").addEventListener("click", function () {
    token = "";
    customers = [];
    show($("app"), false);
    show($("signin"), true);
  });

  $("refresh").addEventListener("click", refreshAll);
  $("filter").addEventListener("change", renderRows);

  var searchTimer = 0;
  $("search").addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadCustomers, 250);
  });

  $("create-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var button = $("create-button");
    button.disabled = true;
    api("/v1/admin/customers", {
      method: "POST",
      body: {
        email: $("new-email").value.trim(),
        password: $("new-password").value,
        plan: $("new-plan").value,
        months: Number($("new-months").value)
      }
    }).then(function (payload) {
      note($("create-note"), "Created " + payload.email + ", paid until " + formatDate(payload.currentPeriodEndMs) + ".", true);
      $("new-email").value = "";
      $("new-password").value = "";
      $("new-months").value = "1";
      return refreshAll();
    }).catch(function (error) {
      note($("create-note"), error.message, false);
    }).finally(function () {
      button.disabled = false;
    });
  });

  $("pay-button").addEventListener("click", function () {
    var button = $("pay-button");
    button.disabled = true;
    note($("pay-note"), "Opening the bank's payment page...", true);
    api("/v1/billing/mpgs/checkout", {
      method: "POST",
      body: { plan: $("pay-plan").value, interval: $("pay-interval").value }
    }).then(function (payload) {
      // Opened in a new tab so the dashboard stays put; the payment happens on
      // the bank's own page and the plan is granted after it confirms.
      window.open(payload.url, "_blank");
      note($("pay-note"), "Payment page opened in a new tab. Pay with a test card, then come back and press Refresh.", true);
      return loadAttempts();
    }).catch(function (error) {
      note($("pay-note"), error.message, false);
      // Show the gateway's recorded reason even when the message itself is the
      // backend's generic one.
      return loadAttempts();
    }).finally(function () {
      button.disabled = false;
    });
  });

  // A link the bank's own tester can use with no account and no dashboard access.
  // Every visit starts a fresh payment, and none of them grant anyone a plan.
  $("link-button").addEventListener("click", function () {
    var button = $("link-button");
    button.disabled = true;
    api("/v1/admin/card-test-link", {
      method: "POST",
      body: {
        label: $("link-label").value.trim() || "Test link",
        plan: $("pay-plan").value,
        interval: $("pay-interval").value
      }
    }).then(function (link) {
      var until = formatDate(link.expiresAtMs);
      $("link-note").className = "notice notice-ok";
      $("link-note").innerHTML =
        "Send this link. It works without any login, can be used repeatedly, and grants nobody a plan.<br><br>" +
        "<code>" + escapeText(link.url) + "</code><br><br>Valid until " + escapeText(until) + ".";
      show($("link-note"), true);
      if (navigator.clipboard) navigator.clipboard.writeText(link.url).catch(function () {});
    }).catch(function (error) {
      note($("link-note"), error.message, false);
    }).finally(function () {
      button.disabled = false;
    });
  });

  $("rows").addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("button[data-act]") : null;
    if (!button) return;
    var id = button.getAttribute("data-id");
    var act = button.getAttribute("data-act");
    var row = customers.filter(function (item) { return item.userId === id; })[0];
    if (!row) return;

    if (act === "grant") {
      var months = window.prompt("How many months for " + row.email + "?", "1");
      if (months === null) return;
      var plan = (row.plan === "ultra" || row.plan === "pro") ? row.plan : "pro";
      plan = window.prompt("Which plan? Type pro or ultra.", plan);
      if (plan === null) return;
      button.disabled = true;
      api("/v1/admin/customers/" + id + "/grant", {
        method: "POST",
        body: { plan: String(plan).trim().toLowerCase(), months: Number(months) }
      }).then(refreshAll).catch(function (error) { note($("list-note"), error.message, false); })
        .finally(function () { button.disabled = false; });
      return;
    }

    if (act === "revoke") {
      if (!window.confirm("Remove paid access for " + row.email + "? They drop to the free plan and keep their account.")) return;
      button.disabled = true;
      api("/v1/admin/customers/" + id + "/revoke", { method: "POST" })
        .then(refreshAll).catch(function (error) { note($("list-note"), error.message, false); })
        .finally(function () { button.disabled = false; });
      return;
    }

    if (act === "password") {
      var password = window.prompt("New password for " + row.email + " (at least 10 characters). They will be signed out everywhere.");
      if (password === null) return;
      button.disabled = true;
      api("/v1/admin/customers/" + id + "/password", { method: "POST", body: { password: password } })
        .then(function () { note($("list-note"), "Password set for " + row.email + ".", true); return loadActivity(); })
        .catch(function (error) { note($("list-note"), error.message, false); })
        .finally(function () { button.disabled = false; });
    }
  });
})();
</script>
</body>
</html>`;
}
