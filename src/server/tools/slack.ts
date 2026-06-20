import type { AgentTool, ToolExecutionContext } from '../agent/types.js';
import type { ApprovalRequest } from '../storage/types.js';
import { agentStore } from '../storage/agentStore.js';
import { GoogleGenAI } from '@google/genai';

export const slackReplyInThreadTool: AgentTool<{ text: string }> = {
  name: 'slack.replyInThread',
  description: 'Reply to the user in a Slack thread.',
  riskLevel: 'internal_write',
  requiresApproval: false,
  async execute(input, context) {
    let replyText = input.text;

    // W3-A: If text is empty, check for upstream generated content first
    if (!replyText || String(replyText).trim() === '') {
       if (context.runId) {
         try {
           const trace = await agentStore.getRunTrace(context.runId);
           // Look for a generate step's output first
           const generatedStep = trace.steps
             .filter(s => s.status === 'succeeded' && (s.output as any)?.generated)
             .pop();
           if (generatedStep) {
             replyText = (generatedStep.output as any).generated;
           } else {
             // Fallback: synthesise from all step outputs via Gemini
             const previousOutputs = trace.steps
               .filter(s => s.status === 'succeeded' && s.output)
               .map(s => `Step: ${s.title}\nOutput: ${JSON.stringify(s.output)}`)
               .join('\n\n');
               
             const apiKey = process.env.GEMINI_API_KEY;
             if (apiKey && previousOutputs) {
               const ai = new GoogleGenAI({ apiKey });
               const response = await ai.models.generateContent({
                 model: 'gemini-2.5-flash',
                 contents: `Based on the following execution trace for the goal "${trace.goal.title}", generate a concise and helpful Slack reply to the user summarize what was done. Keep it brief.\n\n${previousOutputs}`
               });
               if (response.text) {
                 replyText = response.text;
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
          text: `✋ *Approval Required*\n\n*${approval.title}*\n${approval.description}`
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
  status: 'approved' | 'rejected',
  channelId: string
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !approval.message_ts) return;

  try {
    const { WebClient } = await import('@slack/web-api');
    const client = new WebClient(token);

    const emoji = status === 'approved' ? '✅' : '❌';
    const label = status === 'approved' ? 'Approved' : 'Rejected';

    await client.chat.update({
      channel: channelId,
      ts: approval.message_ts,
      text: `${emoji} ${label}: ${approval.title}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *${label}*\n\n*${approval.title}*\n${approval.description}`
          }
        }
      ]
    });
  } catch (err: any) {
    console.error('[Approval BlockKit] Failed to update message:', err.message);
  }
}
