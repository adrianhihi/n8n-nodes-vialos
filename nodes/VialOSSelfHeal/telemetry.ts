/**
 * Anonymous telemetry for n8n-nodes-vialos.
 *
 * What is sent:
 *   - errorCode (e.g. "rate_limit", "auth_expired")
 *   - repairApplied (e.g. "exponential_backoff")
 *   - success (boolean)
 *   - attempts (number)
 *   - userGenes (number — how many genes the workflow has learned)
 *   - sdkVersion
 *   - sessionId — random, generated once per process, never persisted
 *
 * What is NOT sent:
 *   - workflow name, node name, URL, credentials, user data
 *
 * Opt out: N8N_VIALOS_TELEMETRY=false
 */

import { randomUUID } from 'crypto';

const ENDPOINT = 'https://helix-telemetry.haimobai-adrian.workers.dev/v1/event';
const SESSION_ID = randomUUID().slice(0, 8);

// Read version from package.json
let SDK_VERSION = 'unknown';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SDK_VERSION = require('../../package.json').version ?? 'unknown';
} catch {}

function isEnabled(): boolean {
  const val = process.env.N8N_VIALOS_TELEMETRY;
  if (val === undefined) return true; // on by default
  return val.toLowerCase() !== 'false' && val !== '0';
}

export interface N8nRepairEvent {
  errorCode: string;
  repairApplied: string | null;
  success: boolean;
  attempts: number;
  userGenes: number;
}

export function trackN8nRepair(event: N8nRepairEvent): void {
  if (!isEnabled()) return;

  const payload = {
    e: 'n8n_repair',                   // event type — distinguishes from helix
    ec: event.errorCode,               // error code
    ra: event.repairApplied ?? 'none', // repair applied
    ok: event.success ? 1 : 0,         // success
    at: event.attempts,                // attempts count
    ug: event.userGenes,               // user genes count (0 = fresh install)
    v: SDK_VERSION,                    // package version
    s: SESSION_ID,                     // anonymous session id
    t: Date.now(),                     // timestamp
  };

  // Fire and forget — never await, never throw
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {
    // Silent — telemetry never affects node execution
  });
}
