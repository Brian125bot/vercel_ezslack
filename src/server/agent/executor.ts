import type { AgentRun, AgentStep } from '../storage/types.js';
import { agentStore } from '../storage/agentStore.js';
import { toolsRegistry } from '../tools/registry.js';
import { checkPolicy } from './policy.js';
import { slog } from './log.js';
import type { ToolExecutionContext, StepKind } from './types.js';
import { geminiCall } from './geminiClient.js';
import { resolveModel } from './models.js';

const TOOL_TIMEOUT_MS = parseInt(process.env.TOOL_TIMEOUT_MS || '60000');

/**
 * WS3 — Multistep state isolation.
 * Return the steps that belong to the SAME plan iteration as `step`, so that
 * upstream-output gathering and reply injection never pull in stale steps from
 * an abandoned earlier plan (whose order_index restarts at 1).
 */
async function getSiblingSteps(run: AgentRun, step: AgentStep) {
  if (step.plan_id) return agentStore.getStepsForPlan(step.plan_id);
  return agentStore.getStepsForRun(run.id);
}

/**
 * Runs a `generate` step: calls Gemini with a prompt (and optional upstream
 * step outputs) to produce free-form content at *execution* time.  The
 * generated text is stored in the step's `output.generated` field so
 * downstream steps (e.g. `slack.replyInThread`) can consume it.
 */
async function executeGenerateStep(
  run: AgentRun,
  step: AgentStep,
  context: ToolExecutionContext
): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    await agentStore.updateStepStatus(step.id, 'failed', { error: 'GEMINI_API_KEY not configured' });
    return;
  }

  const stepInput = step.input as any;
  const prompt = stepInput?.prompt || stepInput?.input?.prompt || '';

  // Gather outputs of all preceding succeeded steps for context (current plan only)
  const priorSteps = await getSiblingSteps(run, step);
  const upstreamOutputs = priorSteps
    .filter(s => s.order_index < step.order_index && s.status === 'succeeded' && s.output)
    .map(s => `[${s.title}]: ${JSON.stringify(s.output)}`)
    .join('\n');

  const goal = await agentStore.getGoal(run.goal_id);

  const fullPrompt = `You are an AI agent executing a step titled "${step.title}" for the goal: "${goal.original_instruction}".
${upstreamOutputs ? `\nUpstream step outputs:\n${upstreamOutputs}\n` : ''}
${prompt ? `Additional instructions: ${prompt}` : ''}

Generate the requested content. Be concise and use Slack-compatible markdown.`;

  try {
    const responseText = await geminiCall({
      model: resolveModel(run.model),
      contents: fullPrompt,
      label: 'generateStep'
    });

    const generatedText = responseText || '(Empty generation)';
    await agentStore.updateStepStatus(step.id, 'succeeded', {
      output: { generated: generatedText }
    });
    // Also persist the generated text into the step input so downstream steps
    // can reference it via updateStepInput pattern
    await agentStore.updateStepInput(step.id, {
      ...(step.input as any),
      _generatedOutput: generatedText
    });

    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'step.generated',
      actor: 'system',
      summary: `Generate step succeeded: ${step.title}`,
      payload: { generatedLength: generatedText.length }
    });
  } catch (err: any) {
    await agentStore.updateStepStatus(step.id, 'failed', { error: err.message });
    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'step.failed',
      actor: 'system',
      summary: `Generate step failed: ${err.message}`,
      payload: { error: err.message }
    });
  }
}

export async function executeStep(
  run: AgentRun, 
  step: AgentStep, 
  context: ToolExecutionContext
): Promise<void> {
  await agentStore.updateStepStatus(step.id, 'running');
  const stepKind: StepKind = (step.input as any)?.kind || 'tool';

  // ── W3-A: generate step kind ──────────────────────────────────
  if (stepKind === 'generate') {
    await executeGenerateStep(run, step, context);
    return;
  }

  // ── Note step (existing W1 behaviour) ─────────────────────────
  if (stepKind === 'note' || (!step.input || !(step.input as any).toolName)) {
    if (stepKind === 'note') {
      await agentStore.updateStepStatus(step.id, 'succeeded', { output: { message: 'Step completed (conceptual note)' } });
      await agentStore.appendAuditEvent({
        workspace_id: context.workspaceId,
        goal_id: run.goal_id,
        run_id: run.id,
        step_id: step.id,
        type: 'step.succeeded',
        actor: 'system',
        summary: `Step succeeded: ${step.title} (conceptual)`,
        payload: {}
      });
      return;
    } else {
      await agentStore.updateStepStatus(step.id, 'failed', { error: 'No tool specified and not a note step' });
      await agentStore.appendAuditEvent({
        workspace_id: context.workspaceId,
        goal_id: run.goal_id,
        run_id: run.id,
        step_id: step.id,
        type: 'step.failed',
        actor: 'system',
        summary: `Step failed: No tool specified for action step`,
        payload: { error: 'Unsupported / no-tool step cannot succeed' }
      });
      return;
    }
  }

  // ── Tool step ─────────────────────────────────────────────────
  const toolName = (step.input as any).toolName;
  let toolInput = (step.input as any).input || {};

  // Generic generate-step output injection: a "generate" step can declare
  // `injectInto` (a field name) to route its output into the NEXT tool step's
  // input under that field. If no `injectInto` was set anywhere upstream,
  // fall back to the original slack.replyInThread "text" behavior for
  // backward compatibility with existing plans.
  {
    const priorSteps = await getSiblingSteps(run, step);
    const candidateGeneratedSteps = priorSteps
      .filter(s => s.order_index < step.order_index && s.status === 'succeeded' && (s.output as any)?.generated)
      .reverse(); // most recent generate step first

    // Look for a generate step that explicitly targets this step via injectInto
    const explicitMatch = candidateGeneratedSteps.find(s => {
      const declaredInjectInto = (s.input as any)?.injectInto;
      return typeof declaredInjectInto === 'string' && declaredInjectInto.length > 0;
    });

    if (explicitMatch) {
      const fieldName = (explicitMatch.input as any).injectInto as string;
      const generatedText = (explicitMatch.output as any).generated;
      toolInput = { ...toolInput, [fieldName]: generatedText };
      await agentStore.updateStepInput(step.id, { ...(step.input as any), input: toolInput });
    } else if (toolName === 'slack.replyInThread') {
      // Backward-compatible default: no explicit injectInto was set anywhere,
      // but this is a Slack reply step immediately following a generate step —
      // preserve the original behavior exactly.
      const generatedStep = candidateGeneratedSteps[0];
      if (generatedStep) {
        const generatedText = (generatedStep.output as any).generated;
        toolInput = { ...toolInput, text: generatedText };
        await agentStore.updateStepInput(step.id, { ...(step.input as any), input: toolInput });
      }
    }
  }

  const tool = toolsRegistry.get(toolName);
  if (!tool) {
    await agentStore.updateStepStatus(step.id, 'failed', { error: `Tool not found: ${toolName}` });
    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'step.failed',
      actor: 'system',
      summary: `Step failed: Tool not found: ${toolName}`,
      payload: { error: `Tool not found: ${toolName}` }
    });
    return;
  }

  const toolCall = await agentStore.createToolCall({
    run_id: run.id,
    step_id: step.id,
    tool_name: tool.name,
    input: toolInput,
    status: 'created',
    risk_level: tool.riskLevel
  });

  await agentStore.appendAuditEvent({
    workspace_id: context.workspaceId,
    goal_id: run.goal_id,
    run_id: run.id,
    step_id: step.id,
    type: 'tool.created',
    actor: 'system',
    summary: `Created tool call for ${tool.name}`,
    payload: { toolInput }
  });
  
  await agentStore.updateStepStatus(step.id, 'running', { tool_call_id: toolCall.id });
  await agentStore.updateToolCallStatus(toolCall.id, 'running');

  await agentStore.appendAuditEvent({
    workspace_id: context.workspaceId,
    goal_id: run.goal_id,
    run_id: run.id,
    step_id: step.id,
    type: 'tool.started',
    actor: 'system',
    summary: `Started tool execution: ${tool.name}`,
    payload: {}
  });

  let policy = checkPolicy(tool.riskLevel, tool.name);
  
  if (context.preApproved && tool.riskLevel === 'external_write') {
    policy = { allowed: true, requiresApproval: false, reason: 'Pre-approved from plan' };
    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'policy.preapproved',
      actor: 'system',
      summary: `Pre-approved outer external_write policy for ${tool.name}`,
      payload: {}
    });
  }

  if (!policy.allowed) {
    if (policy.requiresApproval) {
      // W3-C: Post Block Kit approval message to Slack
      const { postApprovalBlockKit } = await import('../tools/slack.js');
      const approval = await agentStore.createApprovalRequest({
        goal_id: run.goal_id,
        run_id: run.id,
        step_id: step.id,
        tool_call_id: toolCall.id,
        requested_from_user_id: context.userId,
        channel_id: context.channelId,
        message_ts: context.messageTs,
        title: `Approve execution of ${tool.name}`,
        description: policy.reason,
        risk_level: tool.riskLevel,
        proposed_action: { tool: tool.name, input: toolInput },
        status: 'pending',
        expires_at: new Date(Date.now() + 30 * 60 * 1000)
      });

      try {
        // Post interactive Block Kit approval message
        await postApprovalBlockKit(approval, context);

        await agentStore.appendAuditEvent({
          workspace_id: context.workspaceId,
          goal_id: run.goal_id,
          run_id: run.id,
          step_id: step.id,
          type: 'approval.requested',
          actor: 'system',
          summary: `Approval requested for tool ${tool.name} due to ${policy.reason}`,
          payload: { approvalId: approval.id }
        });

        await agentStore.updateToolCallStatus(toolCall.id, 'requires_approval', { approval_id: approval.id, error: policy.reason });
        await agentStore.updateStepStatus(step.id, 'blocked', { error: policy.reason });
      } catch (err: any) {
        slog('executor', 'postApprovalBlockKit.error', { run_id: run.id, step_id: step.id, err: err.message });
        await agentStore.updateApprovalStatus(approval.id, 'failed');
        await agentStore.updateToolCallStatus(toolCall.id, 'failed', { error: `Failed to post approval to Slack: ${err.message}` });
        await agentStore.updateStepStatus(step.id, 'failed', { error: `Failed to post approval to Slack: ${err.message}` });
        throw err;
      }
    } else {
      await agentStore.appendAuditEvent({
        workspace_id: context.workspaceId,
        goal_id: run.goal_id,
        run_id: run.id,
        step_id: step.id,
        type: 'policy.blocked',
        actor: 'system',
        summary: `Policy blocked execution of ${tool.name}`,
        payload: { reason: policy.reason }
      });

      await agentStore.updateToolCallStatus(toolCall.id, 'blocked', { error: policy.reason });
      await agentStore.updateStepStatus(step.id, 'blocked', { error: policy.reason });
    }
    return;
  }

  await agentStore.appendAuditEvent({
    workspace_id: context.workspaceId,
    goal_id: run.goal_id,
    run_id: run.id,
    step_id: step.id,
    type: 'policy.allowed',
    actor: 'system',
    summary: `Policy allowed execution of ${tool.name}`,
    payload: { reason: policy.reason }
  });

  try {
    // Wrap tool execution with timeout to prevent hung external API calls from blocking
    let timer: ReturnType<typeof setTimeout> | null = null;
    let output: any;
    try {
      output = await Promise.race([
        tool.execute(toolInput, context),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Tool ${toolName} timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    await agentStore.updateToolCallStatus(toolCall.id, 'succeeded', { output });
    await agentStore.updateStepStatus(step.id, 'succeeded', { output });

    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'tool.succeeded',
      actor: 'system',
      summary: `Tool call ${tool.name} succeeded`,
      payload: { output }
    });

    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'step.succeeded',
      actor: 'system',
      summary: `Step succeeded: ${step.title}`,
      payload: {}
    });
  } catch (err: any) {
    await agentStore.updateToolCallStatus(toolCall.id, 'failed', { error: err.message });
    await agentStore.updateStepStatus(step.id, 'failed', { error: err.message });

    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'tool.failed',
      actor: 'system',
      summary: `Tool call ${tool.name} failed: ${err.message}`,
      payload: { error: err.message }
    });

    await agentStore.appendAuditEvent({
      workspace_id: context.workspaceId,
      goal_id: run.goal_id,
      run_id: run.id,
      step_id: step.id,
      type: 'step.failed',
      actor: 'system',
      summary: `Step failed: ${step.title}`,
      payload: { error: err.message }
    });
  }
}
