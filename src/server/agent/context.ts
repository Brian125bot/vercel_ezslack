/**
 * Context Assembly for the planner (W2-B).
 *
 * Pulls together the information the planner needs to plan with knowledge rather than blind:
 *   - thread history (recent conversation in the originating Slack thread)
 *   - relevant memory snippets (memory.search)
 *   - prior step outputs from this run's trace
 *   - replan feedback from the previous loop iteration
 */
import { agentStore } from '../storage/agentStore.js';
import { threadMemory } from '../state.js';
import type { AgentGoal, AgentRun } from '../storage/types.js';
import type { PlanningContext } from './types.js';

export interface AssembleContextArgs {
  goal: AgentGoal;
  run: AgentRun;
  workspaceId: string;
  channelId: string;
  userId: string;
  threadTs?: string;
  replanFeedback?: string;
}

export async function assembleContext(args: AssembleContextArgs): Promise<PlanningContext> {
  const { goal, run, workspaceId, channelId, userId, threadTs, replanFeedback } = args;

  // 1. Thread history (best-effort; in-memory store keyed the same way handlers key it).
  const threadKey = threadTs ? `chan-${channelId}-thread-${threadTs}` : `chan-${channelId}-single`;
  const history = (threadMemory.get(threadKey) || []).slice(-10).map((m) => ({ role: m.role, text: m.text }));

  // 2. Relevant memory snippets.
  let memorySnippets: string[] = [];
  try {
    const records = await agentStore.searchMemory({ workspace_id: workspaceId, user_id: userId, channel_id: channelId, limit: 8 });
    memorySnippets = records.map((r) => r.content).filter(Boolean);
  } catch (err) {
    // Memory is advisory context; never fail planning because search failed.
    memorySnippets = [];
  }

  // 3. Prior step outputs from this run (so replans can build on what already happened).
  let priorStepOutputs: { title: string; output: string }[] = [];
  try {
    const steps = await agentStore.getStepsForRun(run.id);
    priorStepOutputs = steps
      .filter((s) => s.status === 'succeeded' && s.output)
      .map((s) => ({ title: s.title, output: typeof s.output === 'string' ? s.output : JSON.stringify(s.output) }));
  } catch {
    priorStepOutputs = [];
  }

  return {
    threadHistory: history,
    memorySnippets,
    priorStepOutputs,
    replanFeedback,
  };
}

/** Render the assembled context into a compact prompt block for the planner. */
export function renderContextForPrompt(ctx: PlanningContext): string {
  const parts: string[] = [];
  if (ctx.threadHistory.length) {
    parts.push(
      'Recent thread conversation:\n' +
        ctx.threadHistory.map((m) => `- ${m.role}: ${m.text}`).join('\n')
    );
  }
  if (ctx.memorySnippets.length) {
    parts.push('Relevant memory:\n' + ctx.memorySnippets.map((m) => `- ${m}`).join('\n'));
  }
  if (ctx.priorStepOutputs.length) {
    parts.push(
      'Outputs already produced in this run (do not redo these):\n' +
        ctx.priorStepOutputs.map((s) => `- ${s.title}: ${s.output}`).join('\n')
    );
  }
  if (ctx.replanFeedback) {
    parts.push(
      `IMPORTANT — the previous attempt did NOT satisfy the goal. Revise the plan to address this feedback:\n${ctx.replanFeedback}`
    );
  }
  return parts.length ? parts.join('\n\n') : 'No additional context available.';
}
