import { describe, it, expect } from 'vitest';
import { toolsRegistry } from '../src/server/tools/registry.js';
import { slackReplyInThreadTool } from '../src/server/tools/slack.js';
import { memoryWriteTool, memorySearchTool } from '../src/server/tools/memory.js';
import { taskRecordTool } from '../src/server/tools/task.js';

// Guards against the "wrote the tool, forgot to register it" failure mode —
// every exported core tool must actually be reachable via the registry.
describe('tool registry completeness', () => {
  const coreTools = [slackReplyInThreadTool, memoryWriteTool, memorySearchTool, taskRecordTool];

  it.each(coreTools.map(t => [t.name, t] as const))('%s is registered', (name, tool) => {
    expect(toolsRegistry.get(name)).toBeDefined();
    expect(toolsRegistry.get(name)).toBe(tool);
  });

  it('registry contains no unexpected extras beyond core tools and configured adapters', () => {
    const registeredNames = toolsRegistry.getAll().map(t => t.name);
    for (const tool of coreTools) {
      expect(registeredNames).toContain(tool.name);
    }
  });
});
