import { describe, it, expect } from 'vitest';
import { buildRunReport } from '../src/server/agent/reporter.js';
import type { AgentRunTrace } from '../src/server/storage/types.js';

function makeTrace(overrides: Partial<AgentRunTrace> = {}): AgentRunTrace {
  return {
    run: { id: 'r1', goal_id: 'g1', status: 'succeeded', model: 'test', iteration_count: 1, created_at: new Date(), updated_at: new Date() } as any,
    goal: { id: 'g1', workspace_id: 'w1', title: 'Test Goal', original_instruction: 'test', status: 'completed', created_by_user_id: 'u1', source: 'test', priority: 'normal', created_at: new Date(), updated_at: new Date() } as any,
    steps: [],
    toolCalls: [],
    approvals: [],
    auditEvents: [],
    ...overrides
  };
}

describe('Action-Aware Reporter', () => {
  it('WS5: scopes the report to the latest plan iteration only', () => {
    const old = new Date('2020-01-01T00:00:00Z');
    const recent = new Date('2020-01-02T00:00:00Z');
    const report = buildRunReport(makeTrace({
      run: { id: 'r1', goal_id: 'g1', status: 'succeeded', model: 'test', plan_id: 'plan-2', created_at: new Date(), updated_at: new Date() } as any,
      steps: [
        { id: 's1', run_id: 'r1', plan_id: 'plan-1', order_index: 1, title: 'Stale failed step', status: 'failed', error: 'boom', input: {}, created_at: old } as any,
        { id: 's2', run_id: 'r1', plan_id: 'plan-2', order_index: 1, title: 'Fresh good step', status: 'succeeded', input: {}, created_at: recent } as any,
      ]
    }));
    expect(report).toContain('Fresh good step');
    expect(report).not.toContain('Stale failed step');
  });

  it('generates a report with success emoji for succeeded runs', () => {
    const report = buildRunReport(makeTrace());
    expect(report).toContain('✅');
    expect(report).toContain('Test Goal');
  });

  it('generates a report with failure emoji for failed runs', () => {
    const report = buildRunReport(makeTrace({
      run: { id: 'r1', goal_id: 'g1', status: 'failed', model: 'test', failure_reason: 'timeout', created_at: new Date(), updated_at: new Date() } as any
    }));
    expect(report).toContain('❌');
    expect(report).toContain('timeout');
  });

  it('lists steps with their status', () => {
    const report = buildRunReport(makeTrace({
      steps: [
        { id: 's1', run_id: 'r1', order_index: 1, title: 'Search memory', status: 'succeeded', input: {}, created_at: new Date() } as any,
        { id: 's2', run_id: 'r1', order_index: 2, title: 'Reply in thread', status: 'failed', error: 'channel_not_found', input: {}, created_at: new Date() } as any,
      ]
    }));
    expect(report).toContain('✅ Search memory');
    expect(report).toContain('❌ Reply in thread');
    expect(report).toContain('channel_not_found');
  });

  it('includes tool names from tool calls', () => {
    const report = buildRunReport(makeTrace({
      steps: [
        { id: 's1', run_id: 'r1', order_index: 1, title: 'Post to Slack', status: 'succeeded', input: {}, created_at: new Date() } as any,
      ],
      toolCalls: [
        { id: 'tc1', run_id: 'r1', step_id: 's1', tool_name: 'slack.replyInThread', status: 'succeeded', input: {}, risk_level: 'internal_write', created_at: new Date() } as any
      ]
    }));
    expect(report).toContain('`slack.replyInThread`');
  });

  it('includes resolved approvals', () => {
    const report = buildRunReport(makeTrace({
      approvals: [
        { id: 'a1', title: 'Approve GitHub issue', status: 'approved', created_at: new Date() } as any,
        { id: 'a2', title: 'Approve email send', status: 'rejected', created_at: new Date() } as any
      ]
    }));
    expect(report).toContain('👍');
    expect(report).toContain('Approve GitHub issue');
    expect(report).toContain('👎');
    expect(report).toContain('Approve email send');
  });

  it('notes multi-iteration runs', () => {
    const report = buildRunReport(makeTrace({
      run: { id: 'r1', goal_id: 'g1', status: 'succeeded', model: 'test', iteration_count: 3, created_at: new Date(), updated_at: new Date() } as any
    }));
    expect(report).toContain('3 iteration(s)');
  });

  it('mentions generate step output length', () => {
    const report = buildRunReport(makeTrace({
      steps: [
        { id: 's1', run_id: 'r1', order_index: 1, title: 'Generate content', status: 'succeeded', output: { generated: 'hello world' }, input: {}, created_at: new Date() } as any
      ]
    }));
    expect(report).toContain('generated 11 chars');
  });

  it('includes result summary when present', () => {
    const report = buildRunReport(makeTrace({
      run: { id: 'r1', goal_id: 'g1', status: 'succeeded', model: 'test', result_summary: 'All tasks completed.', created_at: new Date(), updated_at: new Date() } as any
    }));
    expect(report).toContain('All tasks completed.');
  });
});
