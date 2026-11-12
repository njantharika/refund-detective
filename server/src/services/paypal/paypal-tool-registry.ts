import { Ajv, type ValidateFunction } from 'ajv';
import { logger } from '../../lib/logger.js';
import type { ToolTransport, DiscoveredTool } from './paypal-mcp-client.js';
import type { PayPalRestFallback } from './paypal-rest-fallback.js';
import { PayPalError, type PayPalPath } from './paypal.types.js';

export const READ_TOOLS = ['list_transactions', 'get_order', 'get_refund', 'list_disputes', 'get_dispute'] as const;
export const WRITE_TOOLS = ['create_refund', 'accept_dispute_claim'] as const;
export const SEED_TOOLS = ['create_order', 'pay_order'] as const;
export const ALLOWED_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS, ...SEED_TOOLS];

export type ReadTool = (typeof READ_TOOLS)[number];
export type WriteTool = (typeof WRITE_TOOLS)[number] | (typeof SEED_TOOLS)[number];

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;

export interface LastCall {
  tool: string;
  path: PayPalPath;
  ok: boolean;
  durationMs: number;
  at: string;
  errorCode: string | null;
}

/** Keeps the MCP child's credentials valid: refresh before calls, recover once from a 401. */
export interface TokenGuard {
  ensureFresh(): Promise<void>;
  recoverFromAuthError(): Promise<boolean>;
}

export const isAuthError = (e: unknown) =>
  e instanceof PayPalError && (e.httpStatus === 401 || /access token|invalid_token|not authorized to access|token.*expired/i.test(e.message)) && e.httpStatus !== 403;

export interface CallResult<T = unknown> {
  data: T;
  path: PayPalPath;
}

/**
 * Single choke point for every PayPal operation. Enforces the allowlist, validates arguments
 * against the schema the MCP server advertised, applies timeouts, and falls back to REST only
 * when the MCP server is unavailable *before* a request is sent (never after a write was attempted).
 */
export class PayPalToolRegistry {
  private ajv = new Ajv({ strict: false, allErrors: true, useDefaults: false });
  private validators = new Map<string, ValidateFunction>();
  private discovered = new Map<string, DiscoveredTool>();
  private last: LastCall | null = null;
  private pathCounts: Record<PayPalPath, number> = { mcp: 0, rest_fallback: 0 };

  constructor(
    private readonly mcp: ToolTransport,
    private readonly fallback: PayPalRestFallback | null,
    private readonly tokenGuard: TokenGuard | null = null,
  ) {}

  /** Loads the tool list from the MCP server and compiles validators for allowlisted tools. */
  async refreshSchemas(): Promise<void> {
    const tools = await this.mcp.listTools();
    this.discovered.clear();
    this.validators.clear();
    for (const t of tools) {
      this.discovered.set(t.name, t);
      if (ALLOWED_TOOLS.includes(t.name)) this.validators.set(t.name, this.ajv.compile(t.inputSchema));
    }
  }

  discoveredTools(): { name: string; allowed: boolean }[] {
    return [...this.discovered.keys()].map((name) => ({ name, allowed: ALLOWED_TOOLS.includes(name) }));
  }

  missingAllowedTools(): string[] {
    return ALLOWED_TOOLS.filter((t) => !this.discovered.has(t));
  }

  lastCall(): LastCall | null {
    return this.last;
  }

  pathUsage() {
    return { ...this.pathCounts };
  }

  async read<T = unknown>(tool: ReadTool, args: Record<string, unknown>): Promise<CallResult<T>> {
    return this.invoke<T>(tool, args, READ_TIMEOUT_MS);
  }

  /**
   * Money-moving / state-changing calls. Callers must pass the literal confirmation flag; the
   * refund and dispute services only do so after guardrails, a lock, and merchant approval.
   */
  async write<T = unknown>(tool: WriteTool, args: Record<string, unknown>, opts: { approved: true; idempotencyKey?: string }): Promise<CallResult<T>> {
    if (opts?.approved !== true) throw new PayPalError(`Write tool ${tool} requires explicit approval`, 403, 'WRITE_NOT_APPROVED', tool);
    return this.invoke<T>(tool, args, WRITE_TIMEOUT_MS, opts.idempotencyKey);
  }

  private async invoke<T>(tool: string, args: Record<string, unknown>, timeoutMs: number, idempotencyKey?: string): Promise<CallResult<T>> {
    if (!ALLOWED_TOOLS.includes(tool)) throw new PayPalError(`Tool "${tool}" is not on the allowlist`, 403, 'TOOL_NOT_ALLOWED', tool);
    await this.tokenGuard?.ensureFresh();
    try {
      return await this.invokeOnce<T>(tool, args, timeoutMs, idempotencyKey);
    } catch (e) {
      // PayPal rejected the token itself (401): the request was not processed, so re-minting and retrying
      // once is safe for reads. Writes are never retried automatically; the caller reconciles.
      const isRead = (READ_TOOLS as readonly string[]).includes(tool);
      if (isRead && isAuthError(e) && this.tokenGuard && (await this.tokenGuard.recoverFromAuthError())) {
        return this.invokeOnce<T>(tool, args, timeoutMs, idempotencyKey);
      }
      throw e;
    }
  }

  private async invokeOnce<T>(tool: string, args: Record<string, unknown>, timeoutMs: number, idempotencyKey?: string): Promise<CallResult<T>> {
    const mcpReady = this.mcp.isReady();
    if (mcpReady && this.validators.size === 0) await this.refreshSchemas();
    const validate = this.validators.get(tool);
    if (validate && !validate(args)) {
      const msg = (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
      throw new PayPalError(`Invalid arguments for ${tool}: ${msg}`, 400, 'INVALID_TOOL_ARGS', tool);
    }
    if (mcpReady && !validate) throw new PayPalError(`MCP server did not advertise ${tool}`, 502, 'TOOL_NOT_DISCOVERED', tool);

    const started = Date.now();
    let path: PayPalPath = 'mcp';
    try {
      let data: unknown;
      if (mcpReady) {
        data = await this.mcp.callTool(tool, args, timeoutMs);
      } else if (this.fallback?.supports(tool)) {
        path = 'rest_fallback';
        data = await this.fallback.call(tool, idempotencyKey ? { ...args, __idempotency_key: idempotencyKey } : args, timeoutMs);
      } else {
        throw new PayPalError('PayPal MCP server is unavailable and no REST fallback exists for this tool', 503, 'MCP_UNAVAILABLE', tool);
      }
      this.record(tool, path, true, started, null);
      return { data: data as T, path };
    } catch (e) {
      const code = e instanceof PayPalError ? e.code : 'UNKNOWN';
      this.record(tool, path, false, started, code);
      throw e;
    }
  }

  private record(tool: string, path: PayPalPath, ok: boolean, started: number, errorCode: string | null) {
    const durationMs = Date.now() - started;
    this.pathCounts[path] += 1;
    this.last = { tool, path, ok, durationMs, at: new Date().toISOString(), errorCode };
    // Tool name, duration and status only. Never payloads or secrets.
    logger.info({ tool, path, ok, durationMs, errorCode }, 'paypal tool call');
  }
}
