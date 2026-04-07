# n8n-nodes-vialos

[![npm](https://img.shields.io/npm/v/n8n-nodes-vialos?color=cb3837)](https://www.npmjs.com/package/n8n-nodes-vialos)
[![downloads](https://img.shields.io/npm/dw/n8n-nodes-vialos?color=blue)](https://www.npmjs.com/package/n8n-nodes-vialos)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Self-healing HTTP/API node for n8n — knows the difference between a rate
limit, an expired token, a schema change, and a server hiccup. Applies the
right fix for each, routes failures to a second output, and learns from every
repair across workflow runs.

## Why not just use "Retry on Fail"?

n8n's built-in retry retries everything the same way. That works for transient
errors, but creates problems for others:

| Error | Built-in Retry | VialOS Self-Heal |
|-------|---------------|-----------------|
| 429 Rate limit | Instant retry → gets you banned longer | Exponential backoff (2s → 3s → 4.5s) |
| Google Sheets quota | Keeps retrying → quota never resets | Waits 10s+ before retry |
| 401 OAuth expired | Retries forever, always fails | Flags for re-auth, routes to second output |
| Google `invalid_grant` | Retries forever, always fails | Explains the 7-day Testing mode issue |
| 403 token expired | n8n never auto-refreshes these | Flags with GitHub issue #18517 context |
| 500 Server error | Same fixed delay every time | Exponential backoff, up to max |
| 400 Schema drift | Retries broken payload | Logs and skips — retry won't help |

## Installation

**Settings → Community Nodes → Install → `n8n-nodes-vialos`**

> Self-hosted n8n only. Not available on n8n Cloud (community node restriction).

## Usage

1. Add **VialOS Self-Heal** to your workflow instead of HTTP Request
2. Configure URL, method, and authentication
3. Connect **Success** output to your next step
4. Connect **Repaired / Failed** output to handle errors gracefully
   (Slack alert, error log, or just ignore)

## Two outputs

```
VialOS Self-Heal
├── Success          → response data + _vialos metadata
└── Repaired / Failed → error details + suggestion + repairLog
```

Unrecoverable errors (auth expiry, schema drift, not found) go to the second
output with a specific explanation and fix instructions — not a generic error.

## Gene Map — learns across runs

Every repair is stored in n8n's workflow static data and reused on the next
run. Error patterns are pre-loaded from real n8n community pain points so
you get intelligent handling from day one.

```json
"_vialos": {
  "attempts": 3,
  "repaired": false,
  "errorCode": "rate_limit_google_sheets",
  "geneMapSize": 12,
  "starterGenes": 11,
  "userGenes": 1,
  "suggestion": "Google Sheets quota: 300 reads/min per project..."
}
```

`userGenes` grows as your workflows run — that's the Gene Map learning.

## Error patterns handled

| Code | Trigger | Strategy | Wait |
|------|---------|----------|------|
| `rate_limit` | HTTP 429, "too many requests" | Exponential backoff | 2s base |
| `rate_limit_google_sheets` | `sheets.googleapis.com` quota | Exponential backoff | 10s base |
| `rate_limit_llm` | OpenAI / Gemini / Anthropic 429 | Exponential backoff | 5s base |
| `auth_expired` | HTTP 401, "unauthorized" | Flag for re-auth | — |
| `auth_expired_google` | `invalid_grant`, Google 401 | Flag + explain Testing mode | — |
| `auth_expired_403` | 403 + "token expired" message | Flag (GitHub issue #18517) | — |
| `forbidden` | HTTP 403, "access denied" | Flag permissions | — |
| `schema_drift` | HTTP 400, "bad request" | Log and skip | — |
| `not_found` | HTTP 404 | Log and skip | — |
| `server_error` | HTTP 5xx | Retry with backoff | 3s base |
| `timeout` | Network timeout, ECONNRESET | Retry with backoff | 2s base |
| `connection_refused` | ECONNREFUSED | Retry with backoff | 5s base |
| `quota_exceeded` | "quota exceeded" message | Exponential backoff | 10s base |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Max Repair Attempts | 3 | Times to retry before routing to second output |
| Base Backoff (ms) | 2000 | Starting wait for exponential backoff |
| Max Backoff (ms) | 30000 | Maximum wait between retries |
| Learn Patterns | true | Store repairs in Gene Map across runs |
| Route Failures to Second Output | true | Send failures to output 2 instead of throwing |

## Authentication supported

- None
- Bearer Token
- API Key (header)
- Basic Auth

## Google OAuth Auto-Refresh

When wrapping Google API calls (Sheets, Gmail, Drive, Calendar), enable
**Google OAuth Auto-Refresh** in the node settings and connect your
Google OAuth2 credential.

When a 401 is detected from a Google API:
1. The node automatically requests a new access token using your refresh token
2. Retries the original request with the new token
3. Stores the repair pattern in Gene Map (`google_oauth_refresh` strategy)

**Setup:**
1. Add the VialOS Self-Heal node to your workflow
2. Toggle "Google OAuth Auto-Refresh" to ON
3. Select your Google OAuth2 credential
4. Done — token refresh happens automatically from now on

## Starter Gene Map

Pre-loaded with 11 patterns from real n8n community reports (2021–2026):

- **Google Sheets quota** — 8+ community threads, 2022–2026
- **Google `invalid_grant`** — "#1 most reported token issue 2025-26"
- **OAuth 403 vs 401 mismatch** — GitHub issue #18517 (Aug 2025)
- **LLM rate limits** — OpenAI burst (Feb 2026), Gemini quota (Mar 2026)
- Plus: server_error, timeout, connection_refused, forbidden, schema_drift

All counts start at 0 — real data accumulates from your actual workflows.

## VialOS ecosystem

- [@vial-agent/runtime](https://github.com/adrianhihi/vialos-runtime) — core runtime
- [@helix-agent/core](https://github.com/adrianhihi/helix-sdk) — payment reliability
- **n8n-nodes-vialos** — this package

## Links

- [GitHub](https://github.com/adrianhihi/n8n-nodes-vialos)
- [npm](https://www.npmjs.com/package/n8n-nodes-vialos)
- [VialOS](https://vialos.dev)
- [Report an issue](https://github.com/adrianhihi/n8n-nodes-vialos/issues)
