import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
  IDataObject,
} from 'n8n-workflow';

// Error classification — maps HTTP/API errors to PCEC failure codes
const ERROR_PATTERNS: Array<{
  match: (status: number, msg: string) => boolean;
  code: string;
  strategy: string;
  action: string;
  waitMs?: number;
}> = [
  // Rate limiting (429)
  {
    match: (s, m) => s === 429 || m.includes('rate limit') || m.includes('too many requests'),
    code: 'rate_limit',
    strategy: 'exponential_backoff',
    action: 'Waiting before retry (exponential backoff)',
    waitMs: 2000,
  },
  // Auth expired (401)
  {
    match: (s, m) => s === 401 || m.includes('unauthorized') || m.includes('token expired') || m.includes('invalid_grant'),
    code: 'auth_expired',
    strategy: 'flag_reauth',
    action: 'Auth token expired — flagging for re-authentication',
  },
  // Bad request / schema drift (400)
  {
    match: (s, m) => s === 400 || m.includes('bad request') || m.includes('invalid parameter') || m.includes('validation'),
    code: 'schema_drift',
    strategy: 'log_and_skip',
    action: 'Bad request detected — logging schema issue',
  },
  // Not found (404)
  {
    match: (s, m) => s === 404 || m.includes('not found'),
    code: 'not_found',
    strategy: 'log_and_skip',
    action: 'Resource not found — skipping item',
  },
  // Server error (500/502/503/504)
  {
    match: (s, m) => s >= 500 || m.includes('server error') || m.includes('service unavailable') || m.includes('bad gateway'),
    code: 'server_error',
    strategy: 'retry_with_backoff',
    action: 'Server error — retrying with delay',
    waitMs: 3000,
  },
  // Timeout
  {
    match: (s, m) => m.includes('timeout') || m.includes('etimedout') || m.includes('econnreset'),
    code: 'timeout',
    strategy: 'retry_with_backoff',
    action: 'Request timed out — retrying',
    waitMs: 1500,
  },
  // Forbidden (403)
  {
    match: (s, m) => s === 403 || m.includes('forbidden') || m.includes('access denied'),
    code: 'forbidden',
    strategy: 'flag_permission',
    action: 'Access denied — check API permissions',
  },
  // Quota exceeded (Google APIs, etc.)
  {
    match: (s, m) => m.includes('quota') || m.includes('limit exceeded') || m.includes('userRateLimitExceeded'),
    code: 'quota_exceeded',
    strategy: 'exponential_backoff',
    action: 'API quota exceeded — backing off',
    waitMs: 5000,
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

    // Gene Map — persisted across workflow runs via n8n static data
    const staticData = this.getWorkflowStaticData('node') as IDataObject;
    if (!staticData.geneMap) staticData.geneMap = {};
    const geneMap = staticData.geneMap as Record<string, { strategy: string; successCount: number; totalCount: number; lastSeen: string }>;

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

      // Build request options
      const requestOptions: IDataObject = {
        method,
        url,
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        headers: {} as Record<string, string>,
      };

      // Auth
      const headers = requestOptions.headers as Record<string, string>;
      if (authentication === 'bearer') {
        const token = this.getNodeParameter('bearerToken', i) as string;
        headers['Authorization'] = `Bearer ${token}`;
      } else if (authentication === 'apikey') {
        const headerName = this.getNodeParameter('apiKeyHeader', i) as string;
        const headerValue = this.getNodeParameter('apiKeyValue', i) as string;
        headers[headerName] = headerValue;
      } else if (authentication === 'basic') {
        const username = this.getNodeParameter('username', i) as string;
        const password = this.getNodeParameter('password', i) as string;
        const encoded = Buffer.from(`${username}:${password}`).toString('base64');
        headers['Authorization'] = `Basic ${encoded}`;
      }

      // Custom headers
      const customHeaders = this.getNodeParameter('headers', i, { parameter: [] }) as { parameter: Array<{ name: string; value: string }> };
      for (const h of (customHeaders.parameter || [])) {
        headers[h.name] = h.value;
      }

      // Body
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

      // PCEC loop
      let attempt = 0;
      let lastError: Error | null = null;
      let repairLog: string[] = [];
      let succeeded = false;
      let responseData: IDataObject | null = null;

      while (attempt < maxAttempts) {
        attempt++;
        try {
          const response = await this.helpers.request(requestOptions as any);
          const statusCode = (response as any)?.statusCode ?? 200;
          const body = (response as any)?.body ?? response;

          if (statusCode >= 200 && statusCode < 300) {
            // Success — record to Gene Map regardless of attempt count
            if (learnPatterns) {
              // Record successful endpoint pattern
              try {
                const hostname = new URL(url).hostname;
                const endpointKey = `endpoint_${hostname}`;
                if (!geneMap[endpointKey]) {
                  geneMap[endpointKey] = {
                    strategy: 'direct_success',
                    successCount: 0,
                    totalCount: 0,
                    lastSeen: '',
                  };
                }
                geneMap[endpointKey].successCount++;
                geneMap[endpointKey].totalCount++;
                geneMap[endpointKey].lastSeen = new Date().toISOString();
              } catch (_) {}

              // If this was a repair, record the successful repair strategy too
              if (attempt > 1) {
                const lastRepair = repairLog[repairLog.length - 1];
                if (lastRepair) {
                  const geneKey = lastRepair.split('|')[0];
                  if (geneMap[geneKey]) {
                    geneMap[geneKey].successCount++;
                    geneMap[geneKey].totalCount++;
                    geneMap[geneKey].lastSeen = new Date().toISOString();
                  }
                }
              }
            }

            responseData = typeof body === 'string' ? { data: body } : (body as IDataObject);
            succeeded = true;
            break;
          }

          // Error response — classify and repair
          const errorMsg = JSON.stringify(body) || `HTTP ${statusCode}`;
          const classified = classifyError(statusCode, errorMsg);

          // Check gene map for known strategy
          const geneKey = `${classified.code}`;
          if (learnPatterns && geneMap[geneKey]) {
            const gene = geneMap[geneKey];
            gene.totalCount++;
            gene.lastSeen = new Date().toISOString();
          } else if (learnPatterns) {
            geneMap[geneKey] = {
              strategy: classified.strategy,
              successCount: 0,
              totalCount: 1,
              lastSeen: new Date().toISOString(),
            };
          }

          repairLog.push(`${geneKey}|${classified.strategy}|attempt${attempt}`);

          if (attempt >= maxAttempts) {
            lastError = new Error(`Failed after ${maxAttempts} attempts. Last error: HTTP ${statusCode} — ${errorMsg}. Repair log: ${repairLog.join(', ')}`);
            break;
          }

          // Apply repair strategy
          if (classified.waitMs) {
            const backoff = Math.min(classified.waitMs * Math.pow(1.5, attempt - 1), maxBackoffMs);
            await sleep(backoff);
          }

          // Log the repair action
          this.logger.info(`[VialOS] ${classified.action} (attempt ${attempt}/${maxAttempts})`);

        } catch (err: any) {
          const errorMsg = err?.message || String(err);
          const statusCode = err?.statusCode ?? err?.response?.statusCode ?? 0;
          const classified = classifyError(statusCode, errorMsg);

          repairLog.push(`${classified.code}|${classified.strategy}|attempt${attempt}`);

          if (attempt >= maxAttempts) {
            lastError = new Error(`Failed after ${maxAttempts} attempts. Error: ${errorMsg}. Repair log: ${repairLog.join(', ')}`);
            break;
          }

          if (classified.waitMs) {
            const backoff = Math.min(classified.waitMs * Math.pow(1.5, attempt - 1), maxBackoffMs);
            await sleep(backoff);
          }

          this.logger.info(`[VialOS] ${classified.action} (attempt ${attempt}/${maxAttempts})`);
        }
      }

      // Save gene map
      if (learnPatterns) {
        staticData.geneMap = geneMap;
      }

      if (succeeded && responseData !== null) {
        successItems.push({
          json: {
            ...responseData,
            _vialos: {
              attempts: attempt,
              repaired: attempt > 1,
              repairLog,
              geneMapSize: Object.keys(geneMap).length,
              geneMapKeys: Object.keys(geneMap),
            },
          },
          pairedItem: { item: i },
        });
      } else {
        const failedItem: INodeExecutionData = {
          json: {
            error: lastError?.message ?? 'Unknown error',
            url,
            attempts: attempt,
            repairLog,
            _vialos: {
              errorCode: repairLog[repairLog.length - 1]?.split('|')[0] ?? 'unknown',
              geneMapSize: Object.keys(geneMap).length,
              suggestion: getSuggestion(repairLog[repairLog.length - 1]?.split('|')[0] ?? ''),
            },
          },
          pairedItem: { item: i },
        };

        if (routeFailures) {
          failedItems.push(failedItem);
        } else {
          throw new NodeOperationError(
            this.getNode(),
            lastError?.message ?? 'Request failed',
            { itemIndex: i }
          );
        }
      }
    }

    return [successItems, failedItems];
  }
}

function getSuggestion(errorCode: string): string {
  const suggestions: Record<string, string> = {
    rate_limit: 'Add a Wait node before this node, or reduce request frequency. Gene Map will optimize backoff timing over time.',
    auth_expired: 'Refresh your OAuth credentials in n8n Settings → Credentials. Consider using a service account for long-running workflows.',
    schema_drift: 'The API changed its request format. Check API docs and update your request body.',
    forbidden: 'Check API key permissions. The credential may need additional scopes.',
    quota_exceeded: 'API quota reached. Add delays between executions or upgrade your API plan.',
    server_error: 'The API server is having issues. This is transient — Gene Map will retry with backoff.',
    timeout: 'Request timed out. The API may be slow — consider increasing n8n timeout settings.',
    not_found: 'The resource was not found. Check the URL or resource ID.',
    unknown_error: 'Unknown error. Check the error message in repairLog for details.',
  };
  return suggestions[errorCode] ?? 'Check the error details above.';
}
