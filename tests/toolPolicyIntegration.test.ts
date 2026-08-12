import { describe, it, expect, vi } from 'vitest';
import { toolsRegistry } from '../src/server/tools/registry.js';
import { executeStep } from '../src/server/agent/executor.js';
import { agentStore } from '../src/server/storage/agentStore.js';
import type { AgentRun, AgentStep } from '../src/server/storage/types.js';
import type { ToolExecutionContext } from '../src/server/agent/types.js';

describe('Tool Policy Integration', () => {
  describe('ToolRegistry Scoping', () => {
    it('filters tools with getAllowed correctly', () => {
      const allowedTools = ['slack.replyInThread', 'memory.write'];
      const filtered = toolsRegistry.getAllowed(allowedTools);
      const names = filtered.map(t => t.name);

      expect(names).toContain('slack.replyInThread');
      expect(names).toContain('memory.write');
      expect(names).not.toContain('sandbox.exec');
    });

    it('returns all tools when allowedTools is null', () => {
      const filtered = toolsRegistry.getAllowed(null);
      expect(filtered.length).toBe(toolsRegistry.getAll().length);
    });

    it('getScoped returns the tool when allowed or null', () => {
      const allowedTools = ['slack.replyInThread'];
      const { tool: allowedTool, deniedByPolicy: denied1 } = toolsRegistry.getScoped('slack.replyInThread', allowedTools);
      expect(allowedTool).toBeDefined();
      expect(allowedTool?.name).toBe('slack.replyInThread');
      expect(denied1).toBe(false);

      const { tool: unscopedTool, deniedByPolicy: denied2 } = toolsRegistry.getScoped('slack.replyInThread', null);
      expect(unscopedTool).toBeDefined();
      expect(denied2).toBe(false);
    });

    it('getScoped returns undefined and deniedByPolicy: true when tool exists but is disallowed', () => {
      const allowedTools = ['slack.replyInThread'];
      const { tool, deniedByPolicy } = toolsRegistry.getScoped('sandbox.exec', allowedTools);
      expect(tool).toBeUndefined();
      expect(deniedByPolicy).toBe(true);
    });

    it('getScoped returns undefined and deniedByPolicy: false when tool does not exist at all', () => {
      const allowedTools = ['slack.replyInThread'];
      const { tool, deniedByPolicy } = toolsRegistry.getScoped('non_existent_tool', allowedTools);
      expect(tool).toBeUndefined();
      expect(deniedByPolicy).toBe(false);
    });
  });

  describe('executeStep integration (Plan-based Executor)', () => {
    it('allows execution when allowedTools is null (default unrestricted)', async () => {
      // Mock step and run
      const mockRun: AgentRun = {
        id: 'r-1',
        goal_id: 'g-1',
        status: 'running',
        model: 'gemini-3.1-flash-lite',
        created_at: new Date(),
        updated_at: new Date()
      };
      const mockStep: AgentStep = {
        id: 's-1',
        run_id: 'r-1',
        plan_id: 'p-1',
        order_index: 1,
        title: 'Send Slack reply',
        status: 'pending',
        input: { kind: 'tool', toolName: 'slack.replyInThread', input: { text: 'Hello' } },
        created_at: new Date()
      };
      const mockContext: ToolExecutionContext = {
        runId: 'r-1',
        stepId: 's-1',
        workspaceId: 'w-1',
        channelId: 'c-1',
        userId: 'u-1',
        messageTs: '123.456',
        allowedTools: null // unrestricted
      };

      // Spy on agentStore and tool execute
      const updateStepStatusSpy = vi.spyOn(agentStore, 'updateStepStatus').mockResolvedValue({} as any);
      const createToolCallSpy = vi.spyOn(agentStore, 'createToolCall').mockResolvedValue({ id: 'tc-1' } as any);
      const updateToolCallStatusSpy = vi.spyOn(agentStore, 'updateToolCallStatus').mockResolvedValue({} as any);
      const appendAuditSpy = vi.spyOn(agentStore, 'appendAuditEvent').mockResolvedValue({} as any);

      const tool = toolsRegistry.get('slack.replyInThread')!;
      const executeSpy = vi.spyOn(tool, 'execute').mockResolvedValue({ ok: true });

      await executeStep(mockRun, mockStep, mockContext);

      expect(executeSpy).toHaveBeenCalled();
      expect(updateStepStatusSpy).toHaveBeenCalledWith('s-1', 'succeeded', expect.any(Object));

      updateStepStatusSpy.mockRestore();
      createToolCallSpy.mockRestore();
      updateToolCallStatusSpy.mockRestore();
      appendAuditSpy.mockRestore();
      executeSpy.mockRestore();
    });

    it('rejects execution and logs step.policy_denied when tool is not allowed', async () => {
      const mockRun: AgentRun = {
        id: 'r-1',
        goal_id: 'g-1',
        status: 'running',
        model: 'gemini-3.1-flash-lite',
        created_at: new Date(),
        updated_at: new Date()
      };
      const mockStep: AgentStep = {
        id: 's-1',
        run_id: 'r-1',
        plan_id: 'p-1',
        order_index: 1,
        title: 'Run sandbox command',
        status: 'pending',
        input: { kind: 'tool', toolName: 'sandbox.exec', input: { cmd: 'ls' } },
        created_at: new Date()
      };
      const mockContext: ToolExecutionContext = {
        runId: 'r-1',
        stepId: 's-1',
        workspaceId: 'w-1',
        channelId: 'c-1',
        userId: 'u-1',
        messageTs: '123.456',
        allowedTools: ['slack.replyInThread'] // sandbox.exec not allowed
      };

      const updateStepStatusSpy = vi.spyOn(agentStore, 'updateStepStatus').mockResolvedValue({} as any);
      const appendAuditSpy = vi.spyOn(agentStore, 'appendAuditEvent').mockResolvedValue({} as any);

      await executeStep(mockRun, mockStep, mockContext);

      // Verify that step failed with generic "Tool not found" text to prevent info leak
      expect(updateStepStatusSpy).toHaveBeenCalledWith('s-1', 'failed', { error: 'Tool not found: sandbox.exec' });

      // Verify policy_denied audit event is logged
      expect(appendAuditSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'step.policy_denied',
        summary: 'Step policy denied: Tool not found: sandbox.exec'
      }));

      updateStepStatusSpy.mockRestore();
      appendAuditSpy.mockRestore();
    });
  });
});
