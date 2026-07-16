import { agentStore } from '../storage/agentStore.js';
import type { AgentRunTrace, AgentRun, AgentGoal } from '../storage/types.js';
import type { PlanningContext } from './types.js';
import { getThreadHistory } from '../state.js';

const MAX_THREAD_HISTORY_TOKENS = parseInt(process.env.MAX_THREAD_HISTORY_TOKENS || '8000');
const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || '100000');
const CHARS_PER_TOKEN = 4;

export async function assembleContext(goal: AgentGoal, run: AgentRun): Promise<PlanningContext> {
  const workspaceId = goal.workspace_id;
  const channelId = goal.source_channel_id;
  const userId = goal.created_by_user_id;

  // Retrieve thread history
  let threadHistory: any[] = [];
  if (channelId) {
    const threadKeyStr = goal.source_thread_ts ? `chan-${channelId}-thread-${goal.source_thread_ts}` : `chan-${channelId}-single`;
    threadHistory = await getThreadHistory(threadKeyStr);
  }

  // Compact thread history if too large (session compaction)
  threadHistory = compactThreadHistory(threadHistory);

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

  // Attachments are persisted on the run row itself (agent_runs.attachments),
  // so they survive the HTTP hop into this serverless invocation.
  const attachments = (run as any).attachments;

  return {
    goal: goal.title + "\n" + goal.original_instruction,
    threadHistory,
    memoryRecords,
    priorSteps,
    feedback: run.failure_reason || undefined,
    attachments
  };
}

export function compactThreadHistory(messages: any[]): any[] {
  if (messages.length === 0) return messages;

  // Estimate token count
  const estimatedTokens = messages.reduce((sum, m) => sum + (m.text?.length || 0) / CHARS_PER_TOKEN, 0);

  if (estimatedTokens <= MAX_THREAD_HISTORY_TOKENS) {
    return messages;
  }

  // Strategy: Keep first 2 (context), last 10 (recent), summarize middle
  const keepFirst = 2;
  const keepLast = 10;
  
  if (messages.length <= keepFirst + keepLast) {
    return messages;
  }

  const middle = messages.slice(keepFirst, -keepLast);
  const summary = summarizeMessages(middle);

  return [
    ...messages.slice(0, keepFirst),
    { role: 'system', text: `[Thread summary: ${summary}]`, summary: true },
    ...messages.slice(-keepLast)
  ];
}

function summarizeMessages(messages: any[]): string {
  const topics = new Set<string>();
  let userCount = 0, assistantCount = 0;
  
  for (const m of messages) {
    if (m.role === 'user') userCount++;
    else if (m.role === 'assistant') assistantCount++;
    
    // Extract key topics (simple heuristic: capitalized words > 3 chars)
    const words = (m.text || '').match(/\b[A-Z][a-z]{3,}\b/g) || [];
    for (const w of words) topics.add(w);
  }

  const topicList = Array.from(topics).slice(0, 10).join(', ');
  return `${userCount} user + ${assistantCount} assistant messages. Topics: ${topicList || 'general discussion'}`;
}

export function renderContextForPrompt(ctx: PlanningContext): string {
  let dump = `<context>\n`;
  dump += `Goal: ${ctx.goal}\n`;
  if (ctx.attachments && ctx.attachments.length > 0) {
    dump += `Attached files: ${ctx.attachments.map(a => `${a.filename} (${a.mimeType})`).join(', ')}\n`;
  }
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
      if (msg.summary) {
        dump += `[SUMMARY] ${msg.text}\n`;
      } else {
        dump += `${msg.role}: ${msg.text}\n`;
      }
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