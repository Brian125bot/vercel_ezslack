import { CloudTasksClient } from '@google-cloud/tasks';
import { slog } from './log.js';

const client = new CloudTasksClient();

export async function enqueueRunTask(runId: string): Promise<void> {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION || 'us-west1';
  const queue = process.env.CLOUD_TASKS_QUEUE_NAME || 'slack-agent-queue';
  const url = process.env.APP_URL;
  const secret = process.env.INTERNAL_API_SECRET;

  if (!projectId || !url || !secret) {
    slog('taskClient', 'skip_enqueue', { runId, reason: 'Missing GCP_PROJECT_ID, APP_URL, or INTERNAL_API_SECRET configuration' });
    return;
  }

  const parent = client.queuePath(projectId, location, queue);
  const endpoint = `${url.replace(/\/$/, '')}/api/internal/worker/execute`;

  const task = {
    httpRequest: {
      httpMethod: 'POST' as const,
      url: endpoint,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`
      },
      body: Buffer.from(JSON.stringify({ runId })).toString('base64')
    }
  };

  try {
    const [response] = await client.createTask({ parent, task });
    slog('taskClient', 'enqueued_run', { runId, taskName: response.name });
  } catch (err: any) {
    slog('taskClient', 'enqueue_error', { runId, error: err.message });
  }
}

export async function enqueueSchedulerPollTask(): Promise<void> {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION || 'us-west1';
  const queue = process.env.CLOUD_TASKS_QUEUE_NAME || 'slack-agent-queue';
  const url = process.env.APP_URL;
  const secret = process.env.INTERNAL_API_SECRET;

  if (!projectId || !url || !secret) {
    slog('taskClient', 'skip_enqueue_poll', { reason: 'Missing GCP_PROJECT_ID, APP_URL, or INTERNAL_API_SECRET configuration' });
    return;
  }

  const parent = client.queuePath(projectId, location, queue);
  const endpoint = `${url.replace(/\/$/, '')}/api/internal/scheduler/poll`;

  const task = {
    httpRequest: {
      httpMethod: 'POST' as const,
      url: endpoint,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`
      }
    }
  };

  try {
    const [response] = await client.createTask({ parent, task });
    slog('taskClient', 'enqueued_poll', { taskName: response.name });
  } catch (err: any) {
    slog('taskClient', 'enqueue_poll_error', { error: err.message });
  }
}
