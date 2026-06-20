import { describe, it, expect } from 'vitest';
import { verifyRun } from '../src/server/agent/verifier.js';
import type { AgentRunTrace } from '../src/server/storage/types.js';

function makeTrace(overrides: Partial<AgentRunTrace> = {}): AgentRunTrace {
  return {
    run: { id: 'r1', goal_id: 'g1', status: 'running', model: 'test', created_at: new Date(), updated_at: new Date() } as any,
    goal: { id: 'g1', workspace_id: 'w1', title: 'Test', original_instruction: 'test', status: 'running', created_by_user_id: 'u1', source: 'test', priority: 'normal', created_at: new Date(), updated_at: new Date() } as any,
    steps: [],
    toolCalls: [],
    approvals: [],
    auditEvents: [],
    ...overrides
  };
}

describe('Rule Verifier', () => {
  it('returns not_satisfied when no steps', () => {
    const result = verifyRun(makeTrace());
    expect(result.status).toBe('not_satisfied');
    expect(result.recommendedNextAction).toBe('replan');
  });

  it('returns satisfied when all steps succeeded', () => {
    const result = verifyRun(makeTrace({
      steps: [
        { id: 's1', run_id: 'r1', order_index: 1, title: 'Step 1', status: 'succeeded', input: {}, created_at: new Date() } as any,
        { id: 's2', run_id: 'r1', order_index: 2, title: 'Step 2', status: 'succeeded', input: {}, created_at: new Date() } as any
      ]
    }));
    expect(result.status).toBe('satisfied');
    expect(result.recommendedNextAction).toBe('complete');
  });

  it('returns blocked when a step is blocked', () => {
    const result = verifyRun(makeTrace({
      steps: [
        { id: 's1', run_id: 'r1', order_index: 1, title: 'Step 1', status: 'succeeded', input: {}, created_at: new Date() } as any,
        { id: 's2', run_id: 'r1', order_index: 2, title: 'Step 2', status: 'blocked', input: {}, created_at: new Date() } as any
      ]
    }));
    expect(result.status).toBe('blocked');
    expect(result.recommendedNextAction).toBe('block');
  });

  it('returns partially_satisfied when a step fails (non-slack)', () => {
    const result = verifyRun(makeTrace({
      steps: [
        { id: 's1', run_id: 'r1', order_index: 1, title: 'Step 1', status: 'succeeded', input: {}, created_at: new Date() } as any,
        { id: 's2', run_id: 'r1', order_index: 2, title: 'Step 2', status: 'failed', error: 'oops', input: {}, created_at: new Date() } as any
      ]
    }));
    expect(result.status).toBe('partially_satisfied');
  });

  it('returns not_satisfied with retry when slack step fails', () => {
    const result = verifyRun(makeTrace({
      steps: [
        { id: 's1', run_id: 'r1', order_index: 1, title: 'Slack reply', status: 'failed', error: 'err', input: { toolName: 'slack.replyInThread' }, created_at: new Date() } as any
      ]
    }));
    expect(result.status).toBe('not_satisfied');
    expect(result.recommendedNextAction).toBe('retry');
  });

  it('skipped steps count as succeeded', () => {
    const result = verifyRun(makeTrace({
      steps: [
        { id: 's1', run_id: 'r1', order_index: 1, title: 'Step 1', status: 'skipped', input: {}, created_at: new Date() } as any
      ]
    }));
    expect(result.status).toBe('satisfied');
  });
});
