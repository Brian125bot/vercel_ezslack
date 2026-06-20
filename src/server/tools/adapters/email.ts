import type { ExternalAdapter } from './base.js';
import type { AgentTool, ToolExecutionContext } from '../../agent/types.js';

interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
}

/**
 * Email adapter — sends email via a simple SMTP/webhook relay.
 * Requires EMAIL_WEBHOOK_URL env var pointing to a service that accepts
 * POST { to, subject, body } and dispatches the email.
 *
 * This is intentionally simple.  In production, replace the webhook
 * with nodemailer or a transactional email service (SendGrid, SES).
 */
export class EmailAdapter implements ExternalAdapter {
  name = 'Email';
  description = 'Send email messages via a configured webhook relay.';

  isConfigured(): boolean {
    return !!process.env.EMAIL_WEBHOOK_URL;
  }

  getTools(): AgentTool[] {
    return [this.sendEmailTool];
  }

  private sendEmailTool: AgentTool<SendEmailInput> = {
    name: 'email.send',
    description: 'Send an email. Requires to, subject, body.',
    riskLevel: 'external_write',
    requiresApproval: true,

    async execute(input: SendEmailInput, context: ToolExecutionContext) {
      const webhookUrl = process.env.EMAIL_WEBHOOK_URL;
      if (!webhookUrl) {
        throw new Error('EMAIL_WEBHOOK_URL is not configured');
      }

      const { to, subject, body } = input;
      if (!to || !subject || !body) {
        throw new Error('to, subject, and body are required');
      }

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, body })
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Email webhook error (${response.status}): ${errorBody}`);
      }

      return {
        status: 'success',
        to,
        subject,
        message: 'Email dispatched'
      };
    }
  };
}
