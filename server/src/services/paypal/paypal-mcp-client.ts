import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { logger, scrubSecrets } from '../../lib/logger.js';
import { PayPalError } from './paypal.types.js';

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Minimal surface the registry needs, so tests can substitute a fake transport. */
export interface ToolTransport {
  isReady(): boolean;
  listTools(): Promise<DiscoveredTool[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
}

export type McpState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'error';

export interface McpStatus {
  state: McpState;
  serverName: string | null;
  serverVersion: string | null;
  toolCount: number;
  restarts: number;
  lastError: string | null;
  command: string;
}

/** Resolves the locally installed @paypal/mcp entry point; falls back to `npx -y @paypal/mcp`. */
function resolveServerCommand(): { command: string; args: string[]; display: string } {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@paypal/mcp/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin ? Object.values(pkg.bin)[0] : 'dist/index.js';
    const entry = path.join(path.dirname(pkgPath), bin);
    if (fs.existsSync(entry)) return { command: process.execPath, args: [entry, '--tools=all'], display: `node @paypal/mcp/${bin} --tools=all` };
  } catch {
    /* fall through */
  }
  return { command: 'npx', args: ['-y', '@paypal/mcp', '--tools=all'], display: 'npx -y @paypal/mcp --tools=all' };
}

/**
 * Owns the @paypal/mcp child process over stdio. Restarts it (with backoff) on crash or when the
 * access token changes, caches discovered tool schemas, and enforces per-call timeouts.
 */
export class PayPalMcpClient implements ToolTransport {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: DiscoveredTool[] = [];
  private state: McpState = 'stopped';
  private serverName: string | null = null;
  private serverVersion: string | null = null;
  private restarts = 0;
  private backoffMs = 1000;
  private lastError: string | null = null;
  private token: string | null = null;
  private shuttingDown = false;
  private starting: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly cmd = resolveServerCommand();

  async start(token: string): Promise<void> {
    this.token = token;
    if (this.starting) return this.starting;
    this.starting = this.connect().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Called when PayPalAuth mints a new token: restart the child so it picks up fresh credentials. */
  async updateToken(token: string): Promise<void> {
    if (token === this.token && this.state === 'ready') return;
    this.token = token;
    this.state = 'restarting';
    await this.teardown();
    await this.start(token);
  }

  private async connect(): Promise<void> {
    if (!this.token) throw new PayPalError('MCP client has no access token', null, 'NO_CREDENTIALS');
    this.state = this.state === 'restarting' ? 'restarting' : 'starting';
    const transport = new StdioClientTransport({
      command: this.cmd.command,
      args: this.cmd.args,
      env: { ...getDefaultEnvironment(), PAYPAL_ACCESS_TOKEN: this.token, PAYPAL_ENVIRONMENT: 'SANDBOX' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      logger.debug({ mcpStderr: scrubSecrets(chunk.toString()).slice(0, 500) }, 'paypal-mcp stderr');
    });
    const client = new Client({ name: 'refund-detective', version: '0.1.0' });
    transport.onclose = () => this.onUnexpectedClose(transport);
    try {
      await client.connect(transport, { timeout: 30_000 });
      const info = client.getServerVersion();
      this.serverName = info?.name ?? null;
      this.serverVersion = info?.version ?? null;
      const listed = await client.listTools(undefined, { timeout: 15_000 });
      this.tools = listed.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
      this.client = client;
      this.transport = transport;
      this.state = 'ready';
      this.lastError = null;
      this.backoffMs = 1000;
      logger.info({ server: this.serverName, version: this.serverVersion, tools: this.tools.length }, 'paypal mcp connected');
    } catch (e) {
      this.state = 'error';
      this.lastError = scrubSecrets(e instanceof Error ? e.message : String(e));
      transport.onclose = undefined;
      await transport.close().catch(() => {});
      logger.error({ err: this.lastError }, 'paypal mcp connect failed');
      this.scheduleRestart();
      throw new PayPalError(`PayPal MCP server failed to start: ${this.lastError}`, null, 'MCP_UNAVAILABLE');
    }
  }

  private onUnexpectedClose(t: StdioClientTransport) {
    if (this.shuttingDown || t !== this.transport) return;
    logger.warn('paypal mcp child exited unexpectedly');
    this.client = null;
    this.transport = null;
    this.state = 'error';
    this.lastError = 'MCP child process exited';
    this.scheduleRestart();
  }

  private scheduleRestart() {
    if (this.shuttingDown || this.restartTimer || !this.token) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restarts += 1;
      this.state = 'restarting';
      this.start(this.token!).catch(() => {});
    }, delay);
    this.restartTimer.unref();
  }

  isReady(): boolean {
    return this.state === 'ready' && this.client !== null;
  }

  async listTools(): Promise<DiscoveredTool[]> {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.client || !this.isReady()) throw new PayPalError('PayPal MCP server is not connected', null, 'MCP_UNAVAILABLE', name);
    let result;
    try {
      result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (e) {
      const msg = scrubSecrets(e instanceof Error ? e.message : String(e));
      const timedOut = /timed? ?out/i.test(msg);
      throw new PayPalError(timedOut ? `MCP tool ${name} timed out after ${timeoutMs}ms` : `MCP tool ${name} failed: ${msg}`, null, timedOut ? 'TIMEOUT' : 'MCP_CALL_FAILED', name);
    }
    return parseToolResult(name, result as { content?: Array<{ type: string; text?: string }>; isError?: boolean });
  }

  status(): McpStatus {
    return {
      state: this.state,
      serverName: this.serverName,
      serverVersion: this.serverVersion,
      toolCount: this.tools.length,
      restarts: this.restarts,
      lastError: this.lastError,
      command: this.cmd.display,
    };
  }

  private async teardown() {
    const t = this.transport;
    this.transport = null;
    this.client = null;
    if (t) {
      t.onclose = undefined;
      await t.close().catch(() => {});
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    await this.teardown();
    this.state = 'stopped';
  }
}

/**
 * The PayPal MCP server returns its payload as JSON text content. Errors come back either with
 * isError=true or as {"ok":false,"status":403,...}; both are converted to PayPalError.
 */
export function parseToolResult(name: string, result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): unknown {
  const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON text */
  }
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  if (result.isError || (obj && obj.ok === false)) {
    const status = obj && typeof obj.status === 'number' ? obj.status : null;
    const message = obj && typeof obj.message === 'string' ? obj.message : typeof parsed === 'string' ? parsed : 'Unknown PayPal error';
    throw new PayPalError(scrubSecrets(message), status, status === 403 ? 'PAYPAL_FORBIDDEN' : 'PAYPAL_API_ERROR', name);
  }
  return parsed;
}
