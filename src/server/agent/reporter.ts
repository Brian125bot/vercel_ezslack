import { slackReplyInThreadTool } from '../tools/slack.js';
import type { ToolExecutionContext } from './types.js';

export async function reportStatus(
  status: 'task_accepted' | 'completed' | 'blocked' | 'failed' | 'simulated_dispatch', 
  details: string,
  context: ToolExecutionContext
) {
  let message = '';
  switch (status) {
    case 'task_accepted':
      message = `⏳ *Task Accepted*: ${details}`;
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
