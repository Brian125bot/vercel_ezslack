---
name: slack-communication
---

# Slack Communication Skill

Guidelines for communicating via Slack:

## Thread Replies
- Always reply in thread when responding to a user message
- Use `slack.replyInThread` tool with the original `channel_id` and `thread_ts`
- Keep replies focused and actionable

## Formatting
- Use Slack mrkdwn: `*bold*`, `_italic_`, `~strike~`, `` `code` ``, ``` ```code block``` ```
- Use bullet points for lists
- Use blockquotes (`>`) for quotes or important notes

## Tone
- Professional but friendly
- Concise - respect user's time
- Acknowledge receipt before long operations
- Summarize outcomes clearly

## Status Updates
- For long-running tasks, post intermediate updates every 30-60 seconds
- Use reactions (👀, ⚙️, ✅, ❌) for quick status signals
- Final response should include: what was done, any artifacts, next steps

## Error Communication
- Explain errors in user-friendly terms
- Suggest remediation steps
- Don't expose internal stack traces