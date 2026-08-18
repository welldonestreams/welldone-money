# Hermes bridge contract

WellDone Money must receive live data through a same-origin, authenticated
server adapter. Browser JavaScript must never receive `PLAID_SECRET`, a Plaid
access token, the Hermes bridge read token, or a generic bridge request tool.

## Browser routes

The future private dashboard service may expose these owner-authenticated,
read-only routes to the browser:

- `GET /api/finance/summary`
- `GET /api/finance/accounts`
- `GET /api/finance/transactions`
- `GET /api/finance/recurring`
- `GET /api/finance/holdings`
- `GET /api/finance/liabilities`
- `GET /api/finance/status`

The server adapter adds the bridge read credential on the private network and
returns only sanitized JSON. It must not proxy arbitrary paths, methods, SQL,
admin operations, Item management, or Plaid requests.

## Required response metadata

Every response should preserve `data_as_of`, `last_successful_sync`,
`coverage_start`, `coverage_end`, `accounts_included`, and
`accounts_with_errors`. The dashboard must show stale, partial, and failed
states rather than silently treating missing data as zero.

## Normalized browser model

- Accounts: alias, institution, kind, optional last four, balances, as-of time.
- Transactions: date, merchant, normalized category, signed amount, account
  alias. Transfers remain distinguishable from income and spending.
- Recurring: name, category, cadence, next date, amount, inflow/outflow type.
- Holdings: account alias, ticker/name, value, optional cost basis, as-of time.
- Liabilities: alias, balance, optional minimum, due date, and reported APR.

Never return provider Item IDs, raw account IDs, raw webhook payloads, encrypted
token blobs, full account/routing numbers, phone numbers, or unbounded debug
objects.

## Deployment boundary

The public marketing page and Plaid webhook listener remain separate from this
private dashboard. Deploy the dashboard behind owner authentication on LAN or
Tailscale. Do not publish the read API, dashboard adapter, or bridge ports.
