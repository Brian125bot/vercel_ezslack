import { GoogleGenAI, Type, Schema } from '@google/genai';
import type { AgentPlanDraft, PlannedAgentStep } from './types.js';
import { agentStore } from '../storage/agentStore.js';
import { slog } from './log.js';
import { resolveModel } from './models.js';

interface MutationInstruction {
  action: 'add' | 'remove' | 'replace' | 'modify';
  stepIndex?: number;       // 0-based
  newStep?: PlannedAgentStep;
  field?: string;           // for 'modify': which field to change
  newValue?: any;           // for 'modify': new value
}

/**
 * W4-C: Natural Language Plan Mutation
 *
 * Given an existing plan and a user's natural-language instruction,
 * use Gemini to interpret the mutation, then apply it to the plan's
 * steps in the database.
 */
export async function mutatePlan(
  runId: string,
  planId: string,
  userInstruction: string,
  model: string
): Promise<{ success: boolean; summary: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { success: false, summary: 'GEMINI_API_KEY not configured' };
  }

  // Fetch current plan steps
  const steps = await agentStore.getStepsForPlan(planId);
  const run = await agentStore.getRun(runId);
  const goal = await agentStore.getGoal(run.goal_id);

  if (steps.length === 0) {
    return { success: false, summary: 'Plan has no steps to mutate' };
  }

  const stepsDescription = steps
    .map((s, i) => `${i}: [${s.status}] ${s.title} (tool: ${(s.input as any)?.toolName || 'none'}, kind: ${(s.input as any)?.kind || 'tool'})`)
    .join('\n');

  const responseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      mutations: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            action: { type: Type.STRING },
            stepIndex: { type: Type.NUMBER },
            newTitle: { type: Type.STRING },
            newToolName: { type: Type.STRING },
            newKind: { type: Type.STRING },
            newInput: { type: Type.OBJECT },
            reason: { type: Type.STRING }
          },
          required: ['action', 'reason']
        }
      },
      summary: { type: Type.STRING }
    },
    required: ['mutations', 'summary']
  };

  const ai = new GoogleGenAI({ apiKey });

  try {
    const response = await ai.models.generateContent({
      model: resolveModel(model),
      contents: `You are a plan mutation engine. A user wants to modify an AI agent plan.

Goal: ${goal.title}
Original instruction: ${goal.original_instruction}

Current plan steps:
${stepsDescription}

User's modification request: "${userInstruction}"

Rules:
- Only mutate steps that are "pending". Steps that are "succeeded", "running", or "blocked" cannot be changed.
- Supported actions: "add" (insert a new step), "remove" (delete a step), "replace" (swap a step entirely), "modify" (change a field on a step).
- For "add"/"replace": provide newTitle, newKind (tool/generate/note), newToolName (if tool kind), newInput.
- For "modify": provide stepIndex, the field to change, and the new value in newInput.
- For "remove": provide stepIndex.
- Always include a reason for each mutation.

Generate the mutations as JSON.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema
      }
    });

    if (!response.text) {
      return { success: false, summary: 'LLM returned empty response' };
    }

    const parsed = JSON.parse(response.text);
    const mutations = parsed.mutations || [];

    // Apply mutations
    let applied = 0;
    for (const mut of mutations) {
      const idx = mut.stepIndex;
      
      if (mut.action === 'remove' && idx !== undefined && idx >= 0 && idx < steps.length) {
        const step = steps[idx];
        if (step.status === 'pending') {
          await agentStore.updateStepStatus(step.id, 'skipped', { output: { reason: `Removed by plan mutation: ${mut.reason}` } });
          applied++;
        }
      } else if (mut.action === 'modify' && idx !== undefined && idx >= 0 && idx < steps.length) {
        const step = steps[idx];
        if (step.status === 'pending') {
          const newInput = { ...(step.input as any), ...mut.newInput };
          if (mut.newTitle) newInput.title = mut.newTitle;
          if (mut.newToolName) newInput.toolName = mut.newToolName;
          if (mut.newKind) newInput.kind = mut.newKind;
          await agentStore.updateStepInput(step.id, newInput);
          applied++;
        }
      } else if (mut.action === 'replace' && idx !== undefined && idx >= 0 && idx < steps.length) {
        const step = steps[idx];
        if (step.status === 'pending') {
          await agentStore.updateStepStatus(step.id, 'skipped', { output: { reason: `Replaced by plan mutation: ${mut.reason}` } });
          // Insert the replacement as a new step
          await agentStore.createStep({
            run_id: runId,
            plan_id: planId,
            order_index: step.order_index,
            title: mut.newTitle || step.title,
            status: 'pending',
            input: {
              kind: mut.newKind || 'tool',
              toolName: mut.newToolName,
              ...mut.newInput
            }
          });
          applied++;
        }
      } else if (mut.action === 'add') {
        const maxOrder = steps.reduce((max, s) => Math.max(max, s.order_index), 0);
        await agentStore.createStep({
          run_id: runId,
          plan_id: planId,
          order_index: maxOrder + 1,
          title: mut.newTitle || 'Added step',
          status: 'pending',
          input: {
            kind: mut.newKind || 'tool',
            toolName: mut.newToolName,
            ...mut.newInput
          }
        });
        applied++;
      }
    }

    await agentStore.appendAuditEvent({
      workspace_id: goal.workspace_id,
      goal_id: goal.id,
      run_id: runId,
      type: 'plan.mutated',
      actor: 'user',
      summary: `Plan mutation: ${parsed.summary} (${applied} changes applied)`,
      payload: { userInstruction, mutations, applied }
    });

    slog('planMutation', 'applied', { runId, applied, summary: parsed.summary });

    return {
      success: applied > 0,
      summary: parsed.summary || `${applied} mutation(s) applied`
    };
  } catch (err: any) {
    slog('planMutation', 'error', { runId, error: err.message });
    return { success: false, summary: `Mutation failed: ${err.message}` };
  }
}
