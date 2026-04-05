/**
 * VialOS Starter Gene Map v2
 *
 * Patterns sourced from real n8n community pain points (2021–2026).
 * successCount and totalCount start at 0 — we don't fabricate history.
 * These genes provide STRATEGY knowledge, not fabricated success rates.
 * Real counts will accumulate as users run actual workflows.
 *
 * Sources:
 *  - n8n community forum analysis (8+ Google Sheets quota threads, 2022–2026)
 *  - n8n GitHub issue #18517: OAuth2 403 vs 401 mismatch (Aug 2025)
 *  - flowgenius.in: "most reported token issue 2025-26" (invalid_grant)
 *  - n8n community: retry behavior forum threads (2021–2025)
 */

export interface StarterGene {
  strategy: string;
  successCount: number;
  totalCount: number;
  lastSeen: string;
  source: string;
  waitMs?: number;
  notes?: string;
}

export const STARTER_GENES: Record<string, StarterGene> = {

  // ── RATE LIMITS ─────────────��───────────────────────────────────────────

  'rate_limit': {
    strategy: 'exponential_backoff',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'n8n community: retry feature request thread (2021, still active 2025)',
    waitMs: 2000,
    notes: 'Generic 429. Exponential backoff: 2s → 3s → 4.5s. Works for most APIs.',
  },

  // Google Sheets: "Quota exceeded for quota metric Read requests per minute per user"
  // This is the #1 most reported error across all n8n Google Sheets threads 2022-2026
  // The error message contains "sheets.googleapis.com" and "quota metric"
  'rate_limit_google_sheets': {
    strategy: 'exponential_backoff',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'n8n community: 8+ threads on Google Sheets quota errors, 2022–2026. ' +
      'Including: "Do n8n.cloud users share Google Sheets quota?" (Jan 2025), ' +
      '"Quota overflow problem with Google Sheets API" (Feb 2024)',
    waitMs: 10000,
    notes: 'Google Sheets Read quota: 300 reads/min per project, 60 reads/min per user. ' +
      'n8n Cloud users share quota across instances. ' +
      'Fix: add Wait node (10s+) between batch operations, or use service account.',
  },

  // OpenAI/Anthropic/Gemini rate limits
  // Gemini 3.1 Pro free tier quota: March 2026 thread
  // OpenAI: Shopify webhook burst causing temp ban (Feb 2026 thread)
  'rate_limit_llm': {
    strategy: 'exponential_backoff',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'n8n community: Shopify + OpenAI burst causing temp ban (Feb 2026). ' +
      'Gemini 3.1 Pro free tier quota exceeded (Mar 2026)',
    waitMs: 5000,
    notes: 'LLM APIs have per-minute token limits. ' +
      'OpenAI free tier: 3 RPM. Gemini free tier: limit = 0 on some models. ' +
      'Upgrade tier or add Wait node between LLM calls.',
  },

  // ── AUTH EXPIRY ────────────���────────────────────────────────────────────

  // Google OAuth invalid_grant — "#1 most reported token issue 2025-26"
  // Cause: Google Testing mode enforces 7-day hard expiry on refresh tokens
  // Error: "invalid_grant: Token has been expired or revoked"
  'auth_expired_google': {
    strategy: 'flag_reauth',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'flowgenius.in: "#1 most reported token issue in n8n community 2025-26". ' +
      'n8n community: Gmail Trigger silent failure (Jan 2026). ' +
      'Google Drive OAuth 7-day expiry (Jul 2025 thread)',
    notes: 'CAUSE: Google OAuth app in "Testing" mode → refresh tokens expire every 7 days. ' +
      'FIX 1: Publish your OAuth app (Google Cloud Console → OAuth consent → In production). ' +
      'FIX 2: Use a Google Service Account instead (never expires). ' +
      'ERROR MESSAGES: "invalid_grant", "Token has been expired or revoked"',
  },

  // Generic auth expiry (non-Google)
  'auth_expired': {
    strategy: 'flag_reauth',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'n8n community: OAuth expiry threads 2021–2026. ' +
      'n8n troubleshooting guides: 401 is most common integration error',
    notes: 'Cannot auto-fix auth expiry — credentials must be renewed by user. ' +
      'Flagging for manual re-auth. ' +
      'n8n path: Settings → Credentials → [find expired credential] → Reconnect',
  },

  // GitHub issue #18517 (Aug 2025): Some APIs return 403 for expired tokens
  // "n8n only refreshes tokens on 401 errors" — affects Avito, Microsoft Fabric, others
  'auth_expired_403': {
    strategy: 'flag_reauth',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'n8n GitHub issue #18517 (Aug 2025): OAuth2 403 vs 401 mismatch. ' +
      'Affects APIs that return 403+message instead of standard 401 for token expiry.',
    notes: 'CAUSE: n8n only auto-refreshes OAuth tokens on 401. ' +
      'Some APIs (Avito, Microsoft Fabric) return 403 for expired tokens. ' +
      'n8n never auto-refreshes these → workflow fails after token lifetime. ' +
      'FIX: Manually reconnect credential in n8n Settings.',
  },

  // ── SERVER ERRORS ──────────────��────────────────────────────────────────

  // Transient 5xx — most common cause is deployment/restart of target service
  'server_error': {
    strategy: 'retry_with_backoff',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'n8n community: transient 5xx in webhook integrations. ' +
      'n8n docs: "Retry on Fail" recommended for external API calls',
    waitMs: 3000,
    notes: 'Transient server errors usually resolve within 1-2 retries. ' +
      'If persistent, check the target API status page. ' +
      'n8n built-in retry uses fixed delay — VialOS uses exponential backoff.',
  },

  // ── TIMEOUT ─────────────────────────────────────────────────────────────

  // Webhook timeout: Slack requires 3s, most services 30s
  // n8n Cloud instance timeout (Aug 2025 thread)
  'timeout': {
    strategy: 'retry_with_backoff',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'n8n community: webhook timeout threads. ' +
      'n8n troubleshooting: EXECUTIONS_PROCESS_TIMEOUT env var for long workflows',
    waitMs: 2000,
    notes: 'Network timeouts are usually transient — retry with short delay. ' +
      'If workflow is too slow for webhook caller (Slack: 3s, Stripe: 30s): ' +
      'use immediate 200 response + async processing pattern.',
  },

  // ── SCHEMA / BAD REQUEST ────────────────────────────────────────────────

  'schema_drift': {
    strategy: 'log_and_skip',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'n8n community: "API changes its rules" — common integration problem',
    notes: 'API changed request format — retry with same data will not help. ' +
      'Log the error and route to Repaired/Failed output. ' +
      'User needs to update workflow to match new API schema.',
  },

  // ── FORBIDDEN ─────────────────────────────────────────────────���─────────

  'forbidden': {
    strategy: 'flag_permission',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'n8n troubleshooting: "403 means token valid but lacks access" (2025)',
    notes: 'Token is valid but lacks required scope or permission. ' +
      'For Google: add read/write scope in Cloud Console. ' +
      'For Slack: add channels:read or chat:write scope, then reinstall app. ' +
      'For Notion: share the page with the integration.',
  },

  // ── QUOTA EXCEEDED ─────────────────��────────────────────────────────────

  'quota_exceeded': {
    strategy: 'exponential_backoff',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'n8n community: Google Sheets "userRateLimitExceeded" threads (2022–2026)',
    waitMs: 10000,
    notes: 'Hard quota limits (not just rate limits) — longer backoff needed. ' +
      'Google Sheets: 300 reads/min/project. ' +
      'Consider batching operations or switching to Google Service Account.',
  },

  // ── NOT FOUND ───────────────────────────────────────────────────��───────

  'not_found': {
    strategy: 'log_and_skip',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'General HTTP best practices',
    notes: 'Resource does not exist — retry will not help. ' +
      'Check URL, resource ID, or whether resource was deleted.',
  },

  // ── CONNECTION REFUSED ────────────────��─────────────────────────────────

  'connection_refused': {
    strategy: 'retry_with_backoff',
    successCount: 0,
    totalCount: 0,
    lastSeen: '',
    source: 'n8n troubleshooting: "Connection refused" — service unreachable',
    waitMs: 5000,
    notes: 'Service is not reachable. Could be: service down, wrong URL, firewall. ' +
      'Retry a few times — if persistent, check service status page.',
  },

};

export function getStarterGeneCount(): number {
  return Object.keys(STARTER_GENES).length;
}

export function getStarterGeneKeys(): string[] {
  return Object.keys(STARTER_GENES);
}
