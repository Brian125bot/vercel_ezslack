import { agentStore } from '../storage/agentStore.js';
import type { AgentRunTrace, AgentRun, AgentGoal } from '../storage/types.js';
import type { PlanningContext } from './types.js';
import { threadMemory } from '../state.js';

export async function assembleContext(goal: AgentGoal, run: AgentRun): Promise<PlanningContext> {
  const workspaceId = goal.workspace_id;
  const channelId = goal.source_channel_id;
  const userId = goal.created_by_user_id;

  // Retrieve thread history
  let threadHistory: any[] = [];
  if (channelId) {
    const threadKeyStr = goal.source_thread_ts ? `chan-${channelId}-thread-${goal.source_thread_ts}` : `chan-${channelId}-single`;
    threadHistory = threadMemory.get(threadKeyStr) || [];
  }

  // Retrieve relevant memory
  let memoryRecords: any[] = [];
  if (channelId && userId) {
    const records = await agentStore.searchMemory({
      workspace_id: workspaceId,
      user_id: userId,
      channel_id: channelId,
      limit: 10
    });
    memoryRecords = records;
  }

  // Retrieve prior steps
  const priorSteps = await agentStore.getStepsForRun(run.id);

  return {
    goal: goal.title + "\\n" + goal.original_instruction,
    threadHistory,
    memoryRecords,
    priorSteps,
    feedback: run.failure_reason || undefined
  };
}

export function renderContextForPrompt(ctx: PlanningContext): string {
  let dump = `<context>\n`;
  dump += `Goal: ${ctx.goal}\n`;
  if (ctx.feedback) dump += `Feedback from previous run: ${ctx.feedback}\n`;
  
  if (ctx.memoryRecords.length > 0) {
    dump += `\nMemory:\n`;
    for (const mem of ctx.memoryRecords) {
      dump += `- ${mem.kind}: ${mem.content}\n`;
    }
  }

  if (ctx.threadHistory.length > 0) {
    dump += `\nChat History:\n`;
    for (const msg of ctx.threadHistory) {
      dump += `${msg.role}: ${msg.text}\n`;
    }
  }

  if (ctx.priorSteps.length > 0) {
    dump += `\nPrior Steps Execution:\n`;
    for (const step of ctx.priorSteps) {
      dump += `- [${step.status}] ${step.title}\n`;
      if (step.output) dump += `  Output: ${JSON.stringify(step.output)}\n`;
      if (step.error) dump += `  Error: ${step.error}\n`;
    }
  }

  dump += `</context>`;
  return dump;
}
