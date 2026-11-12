import type { AppConfig } from '../config.js';

/** Reports whether an AI provider is configured. Never exposes key values. */
export function aiStatus(cfg: AppConfig) {
  const configured = Boolean(cfg.AI_API_KEY);
  return {
    provider: cfg.AI_PROVIDER,
    baseUrl: cfg.AI_BASE_URL,
    configured,
    message: configured ? null : 'AI not configured',
    models: {
      investigator: cfg.AI_MODEL_INVESTIGATOR,
      advocate: cfg.AI_MODEL_ADVOCATE,
      challenger: cfg.AI_MODEL_CHALLENGER,
      judge: cfg.AI_MODEL_JUDGE,
    },
    fallbacks: cfg.AI_FALLBACKS,
    councilRebuttal: cfg.COUNCIL_REBUTTAL,
  };
}
