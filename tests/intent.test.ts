import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGeminiCall } = vi.hoisted(() => ({
  mockGeminiCall: vi.fn()
}));

vi.mock('../src/server/agent/geminiClient.js', () => ({
  geminiCall: mockGeminiCall
}));

vi.mock('../src/server/agent/models.js', () => ({
  resolveModel: vi.fn((m) => m)
}));

import { classifyIntent } from '../src/server/agent/intent.js';

describe('intent.ts - classifyIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'mock-key';
  });

  it('classifies unsafe or unsupported commands using heuristics', async () => {
    const res = await classifyIntent('Please rm -rf the logs directory', 'gemini-1.5-flash');
    expect(res).toEqual({
      intent: 'unsafe_or_unsupported',
      confidence: 'high',
      source: 'heuristic'
    });
  });

  it('classifies approval response when hasPendingApproval is true', async () => {
    const res = await classifyIntent('approve', 'gemini-1.5-flash', {
      context: { workspaceId: 'w', channelId: 'c', userId: 'u', hasPendingApproval: true }
    });
    expect(res).toEqual({
      intent: 'approval_response',
      confidence: 'high',
      source: 'heuristic'
    });
  });

  it('classifies short approval words as direct reply when hasPendingApproval is false', async () => {
    const res = await classifyIntent('approve', 'gemini-1.5-flash', {
      context: { workspaceId: 'w', channelId: 'c', userId: 'u', hasPendingApproval: false }
    });
    expect(res).toEqual({
      intent: 'direct_reply',
      confidence: 'high',
      source: 'heuristic'
    });
  });

  it('classifies cancel or update using heuristics', async () => {
    const res = await classifyIntent('cancel task now please', 'gemini-1.5-flash');
    expect(res).toEqual({
      intent: 'cancel_or_update',
      confidence: 'high',
      source: 'heuristic'
    });
  });

  it('classifies status query using heuristics', async () => {
    const res = await classifyIntent('what is the status of my execution?', 'gemini-1.5-flash');
    expect(res).toEqual({
      intent: 'status_query',
      confidence: 'high',
      source: 'heuristic'
    });
  });

  it('classifies durable task using heuristics', async () => {
    const res = await classifyIntent('remind me to check the deploy', 'gemini-1.5-flash');
    expect(res).toEqual({
      intent: 'durable_task',
      confidence: 'high',
      source: 'heuristic'
    });
  });

  it('classifies short messages as direct reply', async () => {
    const res = await classifyIntent('hello', 'gemini-1.5-flash');
    expect(res).toEqual({
      intent: 'direct_reply',
      confidence: 'high',
      source: 'heuristic'
    });
  });

  it('uses LLM for fallback classification and succeeds', async () => {
    mockGeminiCall.mockResolvedValue(JSON.stringify({
      intent: 'durable_task',
      confidence: 'high'
    }));

    const res = await classifyIntent('This is a longer message that should trigger LLM fallback.', 'gemini-1.5-flash');
    expect(res).toEqual({
      intent: 'durable_task',
      confidence: 'high',
      source: 'llm'
    });
    expect(mockGeminiCall).toHaveBeenCalled();
  });

  it('forces approval_response from LLM to direct_reply when hasPendingApproval is false', async () => {
    mockGeminiCall.mockResolvedValue(JSON.stringify({
      intent: 'approval_response',
      confidence: 'medium'
    }));

    const res = await classifyIntent('This is a longer message that should trigger LLM fallback.', 'gemini-1.5-flash', {
      context: { workspaceId: 'w', channelId: 'c', userId: 'u', hasPendingApproval: false }
    });
    expect(res).toEqual({
      intent: 'direct_reply',
      confidence: 'medium',
      source: 'llm'
    });
  });

  it('allows approval_response from LLM when hasPendingApproval is true', async () => {
    mockGeminiCall.mockResolvedValue(JSON.stringify({
      intent: 'approval_response',
      confidence: 'medium'
    }));

    const res = await classifyIntent('This is a longer message that should trigger LLM fallback.', 'gemini-1.5-flash', {
      context: { workspaceId: 'w', channelId: 'c', userId: 'u', hasPendingApproval: true }
    });
    expect(res).toEqual({
      intent: 'approval_response',
      confidence: 'medium',
      source: 'llm'
    });
  });

  it('falls back to direct reply when LLM returns invalid category', async () => {
    mockGeminiCall.mockResolvedValue(JSON.stringify({
      intent: 'invalid_category_abc',
      confidence: 'high'
    }));

    const res = await classifyIntent('This is a longer message that should trigger LLM fallback.', 'gemini-1.5-flash');
    expect(res).toEqual({
      intent: 'direct_reply',
      confidence: 'low',
      source: 'fallback'
    });
  });

  it('falls back to direct reply when LLM throws an error', async () => {
    mockGeminiCall.mockRejectedValue(new Error('API quota exceeded'));

    const res = await classifyIntent('This is a longer message that should trigger LLM fallback.', 'gemini-1.5-flash');
    expect(res).toEqual({
      intent: 'direct_reply',
      confidence: 'low',
      source: 'fallback'
    });
  });

  it('falls back to direct reply when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;

    const res = await classifyIntent('This is a longer message that should trigger LLM fallback.', 'gemini-1.5-flash');
    expect(res).toEqual({
      intent: 'direct_reply',
      confidence: 'low',
      source: 'fallback'
    });
  });
});
