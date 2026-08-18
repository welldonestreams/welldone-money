# Data model

Finance Hub persists local preferences in one versioned browser document. The
authenticated adapter separately stores renewals, private card selections, and
normalized statement backfills in its private data mount.

## Account

- `id`: stable local identifier.
- `name`: user-facing alias.
- `institution`: issuer or custodian.
- `kind`: `checking`, `savings`, `credit`, `investment`, or `other`.
- `last4`: legacy field name for an optional 4- or 5-digit masked account
  suffix used only for import matching.
- `currentBalance`: explicit snapshot, not a calculated ledger balance.
- `balanceAsOf`: date of that snapshot.
- `statementBalance`, `minimumDue`, `dueDate`, `annualFee`, `pointsBalance`:
  optional card fields.

## Transaction

- `id`: FITID when available; otherwise a deterministic fingerprint. Repeated
  IDs inside one issuer file receive deterministic occurrence suffixes so
  offsetting credits and genuine identical purchases are retained.
- `accountId`, `date`, `payee`, `notes`, `category`, `amount`, `cleared`.
- `sourceType`, `sourceFile`, `fitid`, `importedAt`.

Amounts use Actual's convention: inflows are positive and outflows are
negative. Credit-card purchases are therefore negative.

## Benefit

- `id`, `accountId`, `name`, `amount`, `cadence`.
- `periodStart`, `periodEnd`, `usedAmount`, `manualUsedAmount`,
  `detectedUsedAmount`, `detectionCount`, `lastDetectedAt`,
  `lastObservedCreditAt`, `lastObservedCreditAmount`, `enrollmentRequired`,
  `enrolled`.
- `sourceUrl`, `notes`.

Cadence supports monthly, quarterly, semiannual, annual, cardmember-year, and
multi-year benefits. Supported catalog benefits derive usage only from posted,
explicit issuer-credit transactions on the same account and within the current
benefit period. Eligible purchases do not imply usage. A manual amount acts as
an override; it is not added to the detected amount, which prevents double
counting.

## Import audit

Each import records a SHA-256 file hash, filename, type, timestamp, confirmed
account mapping, evidence score, accepted count, duplicate count, and rejected
count. The private adapter stores normalized accepted transactions and a stable
statement-source mapping. Cards not connected through Plaid can use durable
statement-only account aliases in the same private store. Raw file contents are
never persisted or uploaded.

Schema version 4 adds `importMappings` and `importRevision` to the browser
projection. Plaid account projections use deterministic identifiers derived
from sanitized account metadata rather than array positions.

## Live dashboard projections

Schema version 3 adds optional `recurring`, `holdings`, `liabilities`, and
`sync` collections. They are projections of sanitized bridge responses, never
Plaid objects. Provider IDs, raw payloads, access tokens, routing numbers, and
full account numbers do not belong in browser state.

When no private data exists, the UI may render fictional preview data from
`src/demo.js`. Preview data is never persisted and is always visibly labeled.

## Private finance overlays

The authenticated adapter may project owner-only investment statements and
income-classification rules from `private-finance.json` in its private data
mount. The repository contains only the generic reader and UI. Real balances,
fund positions, statement history, and owner-specific match phrases never
belong in Git.

Investment history is statement-backed: short ranges remain explicitly
unavailable until enough dated observations exist. A transfer is promoted to
income only when a private positive-amount rule matches; ordinary transfers
stay excluded and credit-card refunds reduce spending instead of becoming
income.
