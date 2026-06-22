import type { AgentRunTrace } from '../storage/types.js';
import { slackReplyInThreadTool } from '../tools/slack.js';
import type { ToolExecutionContext } from './types.js';

/**
 * Build a human-readable run report from a full execution trace.
 * This is the W3-D "action-aware" reporter — it describes what the agent
 * actually *did* (which tools ran, their outcomes, approvals resolved)
 * rather than just a generic status emoji.
 */
export function buildRunReport(trace: AgentRunTrace): string {
  const { run, goal, toolCalls, approvals } = trace;

  // WS5: report only the steps of the run's CURRENT (latest) plan iteration so
  // abandoned earlier plans never show up as duplicate/failed noise.
  const allSteps = trace.steps || [];
  let targetPlanId: string | null | undefined = run.plan_id;
  if (!targetPlanId && allSteps.length > 0) {
    targetPlanId = allSteps.reduce((a, b) =>
      new Date(a.created_at).getTime() >= new Date(b.created_at).getTime() ? a : b
    ).plan_id;
  }
  const steps = targetPlanId ? allSteps.filter(s => s.plan_id === targetPlanId) : allSteps;

  const lines: string[] = [];

  // Header
  const statusEmoji: Record<string, string> = {
    succeeded: '✅', failed: '❌', cancelled: '🚫', blocked: '🚧'
  };
  const emoji = statusEmoji[run.status] || 'ℹ️';
  lines.push(`${emoji} *Run Report — ${goal.title}*`);
  lines.push('');

  // Summary
  if (run.result_summary) {
    lines.push(`> ${run.result_summary}`);
    lines.push('');
  }

  // Steps breakdown
  if (steps.length > 0) {
    lines.push('*Steps:*');
    for (const step of steps) {
      const stepEmoji: Record<string, string> = {
        succeeded: '✅', failed: '❌', blocked: '🚧', skipped: '⏭️', running: '⏳', pending: '⬜'
      };
      const se = stepEmoji[step.status] || '❔';
      let line = `${se} ${step.title}`;

      // If there's a tool call for this step, mention the tool
      const tc = toolCalls.find(t => t.step_id === step.id);
      if (tc) {
        line += ` (\`${tc.tool_name}\`)`;
        if (tc.status === 'failed' && tc.error) {
          line += ` — _${tc.error}_`;
        }
      }

      // If generate step, note the output length
      if ((step.output as any)?.generated) {
        const genLen = String((step.output as any).generated).length;
        line += ` — generated ${genLen} chars`;
      }

      if (step.status === 'failed' && step.error && !tc) {
        line += ` — _${step.error}_`;
      }
      lines.push(line);
    }
    lines.push('');
  }

  // Approvals
  const resolvedApprovals = approvals.filter(a => a.status !== 'pending');
  if (resolvedApprovals.length > 0) {
    lines.push('*Approvals:*');
    for (const a of resolvedApprovals) {
      const ae = a.status === 'approved' ? '👍' : '👎';
      lines.push(`${ae} ${a.title} — ${a.status}`);
    }
    lines.push('');
  }

  // Footer
  const iterations = run.iteration_count || 1;
  if (iterations > 1) {
    lines.push(`_Completed after ${iterations} iteration(s)._`);
  }

  if (run.failure_reason && run.status !== 'succeeded') {
    lines.push(`_Failure reason: ${run.failure_reason}_`);
  }

  return lines.join('\n');
}

const SLACK_MAX_TEXT = 39000; // 40K limit with headroom

/**
 * Post an action-aware run report to Slack.
 */
export async function reportRunResult(
  trace: AgentRunTrace,
  context: ToolExecutionContext
): Promise<void> {
  let report = buildRunReport(trace);
  if (report.length > SLACK_MAX_TEXT) {
    report = report.substring(0, SLACK_MAX_TEXT) + '\n\n_...truncated (report exceeded 40K characters)_';
  }
  try {
    await slackReplyInThreadTool.execute({ text: report }, context);
  } catch (err) {
    console.error('Reporter failed to post to Slack', err);
  }
}

/**
 * Legacy simple status reporter (kept for backward compatibility).
 */
export async function reportStatus(
  status: 'task_accepted' | 'accepted' | 'awaiting_approval' | 'completed' | 'blocked' | 'failed' | 'simulated_dispatch', 
  details: string,
  context: ToolExecutionContext
) {
  let message = '';
  switch (status) {
    case 'task_accepted':
    case 'accepted':
      message = `⏳ *Task Accepted*: ${details}`;
      break;
    case 'awaiting_approval':
      message = `✋ *Awaiting Approval*: ${details}`;
      break;
    case 'completed':
      message = `✅ *Completed*: ${details}`;
      break;
    case 'blocked':
      message = `🚧 *Blocked*: ${details}`;
      break;
    case 'failed':
      message = `❌ *Failed*: ${details}`;
      break;
    case 'simulated_dispatch':
      message = `ℹ️ *Simulated*: ${details}`;
      break;
  }

  try {
    await slackReplyInThreadTool.execute({ text: message }, context);
  } catch (err) {
    console.error('Reporter failed to post to Slack', err);
  }
}
