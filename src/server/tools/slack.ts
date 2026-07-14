import type { AgentTool, ToolExecutionContext, AgentToolEnhanced } from '../agent/types.js';
import type { ApprovalRequest } from '../storage/types.js';
import { agentStore } from '../storage/agentStore.js';
import { geminiCall } from '../agent/geminiClient.js';
import { resolveModel } from '../agent/models.js';
import { selectedModel } from '../state.js';

const SLACK_MAX_TEXT = 39000;
const SLACK_MAX_SECTION_TEXT = 2800;

export const slackReplyInThreadTool: AgentTool<{ text: string }> = {
  name: 'slack.replyInThread',
  description: 'Reply to the user in a Slack thread.',
  riskLevel: 'internal_write',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The message text to post in the Slack thread.' }
    },
    required: ['text']
  },
  async execute(input, context) {
    let replyText = input.text;

    // W3-A: If text is empty, check for upstream generated content first
    if (!replyText || String(replyText).trim() === '') {
       if (context.runId) {
         try {
           const trace = await agentStore.getRunTrace(context.runId);
           // WS3: only consider steps from the run's current plan iteration.
           const planScoped = trace.run.plan_id
             ? trace.steps.filter(s => s.plan_id === trace.run.plan_id)
             : trace.steps;
           // Look for a generate step's output first
           const generatedStep = planScoped
             .filter(s => s.status === 'succeeded' && (s.output as any)?.generated)
             .pop();
           if (generatedStep) {
             replyText = (generatedStep.output as any).generated;
           } else {
             // Fallback: synthesise from all step outputs via Gemini
             const previousOutputs = planScoped
               .filter(s => s.status === 'succeeded' && s.output)
               .map(s => `Step: ${s.title}\nOutput: ${JSON.stringify(s.output)}`)
               .join('\n\n');
               
              const apiKey = process.env.GEMINI_API_KEY;
              if (apiKey && previousOutputs) {
                const responseText = await geminiCall({
                  model: resolveModel(selectedModel),
                  contents: `Based on the following execution trace for the goal "${trace.goal.title}", generate a concise and helpful Slack reply to the user summarize what was done. Keep it brief.\n\n${previousOutputs}`,
                  label: 'autoReply'
                });
                if (responseText) {
                  replyText = responseText;
                }
              }
           }
         } catch (e) {
           console.warn('Failed to dynamically generate empty Slack reply:', e);
         }
       }
       if (!replyText || String(replyText).trim() === '') {
         replyText = 'I have completed the requested task, but the planner left my response blank.';
       }
     }

     // Truncate to Slack limit to prevent API errors
     if (replyText.length > SLACK_MAX_TEXT) {
       replyText = replyText.substring(0, SLACK_MAX_TEXT) + '\n\n_...truncated (exceeded 40K characters)_';
     }

     const token = process.env.SLACK_BOT_TOKEN;
    if (!token || token.startsWith('xoxb-mock') || token.startsWith('mock:')) {
      return { status: 'simulated_dispatch', message: replyText };
    }
    
    try {
      const { WebClient } = await import('@slack/web-api');
      const client = new WebClient(token);
      await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: context.threadTs || context.messageTs,
        text: replyText,
      });
      return { status: 'success', message: 'Posted to Slack' };
    } catch (err: any) {
      if (context.channelId?.includes('SIMULATED') || err.message?.includes('channel_not_found')) {
        console.warn(`[Slack API Graceful Failover] Channel '${context.channelId}' not found or is simulated. Falling back to simulated dispatch.`);
        return { status: 'simulated_dispatch', message: replyText, warning: 'Simulated due to non-existent or simulated channel.' };
      }
      throw new Error(`Failed to post to Slack: ${err.message}`);
    }
  }
};

/**
 * W3-C: Post a Block Kit interactive approval message to Slack.
 * Contains Approve / Reject buttons whose `action_id` carries the approval UUID.
 * The message_ts is stored back on the approval_request row so the interactivity
 * handler can update the original message when resolved.
 */
export async function postApprovalBlockKit(
  approval: ApprovalRequest,
  context: ToolExecutionContext
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || token.startsWith('xoxb-mock') || token.startsWith('mock:')) {
    console.log(`[Approval BlockKit] Simulated — approval ${approval.id}`);
    return;
  }

  try {
    const { WebClient } = await import('@slack/web-api');
    const client = new WebClient(token);

    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✋ *Approval Required*\n\n*${approval.title}*\n${approval.description}`.substring(0, SLACK_MAX_SECTION_TEXT)
        }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Risk Level:*\n${approval.risk_level}` },
          { type: 'mrkdwn', text: `*Tool:*\n${(approval.proposed_action as any)?.tool || 'N/A'}` }
        ]
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve', emoji: true },
            style: 'primary',
            action_id: `approval_approve`,
            value: approval.id
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Reject', emoji: true },
            style: 'danger',
            action_id: `approval_reject`,
            value: approval.id
          }
        ]
      }
    ];

    const result = await client.chat.postMessage({
      channel: context.channelId,
      thread_ts: context.threadTs || context.messageTs,
      text: `Approval required: ${approval.title}`,
      blocks
    });

    if (result.ts) {
      await agentStore.updateApprovalMessageTs(approval.id, result.ts);
    }
  } catch (err: any) {
    console.error('[Approval BlockKit] Failed to post:', err.message);
  }
}

/**
 * Update an approval message to show the resolved state (replaces buttons).
 */
export async function updateApprovalMessage(
  approval: ApprovalRequest,
  status: 'approved' | 'rejected' | 'expired',
  channelId: string
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !approval.message_ts) return;

  try {
    const { WebClient } = await import('@slack/web-api');
    const client = new WebClient(token);

    const emojiMap: Record<string, string> = { approved: '\u2705', rejected: '\u274c', expired: '\u23f0' };
    const labelMap: Record<string, string> = { approved: 'Approved', rejected: 'Rejected', expired: 'Expired' };
    const emoji = emojiMap[status];
    const label = labelMap[status];

    await client.chat.update({
      channel: channelId,
      ts: approval.message_ts,
      text: `${emoji} ${label}: ${approval.title}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *${label}*\n\n*${approval.title}*\n${approval.description}`.substring(0, SLACK_MAX_SECTION_TEXT)
          }
        }
      ]
    });
  } catch (err: any) {
    console.error('[Approval BlockKit] Failed to update message:', err.message);
  }
}

/**
 * WS6: Surface streamed agent output to the user. Posts an initial Slack message
 * for the thread and incrementally updates it as text chunks arrive, so the user
 * sees the answer form in real time instead of waiting for the whole ReAct loop
 * to finish. Updates are throttled to avoid hitting Slack rate limits. When no
 * real token is configured (local/dev/mock) the stream is drained and discarded.
 */
export async function streamReplyToThread(
  context: ToolExecutionContext,
  stream: AsyncIterable<string>
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || token.startsWith('xoxb-mock') || token.startsWith('mock:')) {
    // Simulated environment: consume the stream so the generator completes.
    for await (const _ of stream) { /* drain */ }
    return;
  }

  try {
    const { WebClient } = await import('@slack/web-api');
    const client = new WebClient(token);

    let ts: string | undefined;
    let acc = '';
    let lastUpdate = 0;

    for await (const chunk of stream) {
      acc += chunk;
      if (!ts) {
        const res = await client.chat.postMessage({
          channel: context.channelId,
          thread_ts: context.threadTs || context.messageTs,
          text: acc.slice(0, SLACK_MAX_TEXT)
        });
        ts = res.ts;
      } else {
        const now = Date.now();
        if (now - lastUpdate > 800 && acc.length > 0) {
          await client.chat.update({
            channel: context.channelId,
            ts,
            text: acc.slice(0, SLACK_MAX_TEXT)
          });
          lastUpdate = now;
        }
      }
    }

    // Final reconcile in case the last update was throttled.
    if (ts && acc.length > 0) {
      await client.chat.update({
        channel: context.channelId,
        ts,
        text: acc.slice(0, SLACK_MAX_TEXT)
      });
    }
  } catch (err: any) {
    if (context.channelId?.includes('SIMULATED') || err.message?.includes('channel_not_found')) {
      console.warn(`[Slack Stream] Simulated/discarded reply (${context.channelId}).`);
      return;
    }
    console.error('[Slack Stream] Failed to stream reply:', err.message);
  }
}
