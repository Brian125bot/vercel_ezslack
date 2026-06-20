import { describe, it, expect } from 'vitest';
import { checkPolicy } from '../src/server/agent/policy.js';

describe('Policy Gate', () => {
  it('allows read operations', () => {
    const d = checkPolicy('read', 'memory.search');
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it('allows draft operations', () => {
    const d = checkPolicy('draft', 'draft.something');
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it('allows internal_write operations', () => {
    const d = checkPolicy('internal_write', 'memory.write');
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it('blocks external_write with approval required', () => {
    const d = checkPolicy('external_write', 'github.createIssue');
    expect(d.allowed).toBe(false);
    expect(d.requiresApproval).toBe(true);
  });

  it('blocks destructive operations without approval', () => {
    const d = checkPolicy('destructive', 'dangerous.action');
    expect(d.allowed).toBe(false);
    expect(d.requiresApproval).toBe(false);
  });

  it('blocks privileged operations without approval', () => {
    const d = checkPolicy('privileged', 'admin.action');
    expect(d.allowed).toBe(false);
    expect(d.requiresApproval).toBe(false);
  });
});
