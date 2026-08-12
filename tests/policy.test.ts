import { describe, it, expect, vi } from 'vitest';
import { checkPolicy, getPolicyProfile, getToolsForProfile, resolveAllowedTools, POLICY_PROFILES } from '../src/server/agent/policy.js';
import { agentStore } from '../src/server/storage/agentStore.js';

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

  describe('resolveAllowedTools', () => {
    it('returns null when no policy row exists at all', async () => {
      const getChannelSpy = vi.spyOn(agentStore, 'getChannelPolicy').mockResolvedValue(null);
      const getWorkspaceSpy = vi.spyOn(agentStore, 'getWorkspacePolicy').mockResolvedValue(null);

      const res = await resolveAllowedTools('w-1', 'c-1');
      expect(res).toBeNull();

      expect(getChannelSpy).toHaveBeenCalledWith('w-1', 'c-1');
      expect(getWorkspaceSpy).toHaveBeenCalledWith('w-1');

      getChannelSpy.mockRestore();
      getWorkspaceSpy.mockRestore();
    });

    it('returns null when channelId is null and no workspace policy exists', async () => {
      const getWorkspaceSpy = vi.spyOn(agentStore, 'getWorkspacePolicy').mockResolvedValue(null);

      const res = await resolveAllowedTools('w-1', null);
      expect(res).toBeNull();

      expect(getWorkspaceSpy).toHaveBeenCalledWith('w-1');

      getWorkspaceSpy.mockRestore();
    });

    it('returns tools list when workspace policy exists and channel policy does not', async () => {
      const getChannelSpy = vi.spyOn(agentStore, 'getChannelPolicy').mockResolvedValue(null);
      const getWorkspaceSpy = vi.spyOn(agentStore, 'getWorkspacePolicy').mockResolvedValue({
        id: 'p-1',
        workspace_id: 'w-1',
        channel_id: null,
        profile: 'minimal',
        created_at: new Date(),
        updated_at: new Date()
      });

      const res = await resolveAllowedTools('w-1', 'c-1');
      expect(res).toEqual(['slack.replyInThread']);

      getChannelSpy.mockRestore();
      getWorkspaceSpy.mockRestore();
    });

    it('returns null when workspace policy profile is unrestricted', async () => {
      const getChannelSpy = vi.spyOn(agentStore, 'getChannelPolicy').mockResolvedValue(null);
      const getWorkspaceSpy = vi.spyOn(agentStore, 'getWorkspacePolicy').mockResolvedValue({
        id: 'p-1',
        workspace_id: 'w-1',
        channel_id: null,
        profile: 'unrestricted',
        created_at: new Date(),
        updated_at: new Date()
      });

      const res = await resolveAllowedTools('w-1', 'c-1');
      expect(res).toBeNull();

      getChannelSpy.mockRestore();
      getWorkspaceSpy.mockRestore();
    });

    it('returns [] and logs error when workspace policy is unrecognized (fail closed)', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const getChannelSpy = vi.spyOn(agentStore, 'getChannelPolicy').mockResolvedValue(null);
      const getWorkspaceSpy = vi.spyOn(agentStore, 'getWorkspacePolicy').mockResolvedValue({
        id: 'p-1',
        workspace_id: 'w-1',
        channel_id: null,
        profile: 'corrupted_value',
        created_at: new Date(),
        updated_at: new Date()
      });

      const res = await resolveAllowedTools('w-1', 'c-1');
      expect(res).toEqual([]);
      expect(consoleErrorSpy).toHaveBeenCalled();

      getChannelSpy.mockRestore();
      getWorkspaceSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('prioritizes channel-level policy over workspace-level policy', async () => {
      const getChannelSpy = vi.spyOn(agentStore, 'getChannelPolicy').mockResolvedValue({
        id: 'p-c',
        workspace_id: 'w-1',
        channel_id: 'c-1',
        profile: 'minimal',
        created_at: new Date(),
        updated_at: new Date()
      });
      const getWorkspaceSpy = vi.spyOn(agentStore, 'getWorkspacePolicy');

      const res = await resolveAllowedTools('w-1', 'c-1');
      expect(res).toEqual(['slack.replyInThread']);
      expect(getWorkspaceSpy).not.toHaveBeenCalled();

      getChannelSpy.mockRestore();
      getWorkspaceSpy.mockRestore();
    });

    it('prioritizes channel-level unrestricted over workspace-level minimal', async () => {
      const getChannelSpy = vi.spyOn(agentStore, 'getChannelPolicy').mockResolvedValue({
        id: 'p-c',
        workspace_id: 'w-1',
        channel_id: 'c-1',
        profile: 'unrestricted',
        created_at: new Date(),
        updated_at: new Date()
      });
      const getWorkspaceSpy = vi.spyOn(agentStore, 'getWorkspacePolicy');

      const res = await resolveAllowedTools('w-1', 'c-1');
      expect(res).toBeNull();
      expect(getWorkspaceSpy).not.toHaveBeenCalled();

      getChannelSpy.mockRestore();
      getWorkspaceSpy.mockRestore();
    });

    it('returns [] and logs error immediately on unrecognized channel policy without checking workspace-level (fail closed)', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const getChannelSpy = vi.spyOn(agentStore, 'getChannelPolicy').mockResolvedValue({
        id: 'p-c',
        workspace_id: 'w-1',
        channel_id: 'c-1',
        profile: 'corrupted_value',
        created_at: new Date(),
        updated_at: new Date()
      });
      const getWorkspaceSpy = vi.spyOn(agentStore, 'getWorkspacePolicy');

      const res = await resolveAllowedTools('w-1', 'c-1');
      expect(res).toEqual([]);
      expect(getWorkspaceSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();

      getChannelSpy.mockRestore();
      getWorkspaceSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });
});
