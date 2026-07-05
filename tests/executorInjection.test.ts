import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeStep } from '../src/server/agent/executor.js';
import { agentStore } from '../src/server/storage/agentStore.js';
import { toolsRegistry } from '../src/server/tools/registry.js';

// Hoisted mocks for module-level references
vi.mock('../src/server/storage/agentStore.js', () => {
  return {
    agentStore: {
      updateStepStatus: vi.fn(),
      updateStepInput: vi.fn(),
      createToolCall: vi.fn().mockResolvedValue({ id: 'tc-123' }),
      updateToolCallStatus: vi.fn(),
      appendAuditEvent: vi.fn(),
      getStepsForRun: vi.fn(),
      getStepsForPlan: vi.fn()
    }
  };
});

vi.mock('../src/server/tools/registry.js', () => {
  return {
    toolsRegistry: {
      get: vi.fn()
    }
  };
});

// Avoid executing real generate logic in tests (it calls gemini)
vi.mock('../src/server/agent/geminiClient.js', () => ({
  geminiCall: vi.fn().mockResolvedValue('{"generated": "Mock generate"}')
}));

describe('generate-step output injection (executor)', () => {

  const runFixture = { id: 'run-1', goal_id: 'goal-1' };
  const contextFixture = {
    runId: 'run-1',
    stepId: 'step-2',
    workspaceId: 'w-1',
    channelId: 'c-1',
    userId: 'u-1',
    messageTs: '123'
  };

  const mockTool = {
    name: 'mock.tool',
    description: 'Mock',
    riskLevel: 'read',
    requiresApproval: false,
    execute: vi.fn().mockResolvedValue({ success: true })
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (toolsRegistry.get as any).mockReturnValue(mockTool);
  });

  it('injects generated output into slack.replyInThread text field when no injectInto is set (backward compatibility)', async () => {
    const priorGenerateStep = {
      id: 'step-1',
      order_index: 1,
      status: 'succeeded',
      input: { kind: 'generate' },
      output: { generated: 'Hello world' }
    };
    (agentStore.getStepsForRun as any).mockResolvedValue([priorGenerateStep]);

    (toolsRegistry.get as any).mockReturnValue({
        ...mockTool,
        name: 'slack.replyInThread'
    });

    const targetStep = {
      id: 'step-2',
      order_index: 2,
      status: 'pending',
      input: {
        kind: 'tool',
        toolName: 'slack.replyInThread',
        input: { text: '' }
      }
    };

    await executeStep(runFixture as any, targetStep as any, contextFixture as any);

    // Assert toolInput.text === "Hello world"
    expect(agentStore.updateStepInput).toHaveBeenCalledWith('step-2', {
      kind: 'tool',
      toolName: 'slack.replyInThread',
      input: { text: 'Hello world' }
    });
  });

  it('injects generated output into an explicit injectInto field for a non-Slack tool', async () => {
    const priorGenerateStep = {
      id: 'step-1',
      order_index: 1,
      status: 'succeeded',
      input: { kind: 'generate', injectInto: 'body' },
      output: { generated: 'Bug description text' }
    };
    (agentStore.getStepsForRun as any).mockResolvedValue([priorGenerateStep]);

    (toolsRegistry.get as any).mockReturnValue({
        ...mockTool,
        name: 'github.createIssue'
    });

    const targetStep = {
      id: 'step-2',
      order_index: 2,
      status: 'pending',
      input: {
        kind: 'tool',
        toolName: 'github.createIssue',
        input: { owner: 'x', repo: 'y', title: 'Bug', body: '' }
      }
    };

    await executeStep(runFixture as any, targetStep as any, contextFixture as any);

    expect(agentStore.updateStepInput).toHaveBeenCalledWith('step-2', {
      kind: 'tool',
      toolName: 'github.createIssue',
      input: { owner: 'x', repo: 'y', title: 'Bug', body: 'Bug description text' }
    });
  });

  it('explicit injectInto takes precedence even when toolName is slack.replyInThread', async () => {
    const priorGenerateStep = {
      id: 'step-1',
      order_index: 1,
      status: 'succeeded',
      input: { kind: 'generate', injectInto: 'text' },
      output: { generated: 'Explicit path' }
    };
    (agentStore.getStepsForRun as any).mockResolvedValue([priorGenerateStep]);

    (toolsRegistry.get as any).mockReturnValue({
        ...mockTool,
        name: 'slack.replyInThread'
    });

    const targetStep = {
      id: 'step-2',
      order_index: 2,
      status: 'pending',
      input: {
        kind: 'tool',
        toolName: 'slack.replyInThread',
        input: { text: 'Placeholder' }
      }
    };

    await executeStep(runFixture as any, targetStep as any, contextFixture as any);

    expect(agentStore.updateStepInput).toHaveBeenCalledWith('step-2', {
      kind: 'tool',
      toolName: 'slack.replyInThread',
      input: { text: 'Explicit path' } // it gets overwritten
    });
  });

  it('does not inject anything when no prior generate step exists', async () => {
    (agentStore.getStepsForRun as any).mockResolvedValue([]);

    const targetStep = {
      id: 'step-2',
      order_index: 2,
      status: 'pending',
      input: {
        kind: 'tool',
        toolName: 'github.createIssue',
        input: { owner: 'x', repo: 'y', title: 'Bug', body: '' }
      }
    };

    await executeStep(runFixture as any, targetStep as any, contextFixture as any);

    // updateStepInput shouldn't be called if nothing injected
    expect(agentStore.updateStepInput).not.toHaveBeenCalled();
    // But createToolCall should be called with original input
    expect(agentStore.createToolCall).toHaveBeenCalledWith(expect.objectContaining({
        input: { owner: 'x', repo: 'y', title: 'Bug', body: '' }
    }));
  });

  it('only the most recent matching generate step is used when multiple exist', async () => {
    const olderGenerateStep = {
      id: 'step-1',
      order_index: 1,
      status: 'succeeded',
      input: { kind: 'generate', injectInto: 'body' },
      output: { generated: 'Old text' }
    };
    const newerGenerateStep = {
      id: 'step-2',
      order_index: 2,
      status: 'succeeded',
      input: { kind: 'generate', injectInto: 'body' },
      output: { generated: 'New text' }
    };
    (agentStore.getStepsForRun as any).mockResolvedValue([olderGenerateStep, newerGenerateStep]);

    const targetStep = {
      id: 'step-3',
      order_index: 3,
      status: 'pending',
      input: {
        kind: 'tool',
        toolName: 'mock.tool',
        input: { body: '' }
      }
    };

    await executeStep(runFixture as any, targetStep as any, contextFixture as any);

    expect(agentStore.updateStepInput).toHaveBeenCalledWith('step-3', {
      kind: 'tool',
      toolName: 'mock.tool',
      input: { body: 'New text' }
    });
  });

  it('a generate step with injectInto pointing to a field name does not affect unrelated tool steps', async () => {
    const priorGenerateStep = {
      id: 'step-1',
      order_index: 1,
      status: 'succeeded',
      input: { kind: 'generate', injectInto: 'body' },
      output: { generated: 'Injected text' }
    };
    (agentStore.getStepsForRun as any).mockResolvedValue([priorGenerateStep]);

    const targetStep = {
      id: 'step-2',
      order_index: 2,
      status: 'pending',
      input: {
        kind: 'tool',
        toolName: 'slack.replyInThread',
        input: { text: '' } // No body field in the schema
      }
    };

    await executeStep(runFixture as any, targetStep as any, contextFixture as any);

    expect(agentStore.updateStepInput).toHaveBeenCalledWith('step-2', {
      kind: 'tool',
      toolName: 'slack.replyInThread',
      input: { text: '', body: 'Injected text' } // Field added blindly
    });
  });
});
