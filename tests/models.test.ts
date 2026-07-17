import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('isAllowedModel', () => {
  it('returns true for valid allowed models', async () => {
    const { isAllowedModel } = await import('../src/server/agent/models.js');
    expect(isAllowedModel('gemini-2.5-flash')).toBe(true);
    expect(isAllowedModel('gemini-3.1-flash-lite')).toBe(true);
    expect(isAllowedModel('gemini-1.5-flash')).toBe(true);
  });

  it('returns false for invalid models', async () => {
    const { isAllowedModel } = await import('../src/server/agent/models.js');
    expect(isAllowedModel('gemini-4.0-flash')).toBe(false);
    expect(isAllowedModel('')).toBe(false);
    expect(isAllowedModel(null)).toBe(false);
    expect(isAllowedModel(undefined)).toBe(false);
  });
});

describe('resolveModel', () => {
  it('passes through a valid allowed model', async () => {
    const { resolveModel } = await import('../src/server/agent/models.js');
    expect(resolveModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });

  it('falls back to SAFE_DEFAULT_MODEL for unknown models', async () => {
    const { resolveModel, SAFE_DEFAULT_MODEL } = await import('../src/server/agent/models.js');
    expect(resolveModel('gemini-4.0-flash')).toBe(SAFE_DEFAULT_MODEL);
    expect(resolveModel('')).toBe(SAFE_DEFAULT_MODEL);
    expect(resolveModel(null)).toBe(SAFE_DEFAULT_MODEL);
    expect(resolveModel(undefined)).toBe(SAFE_DEFAULT_MODEL);
  });
});

describe('getContextWindowTokens', () => {
  it('returns correct token count for each allowed model', async () => {
    const { getContextWindowTokens, ALLOWED_MODELS, CONTEXT_WINDOW_TOKENS } = await import('../src/server/agent/models.js');
    for (const model of ALLOWED_MODELS) {
      expect(getContextWindowTokens(model)).toBe(CONTEXT_WINDOW_TOKENS[model]);
    }
  });

  it('returns fallback token count for invalid model', async () => {
    const { getContextWindowTokens, SAFE_DEFAULT_MODEL, CONTEXT_WINDOW_TOKENS } = await import('../src/server/agent/models.js');
    expect(getContextWindowTokens('unknown-model')).toBe(CONTEXT_WINDOW_TOKENS[SAFE_DEFAULT_MODEL]);
  });
});

describe('getMaxOutputTokens', () => {
  it('returns correct max output tokens for each allowed model', async () => {
    const { getMaxOutputTokens, ALLOWED_MODELS } = await import('../src/server/agent/models.js');
    const expected: Record<string, number> = {
      'gemini-3.5-flash': 8192,
      'gemini-3.1-flash-lite': 4096,
      'gemini-2.5-flash': 8192,
      'gemini-2.0-flash': 8192,
      'gemini-1.5-flash': 4096,
    };
    for (const model of ALLOWED_MODELS) {
      expect(getMaxOutputTokens(model)).toBe(expected[model]);
    }
  });

  it('returns fallback based on SAFE_DEFAULT_MODEL for unknown model', async () => {
    const { getMaxOutputTokens, SAFE_DEFAULT_MODEL, ALLOWED_MODELS } = await import('../src/server/agent/models.js');
    const result = getMaxOutputTokens('unknown-model');
    const expected = result === getMaxOutputTokens(SAFE_DEFAULT_MODEL);
    expect(expected).toBe(true);
  });
});

describe('constants', () => {
  it('DEFAULT_MODEL and SAFE_DEFAULT_MODEL are different', async () => {
    const { DEFAULT_MODEL, SAFE_DEFAULT_MODEL } = await import('../src/server/agent/models.js');
    expect(DEFAULT_MODEL).not.toBe(SAFE_DEFAULT_MODEL);
  });

  it('ALLOWED_MODELS includes all expected models', async () => {
    const { ALLOWED_MODELS } = await import('../src/server/agent/models.js');
    expect(ALLOWED_MODELS).toContain('gemini-2.5-flash');
    expect(ALLOWED_MODELS).toContain('gemini-3.1-flash-lite');
    expect(ALLOWED_MODELS.length).toBeGreaterThanOrEqual(5);
  });
});
