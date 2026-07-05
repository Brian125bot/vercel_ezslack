import type { AgentPlanDraft, AgentRiskLevel, PlannedAgentStep, StepKind } from './types.js';

/**
 * Pure, network-free post-processing for a raw plan draft returned by the LLM.
 *
 * Responsibilities (WS2 — Planner robustness):
 *  - Coerce the free-text `riskLevel` the model emits (e.g. "low"/"medium"/
 *    "high") into the strict AgentRiskLevel enum.
 *  - Validate every step's tool against the live registry WITHOUT poisoning the
 *    whole plan: an unknown / unavailable tool is converted into a safe `note`
 *    step (so the rest of the multistep plan still executes) and only that step
 *    is flagged.
 *  - Reconcile plan-level `requiresApproval` with reality: approval is required
 *    iff at least one *executable* step maps to a tool whose risk is
 *    external_write / destructive / privileged. This stops the model from
 *    gating (or failing) plans that take no external action.
 *  - Guarantee `generate` steps have a usable prompt and normalise step kinds.
 */

export interface ToolLookup {
  get(name: string): { name: string; riskLevel: AgentRiskLevel } | undefined;
}

const VALID_RISK: AgentRiskLevel[] = ['read', 'draft', 'internal_write', 'external_write', 'destructive', 'privileged'];
const APPROVAL_RISKS: AgentRiskLevel[] = ['external_write', 'destructive', 'privileged'];

export function normalizeRiskLevel(raw: any): AgentRiskLevel {
  if (typeof raw === 'string') {
    const r = raw.toLowerCase().trim();
    if ((VALID_RISK as string[]).includes(r)) return r as AgentRiskLevel;
    // Map common free-text labels the LLM tends to emit.
    if (r === 'none' || r === 'low' || r === 'safe' || r === 'minimal') return 'read';
    if (r === 'medium' || r === 'moderate' || r === 'internal') return 'internal_write';
    if (r === 'high' || r === 'external' || r === 'write') return 'external_write';
    if (r === 'critical' || r === 'severe') return 'destructive';
  }
  return 'internal_write';
}

function normalizeStepKind(step: PlannedAgentStep): StepKind {
  const k = (step.kind as string | undefined)?.toLowerCase();
  if (k === 'generate' || k === 'note' || k === 'tool') return k as StepKind;
  // Some models put the kind in toolName (e.g. toolName: "generate").
  const tn = (step.toolName as string | undefined)?.toLowerCase();
  if (tn === 'generate' || tn === 'note') return tn as StepKind;
  return step.toolName ? 'tool' : 'note';
}

export interface NormalizeResult {
  plan: AgentPlanDraft;
  /** Titles of steps that referenced an unknown/unavailable tool. */
  redactedTools: string[];
}

export function normalizePlanDraft(draft: AgentPlanDraft, tools: ToolLookup): NormalizeResult {
  const redactedTools: string[] = [];

  const steps: PlannedAgentStep[] = (draft.steps || []).map((rawStep) => {
    const step: PlannedAgentStep = { ...rawStep };
    if (typeof step.injectInto === 'string' && step.injectInto.length <= 100) {
      // keep
    } else {
      step.injectInto = undefined;
    }
    const kind = normalizeStepKind(step);

    if (kind === 'generate') {
      step.kind = 'generate';
      step.toolName = undefined;
      // Guarantee the generate step has something to work with.
      const prompt = step.input?.prompt || step.input?.input?.prompt;
      step.input = { ...(step.input || {}), prompt: prompt || step.title };
      if (step.injectInto) {
        step.input.injectInto = step.injectInto;
      }
      return step;
    }

    if (kind === 'note') {
      step.kind = 'note';
      step.toolName = undefined;
      return step;
    }

    // kind === 'tool'
    step.kind = 'tool';
    if (!step.toolName || !tools.get(step.toolName)) {
      // Unknown / unavailable tool: degrade THIS step to a note instead of
      // poisoning the entire plan. The note records what was intended.
      redactedTools.push(step.toolName || step.title);
      return {
        title: step.title,
        kind: 'note' as StepKind,
        toolName: undefined,
        input: { unavailableTool: step.toolName || null, note: `Intended action "${step.title}" was skipped because no matching tool is available.` }
      };
    }
    // Normalise nested input shape: executor reads step.input.input for tools.
    if (step.input && step.input.input === undefined && step.toolName) {
      // leave as-is; executor falls back to {} — keep author intent
    }
    return step;
  });

  // Reconcile approval: only required if an executable tool step is high-risk.
  const requiresApproval = steps.some((s) => {
    if (s.kind !== 'tool' || !s.toolName) return false;
    const t = tools.get(s.toolName);
    return !!t && APPROVAL_RISKS.includes(t.riskLevel);
  });

  let riskLevel = normalizeRiskLevel(draft.riskLevel);
  if (requiresApproval && !APPROVAL_RISKS.includes(riskLevel)) {
    riskLevel = 'external_write';
  }
  if (!requiresApproval && APPROVAL_RISKS.includes(riskLevel)) {
    // The model over-rated risk but no step actually acts externally.
    riskLevel = 'internal_write';
  }

  return {
    plan: {
      summary: draft.summary || 'Execute the requested instruction',
      assumptions: draft.assumptions || [],
      steps,
      riskLevel,
      requiresApproval
    },
    redactedTools
  };
}
