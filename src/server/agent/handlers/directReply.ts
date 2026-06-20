import { generateSimpleResponse } from '../../ai.js';
import { getThreadHistory, saveThreadHistory } from '../../state.js';
import { slackReplyInThreadTool } from '../../tools/slack.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';

export async function handleDirectReply(
  input: AgentPipelineInput,
  context: ToolExecutionContext
): Promise<AgentPipelineResult> {
  const intent = 'direct_reply';
  const threadKeyStr = input.threadTs ? `chan-${input.channelId}-thread-${input.threadTs}` : `chan-${input.channelId}-single`;
  const history = await getThreadHistory(threadKeyStr);
  
  try {
    const replyText = await generateSimpleResponse(input.messageText, input.selectedModel, history);
    
    // Update thread memory
    const updatedHistory = [...history, { role: 'user' as const, text: input.messageText }, { role: 'model' as const, text: replyText }];
    await saveThreadHistory(threadKeyStr, updatedHistory);

    await slackReplyInThreadTool.execute({ text: replyText }, context);
    return { status: 'success', intent };
  } catch (err: any) {
    return { status: 'error', intent, message: err.message };
  }
}
