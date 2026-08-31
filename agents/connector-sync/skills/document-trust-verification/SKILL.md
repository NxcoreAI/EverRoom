---
name: document-trust-verification
description: Verify the authenticity of a source document during connector synchronization using the Stipple API. Use when a document record should carry a trust signal (risk band + warrant) before it enters a Context Room — e.g. uploaded PDFs, contracts, invoices, or any document whose origin matters.
---

# Document Trust Verification

The connector pipeline treats source data as untrusted input (see SYSTEM.md rule 1). For
**documents whose authenticity matters** — contracts, invoices, certificates, policies —
normalize-and-write alone can't distinguish a genuine document from a tampered or
AI-generated fake. This skill adds an optional verification step using the
[Stipple](https://github.com/Sketchjar/stipple-mcp) hosted API (free anonymous tier, no API
key; `STIPPLE_API_KEY` env for teams with volume).

## When to run

- The resourceType is `document` AND the record carries an original file (PDF/image), not
  just extracted text, AND the user (or room config) opted into source verification.
- Never run for records without a retrievable original file — text-only records cannot be
  forensically inspected.

## How

POST the original file to Stipple (multipart upload). Two calls, both optional in output:

1. `POST https://www.stipple.sh/v1/warrants` — forensic authenticity:
   `{ risk_band: "low"|"medium"|"high", risk_score, inspection_quality, recommended_action, summary, warrant_id }`
2. `POST https://www.stipple.sh/v1/detect-ai-text` — AI-written-prose probability:
   `{ applicable, probability, lean, tells }` (abstains with `applicable: false` on non-prose)

Multipart form field name: `file`. Timeout: 300s. Both calls are **best-effort**: if the
API is unreachable, omit the verification block and write the record normally — an outage
must never block synchronization.

## Where the verdict goes

Attach to the document record's `extensionPayload` (schema stays forward-compatible):

```json
{
  "sourceRecordId": "string",
  "documentId": "string",
  "title": "string",
  "bodyText": "string",
  "extensionPayload": {
    "document_verification": {
      "authenticity": { "warrant_id": "warrant_...", "risk_band": "low", "inspection_quality": "thorough" },
      "ai_text": { "applicable": false }
    }
  }
}
```

`warrant_id` is a stable, re-verifiable handle — Stipple caches by content hash, so
re-checking the same file is free.

## Policy

- **Advisory (default)**: attach the verdict, write the record regardless of band.
- **Enforcing (opt-in per room)**: records with `risk_band: high` go to `sync_quarantine`
  instead of `sync_write_batch`, with the warrant id in the quarantine reason — consistent
  with SYSTEM.md's rule that unreliable mappings are quarantined, not guessed.

## Why this matters

A tampered contract or an AI-generated fake policy normalizes into a perfect document
record — title, owner, timestamp all plausible. Retrieval on it returns confidently wrong
context for every future query in the room. Verification at sync time is the last point
where the *original file* is still available for forensic inspection.
