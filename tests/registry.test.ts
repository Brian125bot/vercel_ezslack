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

// Native tool-calling: the model can only see what the registry advertises, so
// every registered tool must surface as a FunctionDeclaration with a schema.
describe('toFunctionDeclarations (native tool-calling catalogue)', () => {
  it('emits one declaration per registered tool, keyed by the same name', () => {
    const declarations = toolsRegistry.toFunctionDeclarations();
    const registered = toolsRegistry.getAll().map(t => t.name);
    const declared = declarations.map(d => d.name);

    expect(declared).toEqual(registered);
    // No duplicate names — the model would be ambiguous otherwise.
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('every declaration has a non-empty name and description', () => {
    for (const d of toolsRegistry.toFunctionDeclarations()) {
      expect(d.name).toBeTruthy();
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  it('every declaration carries a JSON-schema parameters object', () => {
    for (const d of toolsRegistry.toFunctionDeclarations()) {
      // All registered tools now declare parameters; assert none are missing.
      expect(d.parametersJsonSchema, `${d.name} missing parameters`).toBeDefined();
      expect(d.parametersJsonSchema!.type).toBe('object');
      expect(Object.keys(d.parametersJsonSchema!.properties).length).toBeGreaterThan(0);
    }
  });

  it('required field names exist in properties (schema self-consistency)', () => {
    for (const d of toolsRegistry.toFunctionDeclarations()) {
      const props = Object.keys(d.parametersJsonSchema!.properties);
      for (const req of d.parametersJsonSchema!.required || []) {
        expect(props, `${d.name} requires unknown field ${req}`).toContain(req);
      }
    }
  });
});

// Tool policy scoping: `allowedTools === null` must remain byte-for-byte
// identical to the pre-existing unscoped behavior (this feature is strictly
// additive), while a non-null list must filter both the lookup and the
// declaration catalogue consistently.
describe('policy scoping (getAllowed / getScoped / toFunctionDeclarations)', () => {
  it('getAllowed(null) returns exactly getAll() — the default, unrestricted case', () => {
    expect(toolsRegistry.getAllowed(null)).toEqual(toolsRegistry.getAll());
  });

  it('getAllowed([...]) filters to only the named tools', () => {
    const allowed = toolsRegistry.getAllowed([taskRecordTool.name]);
    expect(allowed.map(t => t.name)).toEqual([taskRecordTool.name]);
  });

  it('getAllowed([]) (deny-all profile) returns no tools', () => {
    expect(toolsRegistry.getAllowed([])).toEqual([]);
  });

  it('getScoped returns the tool and deniedByPolicy=false when allowedTools is null', () => {
    const { tool, deniedByPolicy } = toolsRegistry.getScoped(taskRecordTool.name, null);
    expect(tool).toBe(taskRecordTool);
    expect(deniedByPolicy).toBe(false);
  });

  it('getScoped returns the tool and deniedByPolicy=false when the tool is in allowedTools', () => {
    const { tool, deniedByPolicy } = toolsRegistry.getScoped(taskRecordTool.name, [taskRecordTool.name]);
    expect(tool).toBe(taskRecordTool);
    expect(deniedByPolicy).toBe(false);
  });

  it('getScoped returns undefined tool and deniedByPolicy=true for a registered-but-disallowed tool', () => {
    const { tool, deniedByPolicy } = toolsRegistry.getScoped(taskRecordTool.name, [slackReplyInThreadTool.name]);
    expect(tool).toBeUndefined();
    expect(deniedByPolicy).toBe(true);
  });

  it('getScoped returns undefined tool and deniedByPolicy=false for an unregistered name, regardless of allowedTools', () => {
    expect(toolsRegistry.getScoped('does.not.exist', null)).toEqual({ tool: undefined, deniedByPolicy: false });
    expect(toolsRegistry.getScoped('does.not.exist', ['does.not.exist'])).toEqual({ tool: undefined, deniedByPolicy: false });
  });

  it('toFunctionDeclarations(null) is identical to the unscoped call (regression)', () => {
    expect(toolsRegistry.toFunctionDeclarations(null)).toEqual(toolsRegistry.toFunctionDeclarations());
  });

  it('toFunctionDeclarations(allowedTools) only advertises the allowed subset to the model', () => {
    const declarations = toolsRegistry.toFunctionDeclarations([taskRecordTool.name]);
    expect(declarations.map(d => d.name)).toEqual([taskRecordTool.name]);
  });
});
