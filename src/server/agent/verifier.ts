import type { AgentRunTrace } from '../storage/types.js';
import type { VerificationResult } from './types.js';

export function verifyRun(trace: AgentRunTrace): VerificationResult {
  const steps = trace.steps || [];
  
  if (steps.length === 0) {
    return {
      status: 'not_satisfied',
      confidence: 1,
      reasons: ['No steps were planned or executed.'],
      recommendedNextAction: 'replan'
    };
  }

  let allSucceeded = true;
  let anyBlocked = false;
  let slackFailed = false;

  const reasons: string[] = [];

  for (const step of steps) {
    if (step.status === 'blocked') {
      anyBlocked = true;
      allSucceeded = false;
      reasons.push(`Step '${step.title}' was blocked.`);
    } else if (step.status === 'failed') {
      allSucceeded = false;
      reasons.push(`Step '${step.title}' failed: ${step.error}`);
      
      const stepInput = step.input as any;
      if (stepInput?.toolName === 'slack.replyInThread') {
        slackFailed = true;
      }
    } else if (step.status !== 'succeeded' && step.status !== 'skipped') {
      allSucceeded = false;
      reasons.push(`Step '${step.title}' is in status '${step.status}'.`);
    }
  }

  if (anyBlocked) {
    return {
      status: 'blocked',
      confidence: 1,
      reasons,
      recommendedNextAction: 'block'
    };
  }

  if (slackFailed) {
    return {
      status: 'not_satisfied',
      confidence: 1,
      reasons,
      recommendedNextAction: 'retry'
    };
  }

  if (allSucceeded) {
    return {
      status: 'satisfied',
      confidence: 1,
      reasons: ['All steps succeeded.'],
      recommendedNextAction: 'complete'
    };
  }

  return {
    status: 'partially_satisfied',
    confidence: 0.8,
    reasons,
    recommendedNextAction: 'ask_user'
  };
}
