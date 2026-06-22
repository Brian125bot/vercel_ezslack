import { describe, it, expect } from 'vitest';
import { normalizePlanDraft, normalizeRiskLevel, type ToolLookup } from '../src/server/agent/planNormalize.js';
import type { AgentPlanDraft } from '../src/server/agent/types.js';

const registry: ToolLookup = {
  get(name: string) {
    const tools: Record<string, any> = {
      'slack.replyInThread': { name: 'slack.replyInThread', riskLevel: 'internal_write' },
      'memory.search': { name: 'memory.search', riskLevel: 'read' },
      'github.createIssue': { name: 'github.createIssue', riskLevel: 'external_write' }
    };
    return tools[name];
  }
};

function draft(partial: Partial<AgentPlanDraft>): AgentPlanDraft {
  return {
    summary: 's', assumptions: [], steps: [], riskLevel: 'internal_write' as any, requiresApproval: false, ...partial
  };
}

describe('planNormalize (WS2)', () => {
  it('maps free-text risk levels to the enum', () => {
    expect(normalizeRiskLevel('low')).toBe('read');
    expect(normalizeRiskLevel('medium')).toBe('internal_write');
    expect(normalizeRiskLevel('high')).toBe('external_write');
    expect(normalizeRiskLevel('CRITICAL')).toBe('destructive');
    expect(normalizeRiskLevel('garbage')).toBe('internal_write');
    expect(normalizeRiskLevel('read')).toBe('read');
  });

  it('degrades an unknown tool to a note instead of poisoning the whole plan', () => {
    const { plan, redactedTools } = normalizePlanDraft(draft({
      steps: [
        { title: 'Search memory', kind: 'tool', toolName: 'memory.search', input: { input: { q: 'x' } } },
        { title: 'Do magic', kind: 'tool', toolName: 'magic.doThing', input: {} },
        { title: 'Reply', kind: 'tool', toolName: 'slack.replyInThread', input: { input: { text: '' } } }
      ]
    }), registry);

    expect(redactedTools).toContain('magic.doThing');
    // The valid steps are preserved as tool steps.
    expect(plan.steps[0].kind).toBe('tool');
    expect(plan.steps[2].kind).toBe('tool');
    // The unknown one became a note, NOT a failing tool step.
    expect(plan.steps[1].kind).toBe('note');
    expect(plan.steps[1].toolName).toBeUndefined();
    // No external tool present -> no approval, no escalated risk.
    expect(plan.requiresApproval).toBe(false);
    expect(plan.riskLevel).not.toBe('external_write');
  });

  it('requires approval only when an executable external_write tool is present', () => {
    const { plan } = normalizePlanDraft(draft({
      requiresApproval: false,
      steps: [
        { title: 'File issue', kind: 'tool', toolName: 'github.createIssue', input: { input: {} } }
      ]
    }), registry);
    expect(plan.requiresApproval).toBe(true);
    expect(plan.riskLevel).toBe('external_write');
  });

  it('downgrades over-rated approval when no external step exists', () => {
    const { plan } = normalizePlanDraft(draft({
      requiresApproval: true,
      riskLevel: 'external_write' as any,
      steps: [
        { title: 'Draft', kind: 'generate', input: {} },
        { title: 'Reply', kind: 'tool', toolName: 'slack.replyInThread', input: {} }
      ]
    }), registry);
    expect(plan.requiresApproval).toBe(false);
    expect(plan.riskLevel).toBe('internal_write');
  });

  it('guarantees generate steps have a prompt and fixes kind-in-toolName', () => {
    const { plan } = normalizePlanDraft(draft({
      steps: [
        { title: 'Summarize the thread', kind: undefined as any, toolName: 'generate', input: {} }
      ]
    }), registry);
    expect(plan.steps[0].kind).toBe('generate');
    expect(plan.steps[0].toolName).toBeUndefined();
    expect(plan.steps[0].input.prompt).toBe('Summarize the thread');
  });
});
