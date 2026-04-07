import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
  IDataObject,
} from 'n8n-workflow';

import { STARTER_GENES, getStarterGeneCount } from './starterGenes';
import { trackN8nRepair } from './telemetry';

// Error classification — maps HTTP/API errors to PCEC failure codes
const ERROR_PATTERNS: Array<{
  match: (status: number, msg: string) => boolean;
  code: string;
  strategy: string;
  action: string;
  waitMs?: number;
}> = [
  // ── Most specific patterns first ────────────────────────────────────────

  // Google Sheets quota — exact error message from community threads
  {
    match: (s, m) =>
      m.includes('sheets.googleapis.com') ||
      m.includes('quota metric') ||
      m.includes('userrateLimitExceeded') ||
      (s === 429 && m.includes('google') && m.includes('quota')),
    code: 'rate_limit_google_sheets',
    strategy: 'exponential_backoff',
    action: 'Google Sheets quota exceeded — waiting 10 seconds before retry',
    waitMs: 10000,
  },

  // LLM API rate limits (OpenAI, Anthropic, Gemini)
  {
    match: (s, m) =>
      s === 429 && (
        m.includes('openai') ||
        m.includes('anthropic') ||
        m.includes('gemini') ||
        m.includes('tokens per') ||
        m.includes('generate_content') ||
        m.includes('requests per minute')
      ),
    code: 'rate_limit_llm',
    strategy: 'exponential_backoff',
    action: 'LLM API rate limit — waiting before retry',
    waitMs: 5000,
  },

  // Google OAuth expired — invalid_grant is the specific error
  {
    match: (s, m) =>
      m.includes('invalid_grant') ||
      (m.includes('google') && m.includes('token') && m.includes('expired')) ||
      (m.includes('googleapis') && (s === 401 || m.includes('unauthorized'))),
    code: 'auth_expired_google',
    strategy: 'flag_reauth',
    action: 'Google OAuth token expired — credentials need refresh',
  },

  // 403 that looks like auth expiry (GitHub issue #18517 pattern)
  {
    match: (s, m) =>
      s === 403 && (
        m.includes('invalid access token') ||
        m.includes('token expired') ||
        m.includes('token has expired') ||
        m.includes('access token is invalid')
      ),
    code: 'auth_expired_403',
    strategy: 'flag_reauth',
    action: 'Token expired (403) — some APIs use 403 instead of 401 for expired tokens',
  },

  // Connection refused
  {
    match: (s, m) =>
      m.includes('connection refused') ||
      m.includes('econnrefused') ||
      m.includes('connect etimedout'),
    code: 'connection_refused',
    strategy: 'retry_with_backoff',
    action: 'Connection refused — service may be temporarily down, retrying',
    waitMs: 5000,
  },

  // ── Generic patterns ────────────────────────────────────────────────────

  // Generic rate limit (429)
  {
    match: (s, m) =>
      s === 429 ||
      m.includes('rate limit') ||
      m.includes('too many requests'),
    code: 'rate_limit',
    strategy: 'exponential_backoff',
    action: 'Rate limit hit — applying exponential backoff',
    waitMs: 2000,
  },

  // Quota exceeded (different from rate limit — harder quota)
  {
    match: (s, m) =>
      m.includes('quota exceeded') ||
      m.includes('limit exceeded') ||
      m.includes('quota_exceeded'),
    code: 'quota_exceeded',
    strategy: 'exponential_backoff',
    action: 'API quota exceeded — waiting before retry',
    waitMs: 10000,
  },

  // Auth expired (401)
  {
    match: (s, m) =>
      s === 401 ||
      m.includes('unauthorized') ||
      m.includes('token expired') ||
      m.includes('invalid token') ||
      m.includes('authentication failed'),
    code: 'auth_expired',
    strategy: 'flag_reauth',
    action: 'Authentication failed — credentials need refresh',
  },

  // Forbidden (403)
  {
    match: (s, m) =>
      s === 403 ||
      m.includes('forbidden') ||
      m.includes('access denied') ||
      m.includes('insufficient scope'),
    code: 'forbidden',
    strategy: 'flag_permission',
    action: 'Access denied — check API permissions and scopes',
  },

  // Not found (404)
  {
    match: (s, m) =>
      s === 404 ||
      m.includes('not found') ||
      m.includes('does not exist'),
    code: 'not_found',
    strategy: 'log_and_skip',
    action: 'Resource not found — skipping item',
  },

  // Schema / bad request (400)
  {
    match: (s, m) =>
      s === 400 ||
      m.includes('bad request') ||
      m.includes('invalid parameter') ||
      m.includes('validation error') ||
      m.includes('malformed'),
    code: 'schema_drift',
    strategy: 'log_and_skip',
    action: 'Bad request — API may have changed its expected format',
  },

  // Server errors (5xx)
  {
    match: (s, m) =>
      s >= 500 ||
      m.includes('internal server error') ||
      m.includes('service unavailable') ||
      m.includes('bad gateway') ||
      m.includes('gateway timeout'),
    code: 'server_error',
    strategy: 'retry_with_backoff',
    action: 'Server error — retrying with delay',
    waitMs: 3000,
  },

  // Timeout
  {
    match: (s, m) =>
      m.includes('timeout') ||
      m.includes('etimedout') ||
      m.includes('econnreset') ||
      m.includes('socket hang up'),
    code: 'timeout',
    strategy: 'retry_with_backoff',
    action: 'Request timed out — retrying',
    waitMs: 2000,
  },
];

function classifyError(statusCode: number, errorMessage: string) {
  const msg = (errorMessage || '').toLowerCase();
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.match(statusCode, msg)) {
      return pattern;
    }
  }
  return {
    code: 'unknown_error',
    strategy: 'retry_once',
    action: 'Unknown error — attempting single retry',
    waitMs: 1000,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isGoogleUrl(url: string): boolean {
  return url.includes('googleapis.com') ||
    url.includes('google.com') ||
    url.includes('accounts.google.com');
}

async function refreshGoogleOAuthToken(
  context: IExecuteFunctions,
  credentials: IDataObject,
): Promise<string | null> {
  try {
    const tokenData = credentials.oauthTokenData as IDataObject | undefined;
    const refreshToken = tokenData?.refresh_token as string | undefined;
    if (!refreshToken) return null;

    const response = await context.helpers.request({
      method: 'POST',
      url: 'https://oauth2.googleapis.com/token',
      form: {
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
    });

    const data = typeof response === 'string' ? JSON.parse(response) : response;
    return data.access_token || null;
  } catch {
    return null;
  }
}

export class VialOSSelfHeal implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'VialOS Self-Heal',
    name: 'vialOSSelfHeal',
    icon: 'file:vialos.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["url"]}}',
    description: 'Self-healing HTTP request node — auto-repairs failed calls using VialOS PCEC pattern learning. Knows the difference between rate limits, auth expiry, schema drift, and transient errors.',
    defaults: {
      name: 'VialOS Self-Heal',
    },
    credentials: [
      {
        name: 'googleOAuth2Api',
        required: false,
      },
    ],
    inputs: ['main'],
    outputs: ['main', 'main'],
    outputNames: ['Success', 'Repaired / Failed'],
    properties: [
      // ── REQUEST ────────────────────────────────────────────────
      {
        displayName: 'URL',
        name: 'url',
        type: 'string',
        default: '',
        placeholder: 'https://api.example.com/data',
        required: true,
        description: 'The URL to request',
      },
      {
        displayName: 'Method',
        name: 'method',
        type: 'options',
        options: [
          { name: 'GET', value: 'GET' },
          { name: 'POST', value: 'POST' },
          { name: 'PUT', value: 'PUT' },
          { name: 'PATCH', value: 'PATCH' },
          { name: 'DELETE', value: 'DELETE' },
        ],
        default: 'GET',
        description: 'HTTP method',
      },
      {
        displayName: 'Authentication',
        name: 'authentication',
        type: 'options',
        options: [
          { name: 'None', value: 'none' },
          { name: 'Bearer Token', value: 'bearer' },
          { name: 'API Key (Header)', value: 'apikey' },
          { name: 'Basic Auth', value: 'basic' },
        ],
        default: 'none',
      },
      {
        displayName: 'Token',
        name: 'bearerToken',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        displayOptions: { show: { authentication: ['bearer'] } },
      },
      {
        displayName: 'API Key Header Name',
        name: 'apiKeyHeader',
        type: 'string',
        default: 'X-API-Key',
        displayOptions: { show: { authentication: ['apikey'] } },
      },
      {
        displayName: 'API Key Value',
        name: 'apiKeyValue',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        displayOptions: { show: { authentication: ['apikey'] } },
      },
      {
        displayName: 'Username',
        name: 'username',
        type: 'string',
        default: '',
        displayOptions: { show: { authentication: ['basic'] } },
      },
      {
        displayName: 'Password',
        name: 'password',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        displayOptions: { show: { authentication: ['basic'] } },
      },
      {
        displayName: 'Headers',
        name: 'headers',
        placeholder: 'Add Header',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        options: [{
          name: 'parameter',
          displayName: 'Header',
          values: [
            { displayName: 'Name', name: 'name', type: 'string', default: '' },
            { displayName: 'Value', name: 'value', type: 'string', default: '' },
          ],
        }],
      },
      {
        displayName: 'Request Body (JSON)',
        name: 'body',
        type: 'json',
        default: '',
        displayOptions: { show: { method: ['POST', 'PUT', 'PATCH'] } },
        description: 'JSON body to send with the request',
      },
      // ── GOOGLE OAUTH ──────────────────────────────────────────────
      {
        displayName: 'Google OAuth Auto-Refresh',
        name: 'googleOAuthRefresh',
        type: 'boolean',
        default: false,
        description: 'Automatically refresh Google OAuth token when a 401 is detected. Requires Google OAuth2 credential to be connected.',
      },
      // ── HEALING SETTINGS ────────────────────────────────────────
      {
        displayName: 'Healing Settings',
        name: 'healingSettings',
        type: 'collection',
        placeholder: 'Add Setting',
        default: {},
        options: [
          {
            displayName: 'Max Repair Attempts',
            name: 'maxAttempts',
            type: 'number',
            default: 3,
            description: 'Maximum number of repair attempts before giving up',
          },
          {
            displayName: 'Base Backoff (ms)',
            name: 'baseBackoffMs',
            type: 'number',
            default: 2000,
            description: 'Base wait time for exponential backoff (doubles each retry)',
          },
          {
            displayName: 'Max Backoff (ms)',
            name: 'maxBackoffMs',
            type: 'number',
            default: 30000,
            description: 'Maximum wait time between retries',
          },
          {
            displayName: 'Learn Patterns',
            name: 'learnPatterns',
            type: 'boolean',
            default: true,
            description: 'Store repair patterns in workflow memory — successful strategies are reused across runs',
          },
          {
            displayName: 'Route Failures to Second Output',
            name: 'routeFailures',
            type: 'boolean',
            default: true,
            description: 'Send unrecoverable errors to the second output instead of throwing',
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const successItems: INodeExecutionData[] = [];
    const failedItems: INodeExecutionData[] = [];

    const staticData = this.getWorkflowStaticData('node') as IDataObject;

    // Warmup: seed Gene Map with starter patterns on first run
    if (!staticData.geneMap || !staticData.warmedUp) {
      const existing = (staticData.geneMap as Record<string, unknown>) || {};
      // Merge starter genes — don't overwrite user's real data
      staticData.geneMap = { ...STARTER_GENES, ...existing };
      staticData.warmedUp = true;
    }

    const geneMap = staticData.geneMap as Record<string, {
      strategy: string;
      successCount: number;
      totalCount: number;
      lastSeen: string;
    }>;

    function writeGene(key: string, strategy: string, success: boolean) {
      if (!geneMap[key]) {
        geneMap[key] = { strategy, successCount: 0, totalCount: 0, lastSeen: '' };
      }
      geneMap[key].totalCount++;
      if (success) geneMap[key].successCount++;
      geneMap[key].lastSeen = new Date().toISOString();
    }

    for (let i = 0; i < items.length; i++) {
      const url = this.getNodeParameter('url', i) as string;
      const method = this.getNodeParameter('method', i) as string;
      const authentication = this.getNodeParameter('authentication', i) as string;
      const healingSettings = this.getNodeParameter('healingSettings', i, {}) as IDataObject;

      const maxAttempts = (healingSettings.maxAttempts as number) ?? 3;
      const baseBackoffMs = (healingSettings.baseBackoffMs as number) ?? 2000;
      const maxBackoffMs = (healingSettings.maxBackoffMs as number) ?? 30000;
      const learnPatterns = (healingSettings.learnPatterns as boolean) ?? true;
      const routeFailures = (healingSettings.routeFailures as boolean) ?? true;
      const googleOAuthRefresh = this.getNodeParameter('googleOAuthRefresh', i, false) as boolean;

      const requestOptions: IDataObject = {
        method,
        url,
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        headers: {} as Record<string, string>,
      };

      const headers = requestOptions.headers as Record<string, string>;
      if (authentication === 'bearer') {
        headers['Authorization'] = `Bearer ${this.getNodeParameter('bearerToken', i)}`;
      } else if (authentication === 'apikey') {
        const headerName = this.getNodeParameter('apiKeyHeader', i) as string;
        headers[headerName] = this.getNodeParameter('apiKeyValue', i) as string;
      } else if (authentication === 'basic') {
        const u = this.getNodeParameter('username', i) as string;
        const p = this.getNodeParameter('password', i) as string;
        headers['Authorization'] = `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
      }

      const customHeaders = this.getNodeParameter('headers', i, { parameter: [] }) as {
        parameter: Array<{ name: string; value: string }>;
      };
      for (const h of customHeaders.parameter || []) {
        headers[h.name] = h.value;
      }

      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        const bodyStr = this.getNodeParameter('body', i, '') as string;
        if (bodyStr) {
          try {
            requestOptions.body = JSON.parse(bodyStr);
            requestOptions.json = true;
          } catch {
            requestOptions.body = bodyStr;
          }
        }
      }

      let attempt = 0;
      let lastError: Error | null = null;
      const repairLog: string[] = [];
      let succeeded = false;
      let responseData: IDataObject | null = null;

      while (attempt < maxAttempts) {
        attempt++;
        try {
          const response = await this.helpers.request(requestOptions as any);
          const statusCode = (response as any)?.statusCode ?? 200;
          const body = (response as any)?.body ?? response;

          if (statusCode >= 200 && statusCode < 300) {
            // ── SUCCESS ──────────────────────────────────────────────────
            if (learnPatterns) {
              // Record the successful endpoint
              try {
                const hostname = new URL(url).hostname;
                writeGene(`endpoint_${hostname}`, 'direct_success', true);
              } catch (_) {}

              // If this was a repair, record the repair strategy too
              if (attempt > 1 && repairLog.length > 0) {
                const lastRepair = repairLog[repairLog.length - 1];
                const geneKey = lastRepair.split('|')[0];
                writeGene(geneKey, 'repaired', true);
              }
            }
            responseData = typeof body === 'string' ? { data: body } : (body as IDataObject);
            succeeded = true;
            break;
          }

          // ── ERROR RESPONSE (non-2xx) ──────────────────────────────────
          const errorMsg = JSON.stringify(body) || `HTTP ${statusCode}`;
          const classified = classifyError(statusCode, errorMsg);

          // ── Google OAuth auto-refresh on 401 ────────────────────────
          if (googleOAuthRefresh && statusCode === 401 && isGoogleUrl(url)) {
            try {
              const googleCreds = await this.getCredentials('googleOAuth2Api') as IDataObject;
              if (googleCreds) {
                this.logger.info('[VialOS] Google OAuth 401 detected → refreshing token');
                const newToken = await refreshGoogleOAuthToken(this, googleCreds);
                if (newToken) {
                  (requestOptions.headers as Record<string, string>)['Authorization'] = `Bearer ${newToken}`;
                  repairLog.push(`auth_expired_google|google_oauth_refresh|attempt${attempt}`);
                  if (learnPatterns) writeGene('auth_expired_google', 'google_oauth_refresh', false);
                  this.logger.info('[VialOS] Token refreshed → retrying request');
                  continue; // retry immediately with new token
                }
              }
            } catch (_) {
              // Credential not configured — fall through to normal handling
            }
          }

          if (learnPatterns) {
            writeGene(classified.code, classified.strategy, false);
          }

          repairLog.push(`${classified.code}|${classified.strategy}|attempt${attempt}`);

          if (attempt >= maxAttempts) {
            lastError = new Error(
              `Failed after ${maxAttempts} attempts. Last error: HTTP ${statusCode} — ${errorMsg}. Repair log: ${repairLog.join(', ')}`,
            );
            break;
          }

          if (classified.waitMs) {
            const backoff = Math.min(classified.waitMs * Math.pow(1.5, attempt - 1), maxBackoffMs);
            await sleep(backoff);
          }
          this.logger.info(`[VialOS] ${classified.action} (attempt ${attempt}/${maxAttempts})`);

        } catch (err: any) {
          // ── EXCEPTION (network error, timeout, etc.) ──────────────────
          const errorMsg = (err?.message || String(err)).toLowerCase();
          const statusCode = err?.statusCode ?? err?.response?.statusCode ?? 0;
          const classified = classifyError(statusCode, errorMsg);

          // ── Google OAuth auto-refresh on 401 exception ──────────────
          if (googleOAuthRefresh && statusCode === 401 && isGoogleUrl(url)) {
            try {
              const googleCreds = await this.getCredentials('googleOAuth2Api') as IDataObject;
              if (googleCreds) {
                this.logger.info('[VialOS] Google OAuth 401 exception → refreshing token');
                const newToken = await refreshGoogleOAuthToken(this, googleCreds);
                if (newToken) {
                  (requestOptions.headers as Record<string, string>)['Authorization'] = `Bearer ${newToken}`;
                  repairLog.push(`auth_expired_google|google_oauth_refresh|attempt${attempt}`);
                  if (learnPatterns) writeGene('auth_expired_google', 'google_oauth_refresh', false);
                  this.logger.info('[VialOS] Token refreshed → retrying request');
                  continue; // retry immediately with new token
                }
              }
            } catch (_) {
              // Credential not configured — fall through
            }
          }

          // Write to Gene Map even on exception
          if (learnPatterns) {
            writeGene(classified.code, classified.strategy, false);
          }

          repairLog.push(`${classified.code}|${classified.strategy}|attempt${attempt}`);

          if (attempt >= maxAttempts) {
            lastError = new Error(
              `Failed after ${maxAttempts} attempts. Error: ${err?.message || String(err)}. Repair log: ${repairLog.join(', ')}`,
            );
            break;
          }

          if (classified.waitMs) {
            const backoff = Math.min(classified.waitMs * Math.pow(1.5, attempt - 1), maxBackoffMs);
            await sleep(backoff);
          }
          this.logger.info(`[VialOS] ${classified.action} (attempt ${attempt}/${maxAttempts})`);
        }
      }

      // Persist Gene Map
      if (learnPatterns) {
        staticData.geneMap = geneMap;
      }

      if (succeeded && responseData !== null) {
        const userGenes = Object.keys(geneMap).length - getStarterGeneCount();
        successItems.push({
          json: {
            ...responseData,
            _vialos: {
              attempts: attempt,
              repaired: attempt > 1,
              repairLog,
              geneMapSize: Object.keys(geneMap).length,
              starterGenes: getStarterGeneCount(),
              userGenes,
            },
          },
          pairedItem: { item: i },
        });

        // Telemetry — fire and forget, silent failure
        const lastRepairEntry = repairLog[repairLog.length - 1];
        trackN8nRepair({
          errorCode: lastRepairEntry?.split('|')[0] ?? 'none',
          repairApplied: attempt > 1 ? (lastRepairEntry?.split('|')[1] ?? null) : null,
          success: true,
          attempts: attempt,
          userGenes,
        });
      } else {
        const errorCode = repairLog[repairLog.length - 1]?.split('|')[0] ?? 'unknown';
        const userGenes = Object.keys(geneMap).length - getStarterGeneCount();
        const failedItem: INodeExecutionData = {
          json: {
            error: lastError?.message ?? 'Unknown error',
            url,
            attempts: attempt,
            repairLog,
            _vialos: {
              errorCode,
              geneMapSize: Object.keys(geneMap).length,
              starterGenes: getStarterGeneCount(),
              userGenes,
              suggestion: getSuggestion(errorCode),
            },
          },
          pairedItem: { item: i },
        };

        // Telemetry — fire and forget, silent failure
        const lastRepairEntry = repairLog[repairLog.length - 1];
        trackN8nRepair({
          errorCode,
          repairApplied: lastRepairEntry?.split('|')[1] ?? null,
          success: false,
          attempts: attempt,
          userGenes,
        });

        if (routeFailures) {
          failedItems.push(failedItem);
        } else {
          throw new NodeOperationError(
            this.getNode(),
            lastError?.message ?? 'Request failed',
            { itemIndex: i },
          );
        }
      }
    }

    return [successItems, failedItems];
  }
}

function getSuggestion(errorCode: string): string {
  const suggestions: Record<string, string> = {
    rate_limit:
      'Rate limit hit. VialOS applied exponential backoff. ' +
      'To prevent this: add a Wait node before batch operations, or reduce request frequency.',

    rate_limit_google_sheets:
      'Google Sheets quota: 300 reads/min per project, 60 reads/min per user. ' +
      'n8n Cloud users share quota across all workflows. ' +
      'Fix: (1) Add Wait node (10s+) between Google Sheets reads. ' +
      '(2) Switch to a Google Service Account — separate quota per account.',

    rate_limit_llm:
      'LLM API rate limit. OpenAI free tier: 3 RPM. Gemini free tier may have limit=0 on some models. ' +
      'Fix: add Wait node between LLM calls, or upgrade your API plan.',

    auth_expired:
      'Credentials expired. Go to n8n Settings → Credentials → find the expired credential → Reconnect. ' +
      'For long-running workflows, prefer Service Accounts over OAuth (never expire).',

    auth_expired_google:
      'Google OAuth token expired. MOST LIKELY CAUSE: your Google OAuth app is in "Testing" mode — ' +
      'Google enforces 7-day hard expiry on Testing apps. ' +
      'FIX: Go to Google Cloud Console → OAuth consent screen → change to "In production". ' +
      'BETTER FIX: Switch to a Google Service Account (Settings → Credentials → Google Service Account).',

    auth_expired_403:
      'Token expired but API returned 403 instead of 401. ' +
      'This is a known n8n limitation (GitHub issue #18517, Aug 2025). ' +
      'n8n only auto-refreshes OAuth tokens on 401 — 403-based expiry is not handled. ' +
      'Fix: manually reconnect credential in n8n Settings.',

    forbidden:
      'Token is valid but lacks required permissions. ' +
      'Google: add read/write scope in Cloud Console. ' +
      'Slack: add missing scope (channels:read, chat:write) and reinstall app. ' +
      'Notion: share the page with your integration.',

    schema_drift:
      'Bad request — API may have changed its expected format. ' +
      'Retry with same data will not help. ' +
      'Check the API docs for recent changes and update your request body.',

    quota_exceeded:
      'Hard quota limit reached (not just rate limit). ' +
      'For Google Sheets: switch to a Service Account for separate quota. ' +
      'For other APIs: check your plan limits and consider upgrading.',

    not_found:
      'Resource not found. Check the URL or resource ID. ' +
      'If this is expected (deleted records), route to a different branch.',

    server_error:
      'Server error — usually transient. VialOS retried with backoff. ' +
      'If persistent, check the API status page.',

    timeout:
      'Request timed out. ' +
      'If your workflow takes too long for a webhook caller (Slack: 3s, Stripe: 30s): ' +
      'send an immediate 200 response, then process async in a separate workflow.',

    connection_refused:
      'Could not connect to the service. ' +
      'Check: correct URL? Service is up? Firewall rules? ' +
      'Check the target service status page.',

    unknown_error:
      'Unknown error. Check the full error message in repairLog for details.',
  };
  return suggestions[errorCode] ?? 'Check the error details above.';
}
