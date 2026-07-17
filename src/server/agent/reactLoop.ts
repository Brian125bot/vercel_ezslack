/**
 * ReAct agent loop — the core reliability fix for complex tasks.
 *
 * Unlike the single-shot planner (which must pre-specify every tool input up
 * front and cannot observe outputs), this loop lets the model call a tool, read
 * its result, and decide whether to call another tool or produce a final
 * answer. That observation→adapt step is what was missing.
 *
 * The loop is layered *inside* the existing durable run ledger: every model
 * tool-call is persisted as an `agent_steps` + `tool_calls` row, so the
 * existing verifier, reporter, dashboard, and approval flow all keep working
 * unchanged. The conversation turns (`contents[]`) are persisted to
 * `agent_runs.agent_messages` so a run can resume across a serverless re-queue
 * WITHOUT re-executing already-completed side-effecting tools.
 */
import { agentStore } from '../storage/agentStore.js';
import type { AgentRun, AgentGoal } from '../storage/types.js';
import type { ToolExecutionContext } from './types.js';
import { geminiAgentStep } from './geminiClient.js';
import { resolveModel } from './models.js';
import { toolsRegistry } from '../tools/registry.js';
import { checkPolicy } from './policy.js';
import { assembleContext, renderContextForPrompt } from './context.js';
import { attachmentsToGeminiParts } from './attachments.js';
import { slog } from './log.js';
import { loadSkillsForWorkspace, formatSkillsForPrompt, type LoadedSkill } from './skills.js';

const MAX_AGENT_LOOP_TURNS = parseInt(process.env.MAX_AGENT_LOOP_TURNS || '8');
const MAX_TOOL_CALLS_PER_RUN = parseInt(process.env.MAX_TOOL_CALLS_PER_RUN || '10');
const TOOL_TIMEOUT_MS = parseInt(process.env.TOOL_TIMEOUT_MS || '60000');

export type AgentLoopOutcome =
  | { status: 'completed'; finalText: string }
  | { status: 'yield'; reason: 'approval' | 'wall_clock'; messages: any[] }
  | { status: 'capped'; reason: string };

export interface AgentLoopContext {
  /** Wall-clock deadline (epoch ms). Near it, the loop persists messages and yields. */
  deadlineMs: number;
  /** Abort signal tied to the deadline; cancels in-flight Gemini calls. */
  signal: AbortSignal;
  /** Shared execution context (channel/user ids) forwarded to every tool. */
  execContext: ToolExecutionContext;
}

/** Whether the wall-clock deadline is close enough to stop and resume later. */
function nearDeadline(deadlineMs: number, marginMs = 5000): boolean {
  return Date.now() >= deadlineMs - marginMs;
}

/**
 * Run the ReAct loop for a run that has no plan yet. Creates a plan record to
 * scope the steps it writes, then iterates model tool-calls until the model
 * emits a final text answer or a cap/deadline/approval stops it.
 */
export async function runAgentLoop(
  runIn: AgentRun,
  goal: AgentGoal,
  ctx: AgentLoopContext
): Promise<AgentLoopOutcome> {
  let run = runIn;
  const model = resolveModel(run.model);

  // 1) Create (or reuse) a plan to scope the steps the loop writes. The
  //    verifier/reporter key off plan_id, so we need a row.
  let planId = run.plan_id;
  if (!planId) {
    const plan = await agentStore.createPlan({
      goal_id: goal.id,
      version: (run.iteration_count || 1),
      summary: `Agent loop: ${goal.title}`,
      assumptions: [],
      risks: [{ level: 'internal_write', requiresApproval: false }],
      steps: [],
      status: 'active'
    });
    planId = plan.id;
    run = await agentStore.updateRunStatus(run.id, 'running', { plan_id: planId });
    await agentStore.appendAuditEvent({
      workspace_id: goal.workspace_id,
      goal_id: goal.id,
      run_id: run.id,
      type: 'agent_loop.started',
      actor: 'system',
      summary: `ReAct loop started (plan ${planId})`,
      payload: {}
    });
  }

  // 2) Seed conversation contents. On resume, reload persisted turns; otherwise
  //    build the initial user turn from goal + context.
  let contents: any[];
  if (Array.isArray(run.agent_messages) && run.agent_messages.length > 0) {
    contents = run.agent_messages;
    slog('agent_loop', 'resume', { run_id: run.id, existing_turns: contents.length });
  } else {
    const planningCtx = await assembleContext(goal, run);
    const contextBlock = renderContextForPrompt(planningCtx);
    const skills = await loadSkillsForWorkspace(goal.workspace_id, goal.created_by_user_id);
    const systemPrompt = buildSystemPrompt(goal, contextBlock, skills);
    const firstParts = buildFirstUserParts(goal, systemPrompt, planningCtx.attachments);
    contents = [{ role: 'user', parts: firstParts }];
  }

  const toolDeclarations = toolsRegistry.toFunctionDeclarations();
  const tools = toolDeclarations.length > 0 ? [{ functionDeclarations: toolDeclarations }] : undefined;

  let toolCallsMade = await countExistingToolCalls(run.id);
  let stepOrder = 0;
  let outcome: AgentLoopOutcome | null = null;

  for (let turn = 0; turn < MAX_AGENT_LOOP_TURNS; turn++) {
    if (nearDeadline(ctx.deadlineMs)) {
      outcome = { status: 'yield', reason: 'wall_clock', messages: contents };
      break;
    }

    // 3) Ask the model. AUTO mode lets it choose between a tool call and a
    //    natural-language answer using enhanced geminiAgentStep with streaming support.
    let response;
    try {
      response = await geminiAgentStep({
        model,
        contents,
        tools: tools,
        signal: ctx.signal,
        label: 'agentLoop'
      });
    } catch (err: any) {
      // A deadline abort surfaces here as a non-retryable error. Yield so the
      // run resumes with whatever turns we have, rather than failing hard.
      if (ctx.signal.aborted || err.name === 'AbortError') {
        outcome = { status: 'yield', reason: 'wall_clock', messages: contents };
        break;
      }
      throw err;
    }

    // Account for cost.
    if (response.totalTokenCount) {
      await agentStore.addRunTokens(run.id, response.totalTokenCount).catch(() => {});
    }

    // 4) Tool calls → execute each, persist, append functionResponse, continue.
    if (response.functionCalls && response.functionCalls.length > 0) {
      // Record the model's tool-request turn so the next generateContent sees it.
      // Use raw `parts` from the API response to preserve Part-level fields
      // such as thoughtSignature, which the API now requires on functionCall parts.
      contents.push({
        role: 'model',
        parts: response.parts || response.functionCalls.map((fc) => ({ functionCall: { name: fc.name, args: fc.args } }))
      });

      const responseParts: any[] = [];
      for (const fc of response.functionCalls) {
        if (toolCallsMade >= MAX_TOOL_CALLS_PER_RUN) {
          outcome = { status: 'capped', reason: `Exceeded MAX_TOOL_CALLS_PER_RUN (${MAX_TOOL_CALLS_PER_RUN})` };
          break;
        }
        if (nearDeadline(ctx.deadlineMs)) {
          outcome = { status: 'yield', reason: 'wall_clock', messages: contents };
          break;
        }

        const toolResult = await executeOneToolCall(run, goal, planId!, fc.name, fc.args, ctx.execContext, ++stepOrder);
        // A tool call that needed approval yields the whole run.
        if (toolResult.kind === 'approval') {
          await agentStore.updateRunMessages(run.id, contents);
          outcome = { status: 'yield', reason: 'approval', messages: contents };
          break;
        }
        toolCallsMade++;
        responseParts.push({
          functionResponse: { name: fc.name, response: toolResult.response }
        });
      }
      if (outcome) break;

      contents.push({ role: 'user', parts: responseParts });
      // Persist progress so a re-queue resumes from here, not from scratch.
      await agentStore.updateRunMessages(run.id, contents);
      continue;
    }

    // 5) No tool call → final natural-language answer.
    const finalText = response.text?.trim() || '';

    // Record the model's final answer turn so a resume/audit sees the produced
    // answer, then persist it as a terminal step. Without a step for the final
    // answer, the run trace shows only the intermediate tool calls and never the
    // synthesized result — so the semantic verifier concludes the goal was not
    // satisfied and forces an endless replan, which burns durable re-enqueues.
    if (finalText) {
      contents.push({ role: 'model', parts: response.parts || [{ text: finalText }] });
    }
    await agentStore.updateRunMessages(run.id, contents);

    if (finalText) {
      const answerStep = await agentStore.createStep({
        run_id: run.id,
        plan_id: planId!,
        order_index: ++stepOrder,
        title: 'Final answer',
        status: 'succeeded',
        input: { kind: 'generate' },
        output: { generated: finalText }
      });
      await agentStore.appendAuditEvent({
        workspace_id: goal.workspace_id,
        goal_id: goal.id,
        run_id: run.id,
        step_id: answerStep.id,
        type: 'agent_loop.final_answer',
        actor: 'system',
        summary: 'Agent loop produced final answer',
        payload: { chars: finalText.length }
      });
    }

    // WS6: surface the answer to the user as it streams in (post + incremental
    // update). The reporter still posts the structured run report afterwards.
    if (finalText && response.streaming) {
      const { streamReplyToThread } = await import('../tools/slack.js');
      await streamReplyToThread(ctx.execContext, response.streaming).catch((err) =>
        slog('agent_loop', 'stream_reply.error', { run_id: run.id, error: err.message })
      );
    }

    outcome = { status: 'completed', finalText };
    break;
  }

  if (!outcome) {
    outcome = { status: 'capped', reason: `Exceeded MAX_AGENT_LOOP_TURNS (${MAX_AGENT_LOOP_TURNS})` };
  }

  // Always persist the latest contents so a capped/yielded run can resume.
  await agentStore.updateRunMessages(run.id, contents);

  await agentStore.appendAuditEvent({
    workspace_id: goal.workspace_id,
    goal_id: goal.id,
    run_id: run.id,
    type: 'agent_loop.outcome',
    actor: 'system',
    summary: `ReAct loop ended: ${outcome.status}` + (outcome.status === 'capped' ? ` — ${outcome.reason}` : ''),
    payload: { outcome, toolCallsMade, turns: contents.length }
  });

  return outcome;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildSystemPrompt(goal: AgentGoal, contextBlock: string, skills: LoadedSkill[]): string {
  const skillsBlock = formatSkillsForPrompt(skills);

  return [
    'You are a Slack AI agent solving a task by calling tools step by step.',
    'Observe each tool result before deciding the next action.',
    'When you have enough information to fully answer the user, respond with a final message and no tool call.',
    'To deliver your final answer to the user, call the `slack.replyInThread` tool with the reply text.',
    '',
    `Goal: ${goal.title}`,
    goal.original_instruction,
    '',
    contextBlock,
    skillsBlock
  ].join('\n');
}

function buildFirstUserParts(goal: AgentGoal, systemPrompt: string, attachments?: any[]): any[] {
  const textPart = { text: systemPrompt };
  const parts = attachments && attachments.length > 0
    ? [...attachmentsToGeminiParts(attachments), textPart]
    : [textPart];
  return parts;
}

async function countExistingToolCalls(runId: string): Promise<number> {
  const trace = await agentStore.getRunTrace(runId);
  return trace.toolCalls.length;
}

type ToolExecResult =
  | { kind: 'done'; response: Record<string, unknown> }
  | { kind: 'approval' };

/**
 * Execute one model-requested tool call: look up the tool, run the policy gate,
 * persist a step + tool_call (so trace/verifier/reporter see it), and either
 * execute it or suspend for approval. Mirrors executor.ts persistence.
 */
async function executeOneToolCall(
  run: AgentRun,
  goal: AgentGoal,
  planId: string,
  toolName: string,
  args: Record<string, unknown>,
  execContext: ToolExecutionContext,
  orderIndex: number
): Promise<ToolExecResult> {
  const tool = toolsRegistry.get(toolName);

  // Unknown/unconfigured tool: honest failure (the model hallucinated a name).
  if (!tool) {
    const step = await persistLoopStep(run, goal, planId, toolName, args, 'failed', orderIndex, {
      error: `Tool not found: ${toolName}`
    });
    await agentStore.appendAuditEvent({
      workspace_id: goal.workspace_id, goal_id: goal.id, run_id: run.id, step_id: step.id,
      type: 'tool.failed', actor: 'system',
      summary: `Agent loop: unknown tool ${toolName}`,
      payload: { error: `Tool not found: ${toolName}` }
    });
    return {
      kind: 'done',
      response: { error: `Tool "${toolName}" does not exist. Available tools: ${toolsRegistry.getAll().map(t => t.name).join(', ')}` }
    };
  }

  // Persist step + tool_call rows up front (status running), as executor.ts does.
  const step = await agentStore.createStep({
    run_id: run.id,
    plan_id: planId,
    order_index: orderIndex,
    title: `${toolName}`,
    status: 'running',
    input: { kind: 'tool', toolName, input: args }
  });
  const toolCall = await agentStore.createToolCall({
    run_id: run.id,
    step_id: step.id,
    tool_name: tool.name,
    input: args,
    status: 'running',
    risk_level: tool.riskLevel
  });

  // Policy gate.
  let policy = checkPolicy(tool.riskLevel, tool.name);
  // Honor an already-approved step-level approval (resume after approval).
  const priorApproval = await agentStore.getApprovedStepApproval(run.id, step.id).catch(() => null);
  if (priorApproval && tool.riskLevel === 'external_write') {
    policy = { allowed: true, requiresApproval: false, reason: 'Pre-approved' };
  }

  if (!policy.allowed || policy.requiresApproval) {
    if (policy.requiresApproval) {
      const { postApprovalBlockKit } = await import('../tools/slack.js');
      const approval = await agentStore.createApprovalRequest({
        goal_id: goal.id,
        run_id: run.id,
        step_id: step.id,
        tool_call_id: toolCall.id,
        requested_from_user_id: execContext.userId,
        channel_id: execContext.channelId,
        message_ts: execContext.messageTs,
        title: `Approve ${tool.name}`,
        description: policy.reason,
        risk_level: tool.riskLevel,
        proposed_action: { tool: tool.name, input: args },
        status: 'pending',
        expires_at: new Date(Date.now() + 30 * 60 * 1000)
      });
      try {
        await postApprovalBlockKit(approval, execContext);
        await agentStore.updateToolCallStatus(toolCall.id, 'requires_approval', { approval_id: approval.id });
        await agentStore.updateStepStatus(step.id, 'blocked', { error: policy.reason });
        await agentStore.updateRunStatus(run.id, 'awaiting_approval');
      } catch (err: any) {
        await agentStore.updateApprovalStatus(approval.id, 'failed');
        await agentStore.updateToolCallStatus(toolCall.id, 'failed', { error: `Failed to post approval: ${err.message}` });
        await persistLoopStepFailure(run, goal, step, err.message);
      }
      return { kind: 'approval' };
    }
    // Blocked outright (destructive/privileged).
    await agentStore.updateToolCallStatus(toolCall.id, 'blocked', { error: policy.reason });
    await persistLoopStep(run, goal, planId, toolName, args, 'blocked', orderIndex, { error: policy.reason }, step);
    return { kind: 'done', response: { error: `Blocked by policy: ${policy.reason}` } };
  }

  // Execute with the same timeout guard executor.ts uses.
  let output: any;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    output = await Promise.race([
      tool.execute(args as any, execContext),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool ${toolName} timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS);
      })
    ]);
  } catch (err: any) {
    await agentStore.updateToolCallStatus(toolCall.id, 'failed', { error: err.message });
    await persistLoopStepFailure(run, goal, step, err.message);
    // Surface the error back to the model so it can adapt (retry / different tool).
    return { kind: 'done', response: { error: err.message } };
  } finally {
    if (timer) clearTimeout(timer);
  }

  await agentStore.updateToolCallStatus(toolCall.id, 'succeeded', { output });
  await agentStore.updateStepStatus(step.id, 'succeeded', { output });
  await agentStore.appendAuditEvent({
    workspace_id: goal.workspace_id, goal_id: goal.id, run_id: run.id, step_id: step.id,
    type: 'tool.succeeded', actor: 'system',
    summary: `Agent loop tool ${tool.name} succeeded`,
    payload: { output }
  });
  return { kind: 'done', response: { output } as Record<string, unknown> };
}

async function persistLoopStep(
  run: AgentRun,
  goal: AgentGoal,
  _planId: string,
  toolName: string,
  args: Record<string, unknown>,
  status: 'succeeded' | 'failed' | 'blocked',
  orderIndex: number,
  patch: { output?: any; error?: string },
  existing?: any
): Promise<any> {
  if (existing) {
    return agentStore.updateStepStatus(existing.id, status, patch);
  }
  return agentStore.createStep({
    run_id: run.id,
    plan_id: _planId,
    order_index: orderIndex,
    title: toolName,
    status,
    input: { kind: 'tool', toolName, input: args },
    ...(patch.output != null ? { output: patch.output } : {}),
    ...(patch.error != null ? { error: patch.error } : {})
  });
}

async function persistLoopStepFailure(run: AgentRun, goal: AgentGoal, step: any, message: string): Promise<void> {
  await agentStore.updateStepStatus(step.id, 'failed', { error: message });
  await agentStore.appendAuditEvent({
    workspace_id: goal.workspace_id, goal_id: goal.id, run_id: run.id, step_id: step.id,
    type: 'tool.failed', actor: 'system',
    summary: `Agent loop tool failed: ${message}`,
    payload: { error: message }
  });
}
