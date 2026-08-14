import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Mocks ----
const { mockAgentStore, mockGeminiCall, mockExistsSync, mockReaddirSync, mockReadFileSync } = vi.hoisted(() => ({
  mockAgentStore: {
    getGoal: vi.fn(),
    getRun: vi.fn(),
    getStepsForPlan: vi.fn(),
    updateStepStatus: vi.fn(),
    updateStepInput: vi.fn(),
    createStep: vi.fn(),
    appendAuditEvent: vi.fn(),
    listSkills: vi.fn(),
  },
  mockGeminiCall: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockReadFileSync: vi.fn()
}));

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: mockAgentStore
}));

vi.mock('../src/server/agent/geminiClient.js', () => ({
  geminiCall: mockGeminiCall
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync
}));

import { Semaphore } from '../src/server/agent/semaphore.js';
import { loadSkillsForWorkspace, formatSkillsForPrompt } from '../src/server/agent/skills.js';
import {
  isAllowedModel,
  resolveModel,
  getContextWindowTokens,
  getMaxOutputTokens
} from '../src/server/agent/models.js';
import { verifySemantically } from '../src/server/agent/semanticVerifier.js';
import { verifyRun } from '../src/server/agent/verifier.js';
import { normalizeRiskLevel, normalizePlanDraft } from '../src/server/agent/planNormalize.js';
import { mutatePlan } from '../src/server/agent/planMutation.js';

describe('agent-extra.test.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'mock-key';
  });

  describe('Semaphore', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('throws if permits < 1', () => {
      expect(() => new Semaphore(0)).toThrow();
    });

    it('acquires and releases permits correctly', async () => {
      const sem = new Semaphore(2);
      expect(sem.available).toBe(2);
      expect(sem.waiting).toBe(0);

      const acq1 = await sem.acquire();
      expect(acq1).toBe(true);
      expect(sem.available).toBe(1);

      const acq2 = await sem.acquire();
      expect(acq2).toBe(true);
      expect(sem.available).toBe(0);

      // Next acquire should wait or fail with timeout
      const promiseAcq3Timeout = sem.acquire(10);
      vi.advanceTimersByTime(15);
      const acq3 = await promiseAcq3Timeout;
      expect(acq3).toBe(false);

      let resolvedAcq4 = false;
      const promiseAcq4 = sem.acquire().then((res) => {
        resolvedAcq4 = res;
        return res;
      });

      expect(sem.waiting).toBe(1);

      sem.release();
      await promiseAcq4;
      expect(resolvedAcq4).toBe(true);
      expect(sem.available).toBe(0);
      expect(sem.waiting).toBe(0);

      sem.release();
      expect(sem.available).toBe(1);
    });
  });

  describe('Skills Loader', () => {
    it('loads builtin and DB skills', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['skill1.md', 'skill2.SKILL.md', 'other.txt']);
      mockReadFileSync.mockReturnValue('builtin-content');

      mockAgentStore.listSkills.mockResolvedValueOnce([
        { name: 'db-workspace-skill', content: 'workspace-content' }
      ]);
      mockAgentStore.listSkills.mockResolvedValueOnce([
        { name: 'db-user-skill', content: 'user-content', user_id: 'user-123' }
      ]);

      const skills = await loadSkillsForWorkspace('ws-1', 'user-123');
      expect(skills).toHaveLength(4);
      expect(skills[0]).toEqual({ name: 'skill1', content: 'builtin-content', source: 'builtin' });
      expect(skills[1]).toEqual({ name: 'skill2', content: 'builtin-content', source: 'builtin' });
      expect(skills[2]).toEqual({ name: 'db-workspace-skill', content: 'workspace-content', source: 'workspace' });
      expect(skills[3]).toEqual({ name: 'db-user-skill', content: 'user-content', source: 'user', userId: 'user-123' });
    });

    it('formats skills for prompt', () => {
      const skills: any[] = [
        { name: 'skill-1', content: 'content-1', source: 'builtin' },
        { name: 'skill-2', content: 'content-2', source: 'user', userId: 'u1' }
      ];

      const formatted = formatSkillsForPrompt(skills);
      expect(formatted).toContain('<skills>');
      expect(formatted).toContain('--- SKILL: skill-1 (builtin) ---');
      expect(formatted).toContain('--- SKILL: skill-2 (user, user:u1) ---');
      expect(formatted).toContain('content-2');
    });

    it('returns empty string if formatting empty skills array', () => {
      expect(formatSkillsForPrompt([])).toBe('');
    });
  });

  describe('Models configuration', () => {
    it('checks allowed models', () => {
      expect(isAllowedModel('gemini-3.7-flash')).toBe(true);
      expect(isAllowedModel('gemini-2.5-flash')).toBe(true);
      expect(isAllowedModel('gemini-unknown')).toBe(false);
      expect(isAllowedModel(null)).toBe(false);
    });

    it('resolves model to safe default', () => {
      expect(resolveModel('gemini-3.7-flash')).toBe('gemini-3.7-flash');
      expect(resolveModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
      expect(resolveModel('gemini-unknown')).toBe('gemini-2.5-flash');
    });

    it('retrieves context window tokens', () => {
      expect(getContextWindowTokens('gemini-3.7-flash')).toBe(1_000_000);
      expect(getContextWindowTokens('gemini-3.5-flash')).toBe(1_000_000);
      expect(getContextWindowTokens('gemini-3.1-flash-lite')).toBe(128_000);
    });

    it('retrieves max output tokens', () => {
      expect(getMaxOutputTokens('gemini-3.7-flash')).toBe(8192);
      expect(getMaxOutputTokens('gemini-3.5-flash')).toBe(8192);
      expect(getMaxOutputTokens('gemini-3.1-flash-lite')).toBe(4096);
      expect(getMaxOutputTokens('gemini-unknown')).toBe(8192);
    });
  });

  describe('Semantic Verifier', () => {
    it('returns skipped/satisfied result when GEMINI_API_KEY is missing', async () => {
      delete process.env.GEMINI_API_KEY;
      const trace: any = { goal: { original_instruction: 'help' }, steps: [], toolCalls: [] };

      const res = await verifySemantically(trace, 'flash');
      expect(res).toEqual({
        satisfied: true,
        confidence: 0,
        reasoning: 'Skipped semantic verification because GEMINI_API_KEY is not configured.',
        source: 'skipped'
      });
    });

    it('performs semantic verification and returns satisfied result from LLM', async () => {
      mockGeminiCall.mockResolvedValue(JSON.stringify({
        satisfied: true,
        confidence: 0.95,
        reasoning: 'Everything is done perfectly.'
      }));

      const trace: any = {
        goal: { original_instruction: 'deploy app' },
        steps: [{ title: 'step 1', status: 'succeeded', output: 'ok' }],
        toolCalls: [{ tool_name: 'git', status: 'success', input: 'push', output: 'done' }]
      };

      const res = await verifySemantically(trace, 'flash');
      expect(res).toEqual({
        satisfied: true,
        confidence: 0.95,
        reasoning: 'Everything is done perfectly.',
        source: 'llm'
      });
    });

    it('returns inconclusive verification on error/exceptions', async () => {
      mockGeminiCall.mockRejectedValue(new Error('Gemini offline'));
      const trace: any = { goal: { original_instruction: 'help' }, steps: [], toolCalls: [] };

      const res = await verifySemantically(trace, 'flash');
      expect(res.satisfied).toBe(true);
      expect(res.confidence).toBe(0);
      expect(res.source).toBe('skipped');
    });
  });

  describe('Rule-Based Verifier', () => {
    it('returns status not_satisfied when there are no steps', () => {
      const trace: any = { steps: [] };
      const res = verifyRun(trace);
      expect(res.status).toBe('not_satisfied');
      expect(res.recommendedNextAction).toBe('replan');
    });

    it('returns blocked if plan requires approval but is pending/rejected', () => {
      const trace: any = {
        plan: { risks: { requiresApproval: true } },
        steps: [{ title: 'step A', status: 'blocked' }],
        approvals: [{ status: 'pending' }]
      };
      const res = verifyRun(trace);
      expect(res.status).toBe('blocked');
      expect(res.recommendedNextAction).toBe('block');
    });

    it('returns blocked if plan requires approval array but hasApproved is missing', () => {
      const trace: any = {
        plan: { risks: [{ requiresApproval: true }] },
        steps: [{ title: 'step A', status: 'blocked' }],
        approvals: []
      };
      const res = verifyRun(trace);
      expect(res.status).toBe('blocked');
    });

    it('returns satisfied when all steps succeed', () => {
      const trace: any = {
        steps: [{ title: 'step A', status: 'succeeded' }]
      };
      const res = verifyRun(trace);
      expect(res.status).toBe('satisfied');
    });

    it('returns not_satisfied/retry if a slack.replyInThread step fails', () => {
      const trace: any = {
        steps: [{ title: 'step A', status: 'failed', error: 'Network error', input: { toolName: 'slack.replyInThread' } }]
      };
      const res = verifyRun(trace);
      expect(res.status).toBe('not_satisfied');
      expect(res.recommendedNextAction).toBe('retry');
    });

    it('returns partially_satisfied when not all steps are succeeded or blocked', () => {
      const trace: any = {
        steps: [
          { title: 'step A', status: 'succeeded' },
          { title: 'step B', status: 'failed', error: 'some error' }
        ]
      };
      const res = verifyRun(trace);
      expect(res.status).toBe('partially_satisfied');
      expect(res.recommendedNextAction).toBe('ask_user');
    });
  });

  describe('Plan Normalization', () => {
    it('normalizes risk levels', () => {
      expect(normalizeRiskLevel('safe')).toBe('read');
      expect(normalizeRiskLevel('internal')).toBe('internal_write');
      expect(normalizeRiskLevel('write')).toBe('external_write');
      expect(normalizeRiskLevel('severe')).toBe('destructive');
      expect(normalizeRiskLevel('other')).toBe('internal_write');
    });

    it('normalizes plan drafts and handles unknown tools', () => {
      const draft: any = {
        summary: 'test-summary',
        riskLevel: 'high',
        steps: [
          { title: 'step 1', kind: 'generate', input: { prompt: 'generate something' }, injectInto: 'foo' },
          { title: 'step 2', kind: 'note' },
          { title: 'step 3', kind: 'tool', toolName: 'unknown-tool' },
          { title: 'step 4', kind: 'tool', toolName: 'known-tool', input: { something: 123 } }
        ]
      };

      const toolsMock: any = {
        get: vi.fn((name) => {
          if (name === 'known-tool') return { name, riskLevel: 'read' };
          return undefined;
        })
      };

      const result = normalizePlanDraft(draft, toolsMock);
      expect(result.redactedTools).toContain('unknown-tool');
      expect(result.plan.steps[2].kind).toBe('note');
      expect(result.plan.steps[3].kind).toBe('tool');
      expect(result.plan.requiresApproval).toBe(false);
    });
  });

  describe('Plan Mutation', () => {
    it('fails when GEMINI_API_KEY is missing', async () => {
      delete process.env.GEMINI_API_KEY;
      const res = await mutatePlan('r1', 'p1', 'add step', 'flash');
      expect(res.success).toBe(false);
      expect(res.summary).toContain('GEMINI_API_KEY not configured');
    });

    it('fails when plan has no steps', async () => {
      mockAgentStore.getStepsForPlan.mockResolvedValue([]);
      mockAgentStore.getRun.mockResolvedValue({ goal_id: 'g1' });
      mockAgentStore.getGoal.mockResolvedValue({ title: 'test-goal' });

      const res = await mutatePlan('r1', 'p1', 'add step', 'flash');
      expect(res.success).toBe(false);
      expect(res.summary).toContain('Plan has no steps to mutate');
    });

    it('interprets and applies LLM mutation instructions (add, remove, modify, replace)', async () => {
      const step1 = { id: 's1', order_index: 1, status: 'pending', title: 'step 1', input: {} };
      const step2 = { id: 's2', order_index: 2, status: 'pending', title: 'step 2', input: {} };
      const step3 = { id: 's3', order_index: 3, status: 'pending', title: 'step 3', input: {} };

      mockAgentStore.getStepsForPlan.mockResolvedValue([step1, step2, step3]);
      mockAgentStore.getRun.mockResolvedValue({ goal_id: 'g1' });
      mockAgentStore.getGoal.mockResolvedValue({ title: 'test-goal', original_instruction: 'do test' });

      mockGeminiCall.mockResolvedValue(JSON.stringify({
        summary: 'Modified steps',
        mutations: [
          { action: 'remove', stepIndex: 0, reason: 'unneeded' },
          { action: 'modify', stepIndex: 1, newTitle: 'mod title', newInput: { key: 'val' }, reason: 'change parameter' },
          { action: 'replace', stepIndex: 2, newTitle: 'new title', newKind: 'generate', reason: 'rewrite' },
          { action: 'add', newTitle: 'added step', newKind: 'note', reason: 'extra' }
        ]
      }));

      const res = await mutatePlan('r1', 'p1', 'please modify plan', 'flash');
      expect(res.success).toBe(true);
      expect(res.summary).toBe('Modified steps');

      expect(mockAgentStore.updateStepStatus).toHaveBeenCalledWith('s1', 'skipped', expect.any(Object));
      expect(mockAgentStore.updateStepInput).toHaveBeenCalledWith('s2', expect.objectContaining({ title: 'mod title' }));
      expect(mockAgentStore.createStep).toHaveBeenCalledTimes(2); // replace and add
    });
  });
});
