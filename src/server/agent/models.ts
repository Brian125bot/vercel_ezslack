/**
 * WS1 — Model configuration integrity.
 *
 * Single source of truth for which Gemini models the app is allowed to use,
 * plus a safe resolver. Any selected/persisted model that is not in the allow
 * list is transparently downgraded to SAFE_DEFAULT_MODEL so that planning,
 * generation, plan-mutation, and verification LLM calls never throw a
 * "model not found" error and cascade into multistep failure.
 */

export const ALLOWED_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash'
] as const;

export type AllowedModel = typeof ALLOWED_MODELS[number];

/** Known-good model guaranteed to be broadly available. */
export const SAFE_DEFAULT_MODEL: AllowedModel = 'gemini-2.5-flash';

/** The user-facing default model. */
export const DEFAULT_MODEL: AllowedModel = 'gemini-3.1-flash-lite';

export function isAllowedModel(model: string | null | undefined): model is AllowedModel {
  return !!model && (ALLOWED_MODELS as readonly string[]).includes(model);
}

/**
 * Resolve a model string to a usable model id. Falls back to SAFE_DEFAULT_MODEL
 * for empty / unknown / unreleased ids.
 */
export function resolveModel(model: string | null | undefined): AllowedModel {
  return isAllowedModel(model) ? model : SAFE_DEFAULT_MODEL;
}
