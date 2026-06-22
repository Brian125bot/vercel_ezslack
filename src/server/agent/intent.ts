import { GoogleGenAI } from '@google/genai';
import { resolveModel } from './models.js';

export type IntentCategory = 
  | 'direct_reply'
  | 'durable_task'
  | 'status_query'
  | 'approval_response'
  | 'cancel_or_update'
  | 'unsafe_or_unsupported';

export interface IntentContext {
  workspaceId: string;
  channelId: string;
  userId: string;
  threadTs?: string;
  hasPendingApproval?: boolean;
}

export interface IntentResult {
  intent: IntentCategory;
  confidence: 'high' | 'medium' | 'low';
  source: 'heuristic' | 'llm' | 'fallback';
}

export async function classifyIntent(
  text: string,
  selectedModel: string,
  options?: { ai?: GoogleGenAI; context?: IntentContext }
): Promise<IntentResult> {
  const lowercase = text.toLowerCase().trim();
  const hasPendingApproval = !!options?.context?.hasPendingApproval;
  
  // Heuristic overrides
  
  // 1. Unsafe/Unsupported detection
  const unsafePatterns = [
    'rm -rf', 'delete database', 'drop table', 'shutdown', 'truncate table', 'privileged',
    'sudo ', 'eval(', 'format c:', ':(){ :|:& };:', 'drop database', 'delete from users',
    'delete files', 'wipe server'
  ];
  if (unsafePatterns.some(p => lowercase.includes(p))) {
    return {
      intent: 'unsafe_or_unsupported',
      confidence: 'high',
      source: 'heuristic'
    };
  }

  // 2. Approval response - Weak approval/confirm words only count when hasPendingApproval is true
  const approvalWords = [
    'approve', 'reject', 'confirm', 'yes', 'no', 'proceed', 'deny', 'allow', 'disallow',
    'approved', 'rejected', 'go ahead', 'stop execution', 'cancel proposal'
  ];
  if (approvalWords.some(w => lowercase === w || lowercase.startsWith(w + ' ') || lowercase.startsWith(w + '!'))) {
    if (hasPendingApproval) {
      return {
        intent: 'approval_response',
        confidence: 'high',
        source: 'heuristic'
      };
    } else {
      // If no pending approval and the phrase is exactly approve, reject, yes, no,, treat as direct_reply
      if (['approve', 'reject', 'yes', 'no', 'approved', 'rejected', 'confirm'].includes(lowercase)) {
        return {
          intent: 'direct_reply',
          confidence: 'high',
          source: 'heuristic'
        };
      }
    }
  }

  // 3. Cancel / update
  const cancelWords = [
    'cancel run', 'cancel task', 'stop run', 'stop task', 'abort run', 'abort task', 'kill run',
    'update step', 'change plan', 'modify task', 'cancel goal', 'delete goal'
  ];
  if (cancelWords.some(w => lowercase.includes(w))) {
    return {
      intent: 'cancel_or_update',
      confidence: 'high',
      source: 'heuristic'
    };
  }

  // 4. Status query
  const statusWords = [
    'status of', 'what is the status', 'show runs', 'get status', 'check status', 'list tasks',
    'list goals', 'list runs', 'how is the task', 'any update on', 'any status'
  ];
  if (statusWords.some(w => lowercase.includes(w))) {
    return {
      intent: 'status_query',
      confidence: 'high',
      source: 'heuristic'
    };
  }

  // 5. Durable task triggers
  const durableWords = [
    'remind', 'schedule', 'create', 'track', 'watch', 'follow up', 'summarize', 'draft',
    'investigate', 'open a task', 'notify me', 'add issue', 'create ticket', 'alert', 'run task',
    'execute command', 'monitor', 'backup', 'restore'
  ];
  if (durableWords.some(w => lowercase.includes(w))) {
    return {
      intent: 'durable_task',
      confidence: 'high',
      source: 'heuristic'
    };
  }

  // 6. Very short messages are usually chitchat or greeting
  if (text.length < 8) {
    return {
      intent: 'direct_reply',
      confidence: 'high',
      source: 'heuristic'
    };
  }

  // Fallback to LLM
  let ai = options?.ai;
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      ai = new GoogleGenAI({ apiKey });
    }
  }

  if (ai) {
    try {
      const prompt = `Analyze the following user instruction and classify its primary intent into exactly one of these six categories:
- 'direct_reply': General casual conversation, greetings, social pleasantries, simple questions with direct answers, or explanations.
- 'durable_task': Any multi-step task, background operations, reminders, tracking requests, open a task, summarizing threads, drafting, monitoring, creating or investigating resources.
- 'status_query': Any question about active list of jobs, runs, goals, or statuses of previous executions.
- 'approval_response': Decisions on approval workflows, confirmation replies (e.g. "go ahead", "approve", "reject", "yes, please").
- 'cancel_or_update': Requests to stop, kill, pause, resume, abort, cancel, or modify a running process.
- 'unsafe_or_unsupported': Destructive commands (e.g. RM -RF, wipe, drop table), unauthorized access, security exploits, or requests to bypass boundaries.

User Message: "${text}"

Respond with EXACTLY a JSON block matching this structure:
{
  "intent": "INTENT_NAME",
  "confidence": "high" | "medium" | "low"
}
Provide NO other text.`;

      const response = await ai.models.generateContent({
        model: resolveModel(selectedModel),
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const parsed = JSON.parse(response.text?.trim() || '{}');
      let intentStr = parsed.intent as IntentCategory;
      const confidence = (parsed.confidence || 'medium') as 'high' | 'medium' | 'low';
      
      const validCategories: IntentCategory[] = [
        'direct_reply', 'durable_task', 'status_query', 'approval_response', 'cancel_or_update', 'unsafe_or_unsupported'
      ];
      
      if (validCategories.includes(intentStr)) {
        // Enforce the rule: cannot be approval_response if there is no pending approval
        if (intentStr === 'approval_response' && !hasPendingApproval) {
          intentStr = 'direct_reply';
        }
        return {
          intent: intentStr,
          confidence,
          source: 'llm'
        };
      }
    } catch (err) {
      console.warn(`[Intent fallback error] Failing over to heuristic defaults.`, err);
    }
  }

  return {
    intent: 'direct_reply',
    confidence: 'low',
    source: 'fallback'
  };
}
