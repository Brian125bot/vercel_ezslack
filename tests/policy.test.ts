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

describe('resolveAllowedTools (workspace/channel tool policy precedence)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null (unrestricted) when no policy row exists at either level — default/pre-existing behavior', async () => {
    vi.mocked(agentStore.getChannelToolPolicy).mockResolvedValue(null);
    vi.mocked(agentStore.getWorkspaceToolPolicy).mockResolvedValue(null);

    const result = await resolveAllowedTools('ws-1', 'c-1');

    expect(result).toBeNull();
  });

  it('returns null (unrestricted) when channelId is null and no workspace-level row exists', async () => {
    vi.mocked(agentStore.getWorkspaceToolPolicy).mockResolvedValue(null);

    const result = await resolveAllowedTools('ws-1', null);

    expect(agentStore.getChannelToolPolicy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('a channel-level row wins over a workspace-level row, even if the workspace row exists', async () => {
    vi.mocked(agentStore.getChannelToolPolicy).mockResolvedValue({
      id: 'p-1', workspace_id: 'ws-1', channel_id: 'c-1', profile: 'coding',
      created_at: new Date(), updated_at: new Date()
    });

    const result = await resolveAllowedTools('ws-1', 'c-1');

    expect(result).toEqual(getPolicyProfile('coding'));
    // Channel row was decisive — workspace-level lookup must not even run.
    expect(agentStore.getWorkspaceToolPolicy).not.toHaveBeenCalled();
  });

  it('falls back to the workspace-level row when no channel-level row exists', async () => {
    vi.mocked(agentStore.getChannelToolPolicy).mockResolvedValue(null);
    vi.mocked(agentStore.getWorkspaceToolPolicy).mockResolvedValue({
      id: 'p-2', workspace_id: 'ws-1', channel_id: null, profile: 'research',
      created_at: new Date(), updated_at: new Date()
    });

    const result = await resolveAllowedTools('ws-1', 'c-1');

    expect(result).toEqual(getPolicyProfile('research'));
  });

  it('a profile value of "unrestricted" resolves to null regardless of level', async () => {
    vi.mocked(agentStore.getChannelToolPolicy).mockResolvedValue({
      id: 'p-3', workspace_id: 'ws-1', channel_id: 'c-1', profile: 'unrestricted',
      created_at: new Date(), updated_at: new Date()
    });

    const result = await resolveAllowedTools('ws-1', 'c-1');

    expect(result).toBeNull();
  });

  it('an unknown/corrupt profile value denies all tools ([]) rather than falling back to unrestricted or a different level', async () => {
    vi.mocked(agentStore.getChannelToolPolicy).mockResolvedValue({
      id: 'p-4', workspace_id: 'ws-1', channel_id: 'c-1', profile: 'not-a-real-profile',
      created_at: new Date(), updated_at: new Date()
    });

    const result = await resolveAllowedTools('ws-1', 'c-1');

    expect(result).toEqual([]);
    // No fallback to the workspace level on a corrupt channel-level value.
    expect(agentStore.getWorkspaceToolPolicy).not.toHaveBeenCalled();
  });
});
