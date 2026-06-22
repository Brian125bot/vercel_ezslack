import { describe, it, expect } from 'vitest';
import { resolveModel, isAllowedModel, SAFE_DEFAULT_MODEL, DEFAULT_MODEL, ALLOWED_MODELS } from '../src/server/agent/models.js';

describe('model resolver (WS1)', () => {
  it('keeps allowed models as-is', () => {
    for (const m of ALLOWED_MODELS) {
      expect(resolveModel(m)).toBe(m);
    }
  });
  it('falls back to the safe default for unknown/empty models', () => {
    expect(resolveModel('gemini-9000-ultra')).toBe(SAFE_DEFAULT_MODEL);
    expect(resolveModel('')).toBe(SAFE_DEFAULT_MODEL);
    expect(resolveModel(undefined)).toBe(SAFE_DEFAULT_MODEL);
    expect(resolveModel(null)).toBe(SAFE_DEFAULT_MODEL);
  });
  it('default model is in the allow list', () => {
    expect(isAllowedModel(DEFAULT_MODEL)).toBe(true);
  });
});
