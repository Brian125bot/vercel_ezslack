import type { AgentTool } from '../agent/types.js';

export const slackReplyInThreadTool: AgentTool<{ text: string }> = {
  name: 'slack.replyInThread',
  description: 'Reply to the user in a Slack thread.',
  riskLevel: 'internal_write',
  requiresApproval: false,
  async execute(input, context) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token || token.startsWith('xoxb-mock') || token.startsWith('mock:')) {
      return { status: 'simulated_dispatch', message: input.text };
    }
    
    // In a real implementation this would use the WebClient
    try {
      const { WebClient } = await import('@slack/web-api');
      const client = new WebClient(token);
      await client.chat.postMessage({
        channel: context.channelId,
        thread_ts: context.threadTs || context.messageTs,
        text: input.text,
      });
      return { status: 'success', message: 'Posted to Slack' };
    } catch (err: any) {
      if (context.channelId?.includes('SIMULATED') || err.message?.includes('channel_not_found')) {
        console.warn(`[Slack API Graceful Failover] Channel '${context.channelId}' not found or is simulated. Falling back to simulated dispatch.`);
        return { status: 'simulated_dispatch', message: input.text, warning: 'Simulated due to non-existent or simulated channel.' };
      }
      throw new Error(`Failed to post to Slack: ${err.message}`);
    }
  }
};
