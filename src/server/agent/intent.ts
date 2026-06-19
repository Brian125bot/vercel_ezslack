import { GoogleGenAI } from '@google/genai';

export type IntentCategory = 
  | 'direct_reply'
  | 'durable_task'
  | 'status_query'
  | 'approval_response'
  | 'cancel_or_update'
  | 'unsafe_or_unsupported';

export async function classifyIntent(text: string, selectedModel: string, ai?: any): Promise<IntentCategory> {
  const lowercase = text.toLowerCase().trim();
  
  // Heuristic overrides
  
  // 1. Unsafe/Unsupported detection
  const unsafePatterns = [
    'rm -rf', 'delete database', 'drop table', 'shutdown', 'truncate table', 'privileged',
    'sudo ', 'eval(', 'format c:', ':(){ :|:& };:', 'drop database', 'delete from users',
    'delete files', 'wipe server'
  ];
  if (unsafePatterns.some(p => lowercase.includes(p))) {
    return 'unsafe_or_unsupported';
  }

  // 2. Approval response
  const approvalWords = [
    'approve', 'reject', 'confirm', 'yes', 'no', 'proceed', 'deny', 'allow', 'disallow',
    'approved', 'rejected', 'go ahead', 'stop execution', 'cancel proposal'
  ];
  if (approvalWords.some(w => lowercase === w || lowercase.startsWith(w + ' ') || lowercase.startsWith(w + '!'))) {
    return 'approval_response';
  }

  // 3. Cancel / update
  const cancelWords = [
    'cancel run', 'cancel task', 'stop run', 'stop task', 'abort run', 'abort task', 'kill run',
    'update step', 'change plan', 'modify task', 'cancel goal', 'delete goal'
  ];
  if (cancelWords.some(w => lowercase.includes(w))) {
    return 'cancel_or_update';
  }

  // 4. Status query
  const statusWords = [
    'status of', 'what is the status', 'show runs', 'get status', 'check status', 'list tasks',
    'list goals', 'list runs', 'how is the task', 'any update on', 'any status'
  ];
  if (statusWords.some(w => lowercase.includes(w))) {
    return 'status_query';
  }

  // 5. Durable task triggers
  const durableWords = [
    'remind', 'schedule', 'create', 'track', 'watch', 'follow up', 'summarize', 'draft',
    'investigate', 'open a task', 'notify me', 'add issue', 'create ticket', 'alert', 'run task',
    'execute command', 'monitor', 'backup', 'restore'
  ];
  if (durableWords.some(w => lowercase.includes(w))) {
    return 'durable_task';
  }

  // 6. Very short messages are usually chitchat or greeting
  if (text.length < 8) {
    return 'direct_reply';
  }

  // Fallback to LLM
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
  "intent": "INTENT_NAME"
}
Provide NO other text.`;

      const response = await ai.models.generateContent({
        model: selectedModel,
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const parsed = JSON.parse(response.text?.trim() || '{}');
      const intentStr = parsed.intent;
      const validCategories: IntentCategory[] = [
        'direct_reply', 'durable_task', 'status_query', 'approval_response', 'cancel_or_update', 'unsafe_or_unsupported'
      ];
      if (validCategories.includes(intentStr)) {
        return intentStr as IntentCategory;
      }
    } catch (err) {
      console.warn(`[Intent fallback error] Failing over to heuristic defaults.`, err);
    }
  }

  return 'direct_reply';
}
