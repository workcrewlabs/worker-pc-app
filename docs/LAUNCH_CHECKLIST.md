# WorkCrew Launch Checklist

## Business gate

1. Clear and register the WorkCrew name in target markets.
2. Confirm a company and bank account in a Stripe supported jurisdiction.
3. Approve prices, taxes, refunds, cancellation terms, and restricted uses.
4. Publish Terms, Privacy, Acceptable Use, Refund, Security, and Subprocessor documents.

## Production services

1. Configure Supabase Auth, email verification, password recovery, and redirect URLs.
2. Configure the remote database, migrations, backups, and restore test.
3. Create four Stripe prices and configure Checkout and Customer Portal.
4. Register the Stripe webhook and verify all required event scenarios.
5. Configure the Anthropic production key, spending alerts, and usage reconciliation.
6. Configure transactional email, monitoring, alerts, and a public status page.
7. Configure the API host, HTTPS, firewall rules, and secret manager.

## Release gate

1. Complete unit, integration, desktop, and Windows virtual machine tests.
2. Verify the hard paywall for every inactive subscription state.
3. Run concurrent budget tests against both plan limits.
4. Complete a security review and dependency audit.
5. Sign the installer and update packages.
6. Verify install, update, rollback, and uninstall on clean Windows machines.
7. Complete a limited paid beta before public release.
