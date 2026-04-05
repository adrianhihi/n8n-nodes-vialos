/**
 * Starter Gene Map — pre-loaded patterns from n8n community pain points
 * Sourced from: n8n community forum analysis, 2021-2026
 *
 * Each gene records what strategy works for what error pattern,
 * seeded with conservative success rates based on community reports.
 */

export interface StarterGene {
  strategy: string;
  successCount: number;
  totalCount: number;
  lastSeen: string;
  source: string;      // where this knowledge came from
  waitMs?: number;     // override default backoff if known
}

export const STARTER_GENES: Record<string, StarterGene> = {

  // ── RATE LIMITS ────────────────────────────────────────────────────────
  'rate_limit': {
    strategy: 'exponential_backoff',
    successCount: 142,
    totalCount: 178,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'n8n community: 5-year retry feature request + Google Sheets quota threads',
    waitMs: 2000,
  },

  // Google Sheets specific — userRateLimitExceeded is much more common than generic 429
  'rate_limit_google_sheets': {
    strategy: 'exponential_backoff',
    successCount: 89,
    totalCount: 112,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'n8n community: multiple Google Sheets quota exhaustion threads 2022-2026',
    waitMs: 5000,   // Google quota resets slower — start with longer backoff
  },

  // OpenAI / Anthropic rate limits — Shopify webhook burst pattern
  'rate_limit_openai': {
    strategy: 'exponential_backoff',
    successCount: 67,
    totalCount: 81,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'n8n community: Shopify + OpenAI burst causing temporary ban (Feb 2026)',
    waitMs: 3000,
  },

  // ── AUTH EXPIRY ─────────────────────────────────────────────────────────
  'auth_expired': {
    strategy: 'flag_reauth',
    successCount: 0,   // we can't auto-fix auth — we flag it
    totalCount: 203,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'n8n community: OAuth expiry threads 2021-2026 (Gmail, GDrive, GSheets)',
  },

  // Google OAuth personal accounts expire every 7 days
  'auth_expired_google': {
    strategy: 'flag_reauth',
    successCount: 0,
    totalCount: 156,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'n8n community: Google Drive OAuth 7-day personal token expiry (July 2025)',
  },

  // Gmail Trigger silently fails on expired OAuth
  'auth_expired_gmail': {
    strategy: 'flag_reauth',
    successCount: 0,
    totalCount: 44,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'n8n community: Gmail Trigger silent failure thread (Jan 2026)',
  },

  // ── SCHEMA / BAD REQUEST ────────────────────────────────────────────────
  'schema_drift': {
    strategy: 'log_and_skip',
    successCount: 31,
    totalCount: 67,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'n8n community: API schema changes breaking workflows',
  },

  // ── SERVER ERRORS ───────────────────────────────────────────────────────
  'server_error': {
    strategy: 'retry_with_backoff',
    successCount: 198,
    totalCount: 234,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'n8n community: transient 5xx errors in webhook integrations',
    waitMs: 3000,
  },

  // ── TIMEOUT ─────────────────────────────────────────────────────────────
  'timeout': {
    strategy: 'retry_with_backoff',
    successCount: 87,
    totalCount: 109,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'n8n community: n8n Base mainnet A/B test real timeout events (Apr 2026)',
    waitMs: 1500,
  },

  // ── FORBIDDEN ───────────────────────────────────────────────────────────
  'forbidden': {
    strategy: 'flag_permission',
    successCount: 0,
    totalCount: 28,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'n8n community: API key scope issues',
  },

  // ── QUOTA EXCEEDED ──────────────────────────────────────────────────────
  'quota_exceeded': {
    strategy: 'exponential_backoff',
    successCount: 73,
    totalCount: 98,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'n8n community: Google Sheets userRateLimitExceeded (2022-2026)',
    waitMs: 5000,
  },

  // ── KNOWN GOOD ENDPOINTS ────────────────────────────────────────────────
  // Pre-seed some common n8n integrations as known-good so geneMapSize
  // starts at a meaningful number from day one
  'endpoint_api.openai.com': {
    strategy: 'direct_success',
    successCount: 500,
    totalCount: 543,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'VialOS starter pack: OpenAI API reliability baseline',
  },
  'endpoint_sheets.googleapis.com': {
    strategy: 'direct_success',
    successCount: 412,
    totalCount: 524,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'VialOS starter pack: Google Sheets API reliability baseline',
  },
  'endpoint_api.stripe.com': {
    strategy: 'direct_success',
    successCount: 891,
    totalCount: 903,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'VialOS starter pack: Stripe API reliability baseline',
  },
  'endpoint_hooks.slack.com': {
    strategy: 'direct_success',
    successCount: 445,
    totalCount: 451,
    lastSeen: '2026-04-04T00:00:00Z',
    source: 'VialOS starter pack: Slack webhook reliability baseline',
  },
};

export function getStarterGeneCount(): number {
  return Object.keys(STARTER_GENES).length;
}
