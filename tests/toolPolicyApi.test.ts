import { describe, it, expect, vi, beforeEach } from 'vitest';
import { router } from '../src/server/routes.js';
import { agentStore } from '../src/server/storage/agentStore.js';

describe('Tool Policy Admin API Route Handlers', () => {
  let getHandlerFn: any;
  let putHandlerFn: any;
  let deleteHandlerFn: any;

  beforeEach(() => {
    // Locate the exact handlers registered on the express.Router
    const getRoute = router.stack.find(s => s.route?.path === '/agent/tool-policy' && s.route?.methods?.get);
    const putRoute = router.stack.find(s => s.route?.path === '/agent/tool-policy' && s.route?.methods?.put);
    const deleteRoute = router.stack.find(s => s.route?.path === '/agent/tool-policy/:id' && s.route?.methods?.delete);

    if (!getRoute || !putRoute || !deleteRoute) {
      throw new Error('Tool policy API routes not found on router');
    }

    getHandlerFn = getRoute.route.stack[getRoute.route.stack.length - 1].handle;
    putHandlerFn = putRoute.route.stack[putRoute.route.stack.length - 1].handle;
    deleteHandlerFn = deleteRoute.route.stack[deleteRoute.route.stack.length - 1].handle;
  });

  const createMockRes = () => {
    const res: any = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  };

  describe('GET /api/agent/tool-policy', () => {
    it('returns 400 when workspace_id query parameter is missing', async () => {
      const req: any = { query: {} };
      const res = createMockRes();

      await getHandlerFn(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'workspace_id is required' });
    });

    it('returns flat array of policy rows from agentStore', async () => {
      const mockPolicies = [
        { id: 'p-1', workspace_id: 'w-1', channel_id: null, profile: 'minimal' },
        { id: 'p-2', workspace_id: 'w-1', channel_id: 'c-1', profile: 'coding' }
      ];
      const listSpy = vi.spyOn(agentStore, 'listToolPolicies').mockResolvedValue(mockPolicies as any);

      const req: any = { query: { workspace_id: 'w-1' } };
      const res = createMockRes();

      await getHandlerFn(req, res);

      expect(listSpy).toHaveBeenCalledWith('w-1');
      expect(res.json).toHaveBeenCalledWith(mockPolicies);

      listSpy.mockRestore();
    });
  });

  describe('PUT /api/agent/tool-policy', () => {
    it('returns 400 when workspace_id is empty or missing', async () => {
      const req: any = { body: { workspace_id: '', profile: 'coding' } };
      const res = createMockRes();

      await putHandlerFn(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'workspace_id is required and must be a non-empty string' });
    });

    it('returns 400 when channel_id is provided but is empty string', async () => {
      const req: any = { body: { workspace_id: 'w-1', channel_id: '', profile: 'coding' } };
      const res = createMockRes();

      await putHandlerFn(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'channel_id must be a non-empty string if provided' });
    });

    it('returns 400 when profile is unrecognized', async () => {
      const req: any = { body: { workspace_id: 'w-1', profile: 'invalid_profile_name' } };
      const res = createMockRes();

      await putHandlerFn(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.stringContaining('Invalid profile value'));
    });

    it('successfully creates or updates a policy with valid parameters', async () => {
      const mockPolicy = { id: 'p-1', workspace_id: 'w-1', channel_id: 'c-1', profile: 'minimal' };
      const upsertSpy = vi.spyOn(agentStore, 'upsertToolPolicy').mockResolvedValue(mockPolicy as any);

      const req: any = { body: { workspace_id: 'w-1', channel_id: 'c-1', profile: 'minimal' } };
      const res = createMockRes();

      await putHandlerFn(req, res);

      expect(upsertSpy).toHaveBeenCalledWith('w-1', 'c-1', 'minimal');
      expect(res.json).toHaveBeenCalledWith(mockPolicy);

      upsertSpy.mockRestore();
    });

    it('successfully creates or updates a workspace-level policy (channel_id is null)', async () => {
      const mockPolicy = { id: 'p-1', workspace_id: 'w-1', channel_id: null, profile: 'coding' };
      const upsertSpy = vi.spyOn(agentStore, 'upsertToolPolicy').mockResolvedValue(mockPolicy as any);

      const req: any = { body: { workspace_id: 'w-1', profile: 'coding' } };
      const res = createMockRes();

      await putHandlerFn(req, res);

      expect(upsertSpy).toHaveBeenCalledWith('w-1', null, 'coding');
      expect(res.json).toHaveBeenCalledWith(mockPolicy);

      upsertSpy.mockRestore();
    });
  });

  describe('DELETE /api/agent/tool-policy/:id', () => {
    it('returns 404 when policy does not exist', async () => {
      const deleteSpy = vi.spyOn(agentStore, 'deleteToolPolicy').mockResolvedValue(false);

      const req: any = { params: { id: 'p-999' } };
      const res = createMockRes();

      await deleteHandlerFn(req, res);

      expect(deleteSpy).toHaveBeenCalledWith('p-999');
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Tool policy p-999 not found' });

      deleteSpy.mockRestore();
    });

    it('returns success when policy is deleted', async () => {
      const deleteSpy = vi.spyOn(agentStore, 'deleteToolPolicy').mockResolvedValue(true);

      const req: any = { params: { id: 'p-1' } };
      const res = createMockRes();

      await deleteHandlerFn(req, res);

      expect(deleteSpy).toHaveBeenCalledWith('p-1');
      expect(res.json).toHaveBeenCalledWith({ success: true });

      deleteSpy.mockRestore();
    });
  });
});
