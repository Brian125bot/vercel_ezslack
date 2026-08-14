import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkPolicy, getPolicyProfile, getToolsForProfile, resolveAllowedTools } from '../src/server/agent/policy.js';
import { agentStore } from '../src/server/storage/agentStore.js';

vi.mock('../src/server/storage/agentStore.js', () => ({
  agentStore: {
    getChannelToolPolicy: vi.fn(),
    getWorkspaceToolPolicy: vi.fn()
  }
}));

describe('policy.ts', () => {
  it('checks policy for read/draft risk levels', () => {
    const res = checkPolicy('read', 'some action');
    expect(res.allowed).toBe(true);
    expect(res.requiresApproval).toBe(false);
    expect(res.reason).toBe('Safe read/draft operation');

    const resDraft = checkPolicy('draft', 'some action');
    expect(resDraft.allowed).toBe(true);
    expect(resDraft.requiresApproval).toBe(false);
    expect(resDraft.reason).toBe('Safe read/draft operation');
  });

  it('checks policy for internal_write risk level', () => {
    const res = checkPolicy('internal_write', 'some action');
    expect(res.allowed).toBe(true);
    expect(res.requiresApproval).toBe(false);
    expect(res.reason).toBe('Internal write permitted');
  });

  it('checks policy for external_write risk level', () => {
    const res = checkPolicy('external_write', 'some action');
    expect(res.allowed).toBe(true);
    expect(res.requiresApproval).toBe(true);
    expect(res.reason).toBe('External state modification requires explicit approval');
  });

  it('checks policy for destructive risk level', () => {
    const res = checkPolicy('destructive', 'some action');
    expect(res.allowed).toBe(false);
    expect(res.requiresApproval).toBe(false);
    expect(res.reason).toBe('Destructive actions are strictly blocked');
  });

  it('checks policy for privileged risk level', () => {
    const res = checkPolicy('privileged', 'some action');
    expect(res.allowed).toBe(false);
    expect(res.requiresApproval).toBe(false);
    expect(res.reason).toBe('Privileged operations are blocked');
  });

  it('checks policy for unknown risk level', () => {
    const res = checkPolicy('unknown' as any, 'some action');
    expect(res.allowed).toBe(false);
    expect(res.requiresApproval).toBe(false);
    expect(res.reason).toBe('Unknown risk level');
  });

  it('retrieves policy profiles and tools for profiles correctly', () => {
    const codingProfile = getPolicyProfile('coding');
    expect(codingProfile).toContain('sandbox.exec');

    const codingTools = getToolsForProfile('coding');
    expect(codingTools).toEqual(codingProfile);

    const researchProfile = getPolicyProfile('research');
    expect(researchProfile).toContain('search.query');
  });
});
