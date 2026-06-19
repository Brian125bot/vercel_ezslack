import type { AgentTool } from '../agent/types.js';
import { agentStore } from '../storage/agentStore.js';
import { GoogleGenAI } from '@google/genai';

export const slackReplyInThreadTool: AgentTool<{ text: string }> = {
  name: 'slack.replyInThread',
  description: 'Reply to the user in a Slack thread.',
  riskLevel: 'internal_write',
  requiresApproval: false,
  async execute(input, context) {
    let replyText = input.text;

    // The static planner sometimes leaves text empty when it doesn't know the output of previous steps yet.
    if (!replyText || String(replyText).trim() === '') {
       if (context.runId) {
         try {
           const trace = await agentStore.getRunTrace(context.runId);
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
    
    // In a real implementation this would use the WebClient
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
