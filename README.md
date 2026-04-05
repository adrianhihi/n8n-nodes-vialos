# n8n-nodes-vialos

Self-healing HTTP/API node for n8n — auto-repairs failed requests using VialOS PCEC pattern learning.

Unlike the built-in HTTP Request node that fails or blindly retries, VialOS Self-Heal:

- **Knows the difference** between rate limits, auth expiry, schema drift, timeouts, and server errors
- **Applies targeted repairs** — exponential backoff for 429, credential check for 401, delay for 5xx
- **Learns across workflow runs** — successful repair strategies are stored in Gene Map and reused
- **Routes failures** — unrecoverable errors go to a second output, not throw exceptions

## Installation

In your n8n instance: **Settings → Community Nodes → Install → `n8n-nodes-vialos`**

> Note: Only available on self-hosted n8n. Not available on n8n Cloud.

## Usage

1. Add **VialOS Self-Heal** node to your workflow
2. Configure URL, method, and authentication
3. Connect the **Success** output to your next node
4. Optionally connect the **Repaired / Failed** output to handle errors gracefully

## Error Patterns Handled

| Error | Code | Strategy |
|-------|------|----------|
| 429 Too Many Requests | `rate_limit` | Exponential backoff |
| 401 Unauthorized | `auth_expired` | Flag for re-auth |
| 400 Bad Request | `schema_drift` | Log + skip |
| 403 Forbidden | `forbidden` | Flag permissions |
| 404 Not Found | `not_found` | Log + skip |
| 500–504 Server Error | `server_error` | Retry with backoff |
| Timeout / Reset | `timeout` | Retry with backoff |
| Quota Exceeded | `quota_exceeded` | Long backoff |

## Gene Map — Learning Across Runs

The node stores successful repair strategies in n8n's workflow static data.
When the same error occurs again, it applies the known-good strategy immediately.

This is VialOS's core insight: **errors in your workflows aren't random — they follow patterns.
Learning from them makes every subsequent run more reliable.**

## Links

- [VialOS Runtime](https://github.com/adrianhihi/vialos-runtime)
- [Helix — VialOS for payments](https://github.com/adrianhihi/helix-sdk)
- [VialOS Showcase](https://vialos.dev)
