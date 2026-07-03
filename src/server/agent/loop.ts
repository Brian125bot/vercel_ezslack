import { agentStore } from '../storage/agentStore.js';
import type { AgentRun, AgentStep, ToolCall } from '../storage/types.js';
import { assembleContext, renderContextForPrompt } from './context.js';
import { executeToolCall } from './executor.js';
import { finalizeRun } from './finalize.js';
import { verifySemantically } from './semanticVerifier.js';
import { slog } from './log.js';
import { toolsRegistry } from '../tools/registry.js';
import { geminiCallRaw, createThreadCache } from './geminiClient.js';
import { resolveModel } from './models.js';
import { attachmentsToGeminiParts } from './attachments.js';

const LEASE_SECONDS = parseInt(process.env.WORKER_LEASE_SECONDS || '300');
const MAX_ITERATIONS = 5;
const LEASE_HEARTBEAT_MS = 60_000;
const MAX_RUN_WALL_TIME_MS = parseInt(process.env.RUN_TIMEOUT_MS || '45000');

async function buildConversationalHistory(
  goal: any,
  run: AgentRun,
  ctx: any,
  steps: AgentStep[],
  toolCalls: ToolCall[]
): Promise<any[]> {
  const contents: any[] = [];
  
  // 1. Initial User Turn with Goal, Context, and Attachments
  const initialPrompt = `Goal: ${goal.original_instruction}
  
Additional Context:
${renderContextForPrompt(ctx)}`;

  const userParts: any[] = [];
  if (ctx.attachments && ctx.attachments.length > 0) {
    userParts.push(...attachmentsToGeminiParts(ctx.attachments));
  }
  userParts.push({ text: initialPrompt });
  
  contents.push({
    role: 'user',
    parts: userParts
  });
  
  // 2. Map completed agent steps (turns) to model + user turns
  for (const step of steps) {
    if (step.status === 'pending' || step.status === 'running') {
      continue;
    }
    
    const stepInput = step.input as any;
    const role = stepInput?.role || 'model';
    
    if (role === 'user') {
      contents.push({
        role: 'user',
        parts: [{ text: stepInput.text }]
      });
    } else {
      let modelParts: any[] = [];
      if (stepInput?.parts && stepInput.parts.length > 0) {
        modelParts = stepInput.parts;
      } else {
        if (stepInput?.text) {
          modelParts.push({ text: stepInput.text });
        }
        if (stepInput?.functionCalls && stepInput.functionCalls.length > 0) {
          modelParts.push(...stepInput.functionCalls.map((fc: any) => ({ functionCall: fc })));
        }
      }
      
      if (modelParts.length > 0) {
        contents.push({
          role: 'model',
          parts: modelParts
        });
        
        const stepToolCalls = toolCalls.filter(tc => tc.step_id === step.id);
        if (stepToolCalls.length > 0) {
          const functionParts = stepToolCalls.map(tc => {
            const responsePayload = tc.output || { error: tc.error || 'Unknown tool failure' };
            return {
              functionResponse: {
                name: tc.tool_name,
                response: typeof responsePayload === 'object' ? responsePayload : { result: responsePayload }
              }
            };
          });
          contents.push({
            role: 'user',
            parts: functionParts
          });
        }
      }
    }
  }
  
  return contents;
}

export async function runLoop(runIn: AgentRun, workerId?: string): Promise<void> {
  let run = runIn;
  const runStartTime = Date.now();
  const wouldExceedTimeout = (): boolean => (Date.now() - runStartTime) >= MAX_RUN_WALL_TIME_MS;

  slog('loop', 'runLoop.start', { run_id: run.id, goal_id: run.goal_id, worker_id: workerId });

  const goal = await agentStore.getGoal(run.goal_id);
  const leaseHeartbeat = setInterval(() => {
    agentStore.renewLease(run.id, LEASE_SECONDS).catch(err => {
      slog('loop', 'lease_renewal_failed', { run_id: run.id, error: err.message });
    });
  }, LEASE_HEARTBEAT_MS);

  try {
    if (run.iteration_count && run.iteration_count >= MAX_ITERATIONS) {
      clearInterval(leaseHeartbeat);
      await finalizeRun(run, 'failed', `Max iterations (${MAX_ITERATIONS}) exhausted.`);
      return;
    }

    // Transition from queued to running if starting
    if (run.status === 'queued') {
      run = await agentStore.updateRunStatus(run.id, 'running');
    }

    const trace = await agentStore.getRunTrace(run.id);
    const steps = trace.steps || [];
    const toolCalls = trace.toolCalls || [];

    // Find if we have a pending/blocked step (turn) with tool calls to execute
    const pendingStep = steps.find(s => s.status === 'pending' || s.status === 'blocked');

    if (pendingStep) {
      slog('loop', 'pending_step_resume', { run_id: run.id, step_id: pendingStep.id });
      
      const stepToolCalls = toolCalls.filter(tc => tc.step_id === pendingStep.id);
      let allResolved = true;
      let hasBlocked = false;

      const context = {
        runId: run.id,
        stepId: pendingStep.id,
        workspaceId: goal.workspace_id,
        channelId: goal.source_channel_id || '',
        userId: goal.created_by_user_id,
        messageTs: goal.source_message_ts || '',
        threadTs: goal.source_thread_ts || '',
        preApproved: false
      };

      for (const tc of stepToolCalls) {
        if (tc.status === 'created') {
          if (wouldExceedTimeout()) {
            slog('loop', 'timeout_guard', { run_id: run.id, elapsed: Date.now() - runStartTime, phase: 'execute_tool_call' });
            clearInterval(leaseHeartbeat);
            await agentStore.updateRunStatus(run.id, 'queued', {
              claimed_by: null, claimed_at: null, lease_expires_at: null,
              failure_reason: 'Run paused near wall-clock timeout during tool execution'
            });
            const { enqueueRunTask } = await import('./taskClient.js');
            await enqueueRunTask(run.id);
            return;
          }

          await executeToolCall(run, pendingStep, tc, context);
          const updatedTc = await agentStore.getRunTrace(run.id).then(t => t.toolCalls.find(x => x.id === tc.id)!);
          if (updatedTc.status === 'requires_approval' || updatedTc.status === 'blocked') {
            hasBlocked = true;
            allResolved = false;
          } else if (updatedTc.status === 'running') {
            allResolved = false;
          }
        } else if (tc.status === 'requires_approval' || tc.status === 'blocked') {
          // Check if it was resolved
          const approvals = await agentStore.getApprovalsForRun(run.id);
          const approval = approvals.find(a => a.tool_call_id === tc.id);
          if (approval) {
            if (approval.status === 'approved') {
              // Retry execution as pre-approved
              await executeToolCall(run, pendingStep, tc, { ...context, preApproved: true });
            } else if (approval.status === 'rejected') {
              await agentStore.updateToolCallStatus(tc.id, 'failed', { error: 'User rejected the execution request' });
            } else {
              hasBlocked = true;
              allResolved = false;
            }
          } else {
            hasBlocked = true;
            allResolved = false;
          }
        } else if (tc.status === 'running') {
          allResolved = false;
        }
      }

      if (allResolved) {
        // Collect results
        const updatedTrace = await agentStore.getRunTrace(run.id);
        const resolvedToolCalls = updatedTrace.toolCalls.filter(tc => tc.step_id === pendingStep.id);
        
        await agentStore.updateStepStatus(pendingStep.id, 'succeeded', {
          output: {
            responses: resolvedToolCalls.map(tc => ({
              name: tc.tool_name,
              response: tc.output || { error: tc.error || 'Tool execution failed' }
            }))
          }
        });

        // Re-enqueue run to perform the next Gemini turn
        clearInterval(leaseHeartbeat);
        await agentStore.updateRunStatus(run.id, 'queued', {
          claimed_by: null, claimed_at: null, lease_expires_at: null
        });
        const { enqueueRunTask } = await import('./taskClient.js');
        await enqueueRunTask(run.id);
        return;
      }

      if (hasBlocked) {
        clearInterval(leaseHeartbeat);
        await agentStore.updateRunStatus(run.id, 'blocked');
        return; // Yield and wait for approval callback
      }

      // If still executing async, yield
      clearInterval(leaseHeartbeat);
      return;
    }

    // No pending tool calls. We are ready to call Gemini for the next turn.
    run = await agentStore.incrementRunIteration(run.id);
    
    if (wouldExceedTimeout()) {
      slog('loop', 'timeout_guard', { run_id: run.id, elapsed: Date.now() - runStartTime, phase: 'gemini_call_prep' });
      clearInterval(leaseHeartbeat);
      await agentStore.updateRunStatus(run.id, 'queued', {
        claimed_by: null, claimed_at: null, lease_expires_at: null,
        failure_reason: 'Run paused near wall-clock timeout before Gemini turn'
      });
      const { enqueueRunTask } = await import('./taskClient.js');
      await enqueueRunTask(run.id);
      return;
    }

    const ctx = await assembleContext(goal, run);
    const contents = await buildConversationalHistory(goal, run, ctx, steps, toolCalls);

    const activeTools = toolsRegistry.getAll();
    const functionDeclarations = activeTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
    const tools = functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;
    const systemInstruction = "You are an agentic Slack assistant. Complete the goal by calling available tools. Always use slack.replyInThread to send your final results/answers to the user.";
    const toolConfig = { functionCallingConfig: { mode: 'AUTO' } };

    let finalContents = contents;
    let configPayload: any = {
      systemInstruction,
      tools,
      toolConfig
    };

    // Context Caching for long threads (> 10 turns/messages)
    if (contents.length > 10 && (run.model.includes('gemini-3') || run.model.includes('gemini-2.0') || run.model.includes('gemini-1.5-pro'))) {
      try {
        const cacheContents = contents.slice(0, contents.length - 1);
        const cacheName = await createThreadCache(resolveModel(run.model), systemInstruction, cacheContents, tools, toolConfig);
        finalContents = [contents[contents.length - 1]];
        
        configPayload = {
          cachedContent: cacheName
        };
      } catch (err: any) {
        slog('loop', 'cache_creation_failed', { run_id: run.id, error: err.message });
      }
    }

    const response = await geminiCallRaw({
      model: resolveModel(run.model),
      contents: finalContents,
      config: configPayload,
      label: 'nativeAgentLoop'
    });

    // Create a new step representing this model turn
    const nextOrderIndex = steps.length + 1;
    const newStep = await agentStore.createStep({
      run_id: run.id,
      order_index: nextOrderIndex,
      title: `Agent Turn ${nextOrderIndex}`,
      status: response.functionCalls && response.functionCalls.length > 0 ? 'pending' : 'succeeded',
      input: {
        text: response.text,
        functionCalls: response.functionCalls,
        parts: response.parts
      }
    });

    if (response.functionCalls && response.functionCalls.length > 0) {
      // Create tool calls in the database
      for (const fc of response.functionCalls) {
        const tool = toolsRegistry.get(fc.name);
        await agentStore.createToolCall({
          run_id: run.id,
          step_id: newStep.id,
          tool_name: fc.name,
          input: fc.args || {},
          status: 'created',
          risk_level: tool?.riskLevel || 'read'
        });
      }

      // Re-enqueue the run to execute the tool calls
      clearInterval(leaseHeartbeat);
      await agentStore.updateRunStatus(run.id, 'queued', {
        claimed_by: null, claimed_at: null, lease_expires_at: null
      });
      const { enqueueRunTask } = await import('./taskClient.js');
      await enqueueRunTask(run.id);
      return;
    }

    // No function calls. Gemini finished!
    // Verify semantically
    const updatedTrace = await agentStore.getRunTrace(run.id);
    const semVerify = await verifySemantically(updatedTrace, run.model);

    if (semVerify.satisfied || semVerify.confidence < 0.5) {
      // Goal satisfied! Check if we need a final fallback Slack post
      const slackReplies = updatedTrace.toolCalls.filter(tc => tc.tool_name === 'slack.replyInThread');
      if (slackReplies.length === 0 && response.text) {
        // Fallback: post the model's text directly to Slack
        const slackTool = toolsRegistry.get('slack.replyInThread')!;
        await slackTool.execute({ text: response.text }, {
          runId: run.id,
          stepId: newStep.id,
          workspaceId: goal.workspace_id,
          channelId: goal.source_channel_id || '',
          userId: goal.created_by_user_id,
          messageTs: goal.source_message_ts || '',
          threadTs: goal.source_thread_ts || ''
        });
      }

      clearInterval(leaseHeartbeat);
      await finalizeRun(run, 'succeeded');
    } else {
      // Goal NOT satisfied. Re-feed verification feedback.
      await agentStore.createStep({
        run_id: run.id,
        order_index: nextOrderIndex + 1,
        title: 'Verification Feedback',
        status: 'succeeded',
        input: {
          text: `Verification feedback: ${semVerify.reasoning}`,
          role: 'user'
        }
      });

      slog('loop', 'verification_failed_relooping', { run_id: run.id, reasoning: semVerify.reasoning });

      clearInterval(leaseHeartbeat);
      await agentStore.updateRunStatus(run.id, 'queued', {
        claimed_by: null, claimed_at: null, lease_expires_at: null
      });
      const { enqueueRunTask } = await import('./taskClient.js');
      await enqueueRunTask(run.id);
    }

  } catch (err: any) {
    clearInterval(leaseHeartbeat);
    slog('loop', 'runLoop.error', { run_id: run.id, error: err.message });
    await finalizeRun(run, 'failed', err.message);
  } finally {
    slog('loop', 'runLoop.complete', {
      run_id: run.id,
      elapsed: Date.now() - runStartTime,
      final_status: run.status
    });
  }
}
