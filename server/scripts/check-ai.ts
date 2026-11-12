/**
 * Read-only AI provider check: verifies the key, lists available models, and confirms the
 * configured per-role models exist. Never prints the key. Usage: npm run check:ai
 */
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
console.log(`provider: ${cfg.AI_PROVIDER}  base: ${cfg.AI_BASE_URL ?? '(sdk default)'}  key: ${cfg.AI_API_KEY ? 'set' : 'MISSING'}`);
if (!cfg.AI_API_KEY) {
  console.log(`Set ${cfg.AI_PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : cfg.AI_PROVIDER === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} in .env`);
  process.exit(1);
}
if (!cfg.AI_BASE_URL) {
  console.log('check:ai currently supports OpenAI-compatible providers (gemini/openai).');
  process.exit(0);
}
const res = await fetch(new URL('models', cfg.AI_BASE_URL), { headers: { Authorization: `Bearer ${cfg.AI_API_KEY}` }, signal: AbortSignal.timeout(15_000) });
if (!res.ok) {
  console.log(`FAIL  /models returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const body = (await res.json()) as { data?: { id: string }[] };
const ids = (body.data ?? []).map((m) => m.id.replace(/^models\//, '')).sort();
console.log(`PASS  key accepted · ${ids.length} models available`);
console.log(ids.filter((id) => /gemini/.test(id)).map((id) => `  ${id}`).join('\n'));
const roles = { investigator: cfg.AI_MODEL_INVESTIGATOR, advocate: cfg.AI_MODEL_ADVOCATE, challenger: cfg.AI_MODEL_CHALLENGER, judge: cfg.AI_MODEL_JUDGE };
let missing = 0;
for (const [role, model] of Object.entries(roles)) {
  const ok = ids.includes(model);
  if (!ok) missing++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${role.padEnd(12)} ${model}${ok ? '' : '  (not in the model list)'}`);
}
// Being listed is not proof of access (2.5-* models are listed but return 404 for new keys),
// so send one tiny structured request per distinct role model.
const { createAI } = await import('../src/ai/provider.js');
const { z } = await import('zod');
const ai = createAI(cfg);
for (const model of [...new Set([...Object.values(roles), ...(Object.values(cfg.AI_FALLBACKS).filter(Boolean) as string[])])]) {
  const t0 = Date.now();
  try {
    const r = await ai.complete({ system: 'Reply with JSON.', messages: [{ role: 'user', content: 'Say ok.' }], schema: z.object({ ok: z.boolean() }), schemaName: 'Ping', model, fallbackModel: null, timeoutMs: 30_000 });
    console.log(`PASS  live call   ${model} → ${r.model} in ${Date.now() - t0}ms`);
  } catch (e) {
    missing++;
    console.log(`FAIL  live call   ${model}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
  }
}
process.exit(missing ? 1 : 0);
