import { slackReplyInThreadTool } from '../../tools/slack.js';
import type { AgentPipelineInput, AgentPipelineResult, ToolExecutionContext } from '../types.js';

export async function handleUnsafeOrUnsupported(
  input: AgentPipelineInput,
  context: ToolExecutionContext
): Promise<AgentPipelineResult> {
  const intent = 'unsafe_or_unsupported';
  
  try {
    const replyText = "I cannot fulfill this request as it is either unsafe, unsupported, or violates my security policy.";
    
    // Static refusal sent immediately
    await slackReplyInThreadTool.execute({ text: replyText }, context);
    
    return { status: 'success', intent };
  } catch (err: any) {
    return { status: 'error', intent, message: err.message };
  }
}
