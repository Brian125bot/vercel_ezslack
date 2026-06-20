import type { ExternalAdapter } from './base.js';
import type { AgentTool, ToolExecutionContext } from '../../agent/types.js';

interface GitHubIssueInput {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
}

/**
 * GitHub Issues adapter — creates issues via the GitHub REST API.
 * Requires GITHUB_TOKEN env var.
 */
export class GitHubIssueAdapter implements ExternalAdapter {
  name = 'GitHub Issues';
  description = 'Create and manage GitHub issues via the REST API.';

  isConfigured(): boolean {
    return !!process.env.GITHUB_TOKEN;
  }

  getTools(): AgentTool[] {
    return [this.createIssueTool];
  }

  private createIssueTool: AgentTool<GitHubIssueInput> = {
    name: 'github.createIssue',
    description: 'Create a GitHub issue. Requires owner, repo, title. Optional: body, labels.',
    riskLevel: 'external_write',
    requiresApproval: true,

    async execute(input: GitHubIssueInput, context: ToolExecutionContext) {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error('GITHUB_TOKEN is not configured');
      }

      const { owner, repo, title, body, labels } = input;
      if (!owner || !repo || !title) {
        throw new Error('owner, repo, and title are required');
      }

      const payload: any = { title };
      if (body) payload.body = body;
      if (labels && labels.length > 0) payload.labels = labels;

      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`GitHub API error (${response.status}): ${errorBody}`);
      }

      const issue = await response.json() as any;
      return {
        status: 'success',
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        title: issue.title
      };
    }
  };
}
