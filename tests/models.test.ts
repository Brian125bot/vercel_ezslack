import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('isAllowedModel', () => {
  it('returns true for valid allowed models', async () => {
    const { isAllowedModel } = await import('../src/server/agent/models.js');
    expect(isAllowedModel('gemini-3.8-flash')).toBe(true);
    expect(isAllowedModel('gemini-3.7-flash')).toBe(true);
    expect(isAllowedModel('gemini-3.6-flash')).toBe(true);
    expect(isAllowedModel('gemini-3.5-flash')).toBe(true);
    expect(isAllowedModel('gemini-3.5-flash-lite')).toBe(true);
    expect(isAllowedModel('gemini-3.1-flash-lite')).toBe(true);
    expect(isAllowedModel('gemini-3.0-flash')).toBe(true);
    expect(isAllowedModel('gemini-2.5-flash')).toBe(true);
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
    expect(resolveModel('gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(resolveModel('gemini-3.7-flash')).toBe('gemini-3.7-flash');
    expect(resolveModel('gemini-3.6-flash')).toBe('gemini-3.6-flash');
    expect(resolveModel('gemini-3.5-flash')).toBe('gemini-3.5-flash');
    expect(resolveModel('gemini-3.5-flash-lite')).toBe('gemini-3.5-flash-lite');
    expect(resolveModel('gemini-3.0-flash')).toBe('gemini-3.0-flash');
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
      'gemini-3.8-flash': 8192,
      'gemini-3.7-flash': 8192,
      'gemini-3.6-flash': 8192,
      'gemini-3.5-flash': 8192,
      'gemini-3.5-flash-lite': 8192,
      'gemini-3.1-flash-lite': 4096,
      'gemini-3.0-flash': 8192,
      'gemini-2.5-flash': 8192,
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
    expect(ALLOWED_MODELS).toContain('gemini-3.8-flash');
    expect(ALLOWED_MODELS).toContain('gemini-3.7-flash');
    expect(ALLOWED_MODELS).toContain('gemini-3.6-flash');
    expect(ALLOWED_MODELS).toContain('gemini-3.5-flash');
    expect(ALLOWED_MODELS).toContain('gemini-3.5-flash-lite');
    expect(ALLOWED_MODELS).toContain('gemini-3.1-flash-lite');
    expect(ALLOWED_MODELS).toContain('gemini-3.0-flash');
    expect(ALLOWED_MODELS).toContain('gemini-2.5-flash');
    expect(ALLOWED_MODELS.length).toBeGreaterThanOrEqual(4);
  });

  it('ALLOWED_MODELS lists gemini-3.8-flash as the first entry', async () => {
    const { ALLOWED_MODELS } = await import('../src/server/agent/models.js');
    expect(ALLOWED_MODELS[0]).toBe('gemini-3.8-flash');
  });

  it('regression: SAFE_DEFAULT_MODEL remains gemini-2.5-flash', async () => {
    const { SAFE_DEFAULT_MODEL } = await import('../src/server/agent/models.js');
    expect(SAFE_DEFAULT_MODEL).toBe('gemini-2.5-flash');
  });

  it('regression: DEFAULT_MODEL remains gemini-3.1-flash-lite', async () => {
    const { DEFAULT_MODEL } = await import('../src/server/agent/models.js');
    expect(DEFAULT_MODEL).toBe('gemini-3.1-flash-lite');
  });
});
