import { describe, it, expect } from 'vitest';

// We test the heuristic path only (no LLM call needed)
// classifyIntent is async but heuristic cases resolve synchronously
import { classifyIntent } from '../src/server/agent/intent.js';

describe('Intent Classifier — Heuristic Path', () => {
  it('classifies unsafe commands', async () => {
    const result = await classifyIntent('rm -rf /', 'gemini-3.1-flash-lite');
    expect(result.intent).toBe('unsafe_or_unsupported');
    expect(result.source).toBe('heuristic');
    expect(result.confidence).toBe('high');
  });

  it('classifies "drop table" as unsafe', async () => {
    const result = await classifyIntent('drop table users', 'gemini-3.1-flash-lite');
    expect(result.intent).toBe('unsafe_or_unsupported');
  });

  it('classifies "hello" as direct_reply (short message)', async () => {
    const result = await classifyIntent('hello', 'gemini-3.1-flash-lite');
    expect(result.intent).toBe('direct_reply');
    expect(result.source).toBe('heuristic');
  });

  it('classifies "ok" as direct_reply', async () => {
    const result = await classifyIntent('ok', 'gemini-3.1-flash-lite');
    expect(result.intent).toBe('direct_reply');
  });

  it('classifies approval words without pending approval as direct_reply', async () => {
    const result = await classifyIntent('approve', 'gemini-3.1-flash-lite', {
      context: { workspaceId: 'T1', channelId: 'C1', userId: 'U1', hasPendingApproval: false }
    });
    expect(result.intent).toBe('direct_reply');
  });

  it('classifies approval words with pending approval as approval_response', async () => {
    const result = await classifyIntent('approve', 'gemini-3.1-flash-lite', {
      context: { workspaceId: 'T1', channelId: 'C1', userId: 'U1', hasPendingApproval: true }
    });
    expect(result.intent).toBe('approval_response');
  });

  it('classifies "cancel run" as cancel_or_update', async () => {
    const result = await classifyIntent('cancel run please', 'gemini-3.1-flash-lite');
    expect(result.intent).toBe('cancel_or_update');
  });

  it('classifies "status of my tasks" as status_query', async () => {
    const result = await classifyIntent('status of my tasks', 'gemini-3.1-flash-lite');
    expect(result.intent).toBe('status_query');
  });

  it('classifies "remind me tomorrow" as durable_task', async () => {
    const result = await classifyIntent('remind me tomorrow at 9am', 'gemini-3.1-flash-lite');
    expect(result.intent).toBe('durable_task');
  });

  it('classifies "create a GitHub issue" as durable_task', async () => {
    const result = await classifyIntent('create a GitHub issue for the bug', 'gemini-3.1-flash-lite');
    expect(result.intent).toBe('durable_task');
  });

  it('classifies "summarize this thread" as durable_task', async () => {
    const result = await classifyIntent('summarize this thread', 'gemini-3.1-flash-lite');
    expect(result.intent).toBe('durable_task');
  });
});
