import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.SLACK_APPROVAL_ADMIN_IDS = 'UADMIN1,UADMIN2';
  process.env.SLACK_BOT_TOKEN = 'test-token';
  process.env.NODE_ENV = 'test';
});

let backgroundPromises: Promise<any>[] = [];

vi.mock('@vercel/functions', () => ({
  waitUntil: (promise: Promise<any>) => {
    backgroundPromises.push(promise);
    return promise;
  }
}));

const mockPostEphemeral = vi.fn().mockResolvedValue({ ok: true });
const mockWebClientInstance = {
  chat: {
    postEphemeral: mockPostEphemeral
  }
};

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => mockWebClientInstance)
}));

const { mockAgentStore, mockResumeAgentPipeline } = vi.hoisted(() => ({
  mockAgentStore: {
    getApprovalById: vi.fn(),
    resolveApproval: vi.fn(),
    getRunTrace: vi.fn(),
    appendAuditEvent: vi.fn(),
    updateRunStatus: vi.fn(),
    updateGoalStatus: vi.fn()
  },
  mockResumeAgentPipeline: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../src/server/storage/agentStore.js', () => ({ agentStore: mockAgentStore }));
vi.mock('../src/server/agent/orchestrator.js', () => ({ resumeAgentPipeline: mockResumeAgentPipeline }));

// Import the router and find the handler after hoisted setup
import { router } from '../src/server/routes.js';

const route = router.stack.find(s => s.route && s.route.path === '/slack/interactivity');
const interactivityHandler = route.route.stack[0].handle;

describe('Slack Interactivity Authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backgroundPromises = [];
    delete process.env.SLACK_SIGNING_SECRET;

    // Default mock behavior to prevent internal pipeline crash warnings
    mockAgentStore.getRunTrace.mockResolvedValue({
      goal: { workspace_id: 'ws-1' }
    });
  });

  const makePayload = (actionId: string, value: string, userId: string, channelId: string) => ({
    body: {
      payload: JSON.stringify({
        type: 'block_actions',
        user: { id: userId },
        channel: { id: channelId },
        actions: [{
          action_id: actionId,
          value: value
        }]
      })
    },
    headers: {}
  });

  const makeRes = () => {
    const res: any = {
      statusCode: 200,
      headersSent: false,
      status: vi.fn().mockImplementation((code) => {
        res.statusCode = code;
        return res;
      }),
      send: vi.fn().mockImplementation(() => {
        res.headersSent = true;
        return res;
      }),
      json: vi.fn().mockImplementation(() => {
        res.headersSent = true;
        return res;
      })
    };
    return res;
  };

  it('allows requester to approve', async () => {
    const approval = {
      id: 'app-1',
      requested_from_user_id: 'UREQUESTER',
      run_id: 'run-1',
      goal_id: 'goal-1',
      channel_id: 'C123'
    };
    mockAgentStore.getApprovalById.mockResolvedValue(approval);
    mockAgentStore.resolveApproval.mockResolvedValue({ ...approval, status: 'approved' });

    const req = makePayload('approval_approve_button', 'app-1', 'UREQUESTER', 'C123');
    const res = makeRes();

    await interactivityHandler(req as any, res as any, () => {});
    expect(res.statusCode).toBe(200);

    // Await background promises in waitUntil
    await Promise.all(backgroundPromises);

    expect(mockAgentStore.getApprovalById).toHaveBeenCalledWith('app-1');
    expect(mockAgentStore.resolveApproval).toHaveBeenCalledWith('app-1', 'approved');
    expect(mockResumeAgentPipeline).toHaveBeenCalledWith('run-1');
    expect(mockPostEphemeral).not.toHaveBeenCalled();
  });

  it('allows requester to reject', async () => {
    const approval = {
      id: 'app-1',
      requested_from_user_id: 'UREQUESTER',
      run_id: 'run-1',
      goal_id: 'goal-1',
      channel_id: 'C123'
    };
    mockAgentStore.getApprovalById.mockResolvedValue(approval);
    mockAgentStore.resolveApproval.mockResolvedValue({ ...approval, status: 'rejected' });

    const req = makePayload('approval_reject_button', 'app-1', 'UREQUESTER', 'C123');
    const res = makeRes();

    await interactivityHandler(req as any, res as any, () => {});
    expect(res.statusCode).toBe(200);

    await Promise.all(backgroundPromises);

    expect(mockAgentStore.getApprovalById).toHaveBeenCalledWith('app-1');
    expect(mockAgentStore.resolveApproval).toHaveBeenCalledWith('app-1', 'rejected');
    expect(mockAgentStore.updateRunStatus).toHaveBeenCalledWith('run-1', 'cancelled', { failure_reason: 'User rejected via Slack button.' });
    expect(mockAgentStore.updateGoalStatus).toHaveBeenCalledWith('goal-1', 'cancelled');
    expect(mockPostEphemeral).not.toHaveBeenCalled();
  });

  it('rejects unauthorized users and sends ephemeral warning + logs audit event', async () => {
    const approval = {
      id: 'app-1',
      requested_from_user_id: 'UREQUESTER',
      run_id: 'run-1',
      goal_id: 'goal-1',
      channel_id: 'C123'
    };
    mockAgentStore.getApprovalById.mockResolvedValue(approval);

    const req = makePayload('approval_approve_button', 'app-1', 'UNAUTHORIZED_USER', 'C123');
    const res = makeRes();

    await interactivityHandler(req as any, res as any, () => {});
    expect(res.statusCode).toBe(200);

    await Promise.all(backgroundPromises);

    expect(mockAgentStore.getApprovalById).toHaveBeenCalledWith('app-1');
    expect(mockAgentStore.resolveApproval).not.toHaveBeenCalled();

    // Verify Ephemeral message
    expect(mockPostEphemeral).toHaveBeenCalledWith({
      channel: 'C123',
      user: 'UNAUTHORIZED_USER',
      text: 'Only <@UREQUESTER> or an authorized admin can approve or reject this request.'
    });

    // Verify Audit Event
    expect(mockAgentStore.appendAuditEvent).toHaveBeenCalledWith({
      workspace_id: 'ws-1',
      goal_id: 'goal-1',
      run_id: 'run-1',
      type: 'approval.unauthorized_attempt',
      actor: 'UNAUTHORIZED_USER',
      summary: 'User UNAUTHORIZED_USER attempted to resolve an approval requested by UREQUESTER',
      payload: { approvalId: 'app-1', attemptedBy: 'UNAUTHORIZED_USER', requestedFrom: 'UREQUESTER' }
    });
  });

  it('allows administrator to bypass requester restriction', async () => {
    const approval = {
      id: 'app-1',
      requested_from_user_id: 'UREQUESTER',
      run_id: 'run-1',
      goal_id: 'goal-1',
      channel_id: 'C123'
    };
    mockAgentStore.getApprovalById.mockResolvedValue(approval);
    mockAgentStore.resolveApproval.mockResolvedValue({ ...approval, status: 'approved' });

    // Use admin user ID from SLACK_APPROVAL_ADMIN_IDS
    const req = makePayload('approval_approve_button', 'app-1', 'UADMIN1', 'C123');
    const res = makeRes();

    await interactivityHandler(req as any, res as any, () => {});
    expect(res.statusCode).toBe(200);

    await Promise.all(backgroundPromises);

    expect(mockAgentStore.getApprovalById).toHaveBeenCalledWith('app-1');
    expect(mockAgentStore.resolveApproval).toHaveBeenCalledWith('app-1', 'approved');
    expect(mockPostEphemeral).not.toHaveBeenCalled();
  });

  it('handles unauthorized attempt with null run_id safely without crashing or logging audit event', async () => {
    const approval = {
      id: 'app-1',
      requested_from_user_id: 'UREQUESTER',
      run_id: null,
      goal_id: 'goal-1',
      channel_id: 'C123'
    };
    mockAgentStore.getApprovalById.mockResolvedValue(approval);

    const req = makePayload('approval_approve_button', 'app-1', 'UNAUTHORIZED_USER', 'C123');
    const res = makeRes();

    await interactivityHandler(req as any, res as any, () => {});
    expect(res.statusCode).toBe(200);

    await Promise.all(backgroundPromises);

    expect(mockAgentStore.getApprovalById).toHaveBeenCalledWith('app-1');
    expect(mockAgentStore.resolveApproval).not.toHaveBeenCalled();

    // Still posts ephemeral message
    expect(mockPostEphemeral).toHaveBeenCalledWith({
      channel: 'C123',
      user: 'UNAUTHORIZED_USER',
      text: 'Only <@UREQUESTER> or an authorized admin can approve or reject this request.'
    });

    // Does NOT append audit event since run_id is null
    expect(mockAgentStore.appendAuditEvent).not.toHaveBeenCalled();
  });

  it('silently returns when approval record is not found', async () => {
    mockAgentStore.getApprovalById.mockResolvedValue(null);

    const req = makePayload('approval_approve_button', 'app-missing', 'UNAUTHORIZED_USER', 'C123');
    const res = makeRes();

    await interactivityHandler(req as any, res as any, () => {});
    expect(res.statusCode).toBe(200);

    await Promise.all(backgroundPromises);

    expect(mockAgentStore.getApprovalById).toHaveBeenCalledWith('app-missing');
    expect(mockAgentStore.resolveApproval).not.toHaveBeenCalled();
    expect(mockPostEphemeral).not.toHaveBeenCalled();
  });
});
