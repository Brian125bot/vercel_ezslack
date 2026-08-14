import { beforeEach, describe, it, expect, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn()
}));

vi.mock('../src/server/storage/db.js', () => ({
  query: mockQuery
}));

import { checkPolicy, getPolicyProfile, getToolsForProfile, resolveAllowedTools } from '../src/server/agent/policy.js';

describe('policy.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('resolveAllowedTools returns null when no row exists', async () => {
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(resolveAllowedTools('ws-1', 'C1')).resolves.toBeNull();

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('workspace_id = $1 AND channel_id = $2'),
      ['ws-1', 'C1']
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('channel_id IS NULL'),
      ['ws-1']
    );
  });

  it('resolveAllowedTools lets channel-level rows win over workspace rows, including unrestricted', async () => {
    mockQuery.mockResolvedValueOnce([{ profile: 'unrestricted' }]);

    await expect(resolveAllowedTools('ws-1', 'C1')).resolves.toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('resolveAllowedTools applies workspace-level profile only when no channel row exists', async () => {
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ profile: 'minimal' }]);

    await expect(resolveAllowedTools('ws-1', 'C1')).resolves.toEqual(['slack.replyInThread']);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('resolveAllowedTools skips the channel lookup when channelId is null', async () => {
    mockQuery.mockResolvedValueOnce([{ profile: 'messaging' }]);

    await expect(resolveAllowedTools('ws-1', null)).resolves.toEqual(['slack.replyInThread', 'slack.react']);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('channel_id IS NULL'), ['ws-1']);
  });

  it('resolveAllowedTools denies all for an unrecognized channel-level profile without fallback', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce([{ profile: 'corrupt' }]);

    await expect(resolveAllowedTools('ws-1', 'C1')).resolves.toEqual([]);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('resolveAllowedTools denies all for an unrecognized workspace-level profile', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ profile: 'corrupt' }]);

    await expect(resolveAllowedTools('ws-1', 'C1')).resolves.toEqual([]);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
