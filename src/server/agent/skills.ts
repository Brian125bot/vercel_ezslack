import { agentStore } from '../storage/agentStore.js';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '../../../skills');

export interface LoadedSkill {
  name: string;
  content: string;
  source: 'builtin' | 'workspace' | 'user';
  userId?: string;
}

export async function loadSkillsForWorkspace(
  workspaceId: string,
  userId?: string
): Promise<LoadedSkill[]> {
  const skills: LoadedSkill[] = [];

  // 1. Load builtin skills from files
  const builtinDir = join(SKILLS_DIR, 'builtin');
  if (existsSync(builtinDir)) {
    for (const file of readdirSync(builtinDir)) {
      if (file.endsWith('.md') || file.endsWith('.SKILL.md')) {
        const content = readFileSync(join(builtinDir, file), 'utf-8');
        skills.push({
          name: file.replace(/\.(md|SKILL\.md)$/, ''),
          content,
          source: 'builtin'
        });
      }
    }
  }

  // 2. Load workspace skills from DB
  const workspaceSkills = await agentStore.listSkills({
    workspace_id: workspaceId,
    scope: 'workspace'
  });
  for (const s of workspaceSkills) {
    skills.push({
      name: s.name,
      content: s.content,
      source: 'workspace'
    });
  }

  // 3. Load user skills from DB (if userId provided)
  if (userId) {
    const userSkills = await agentStore.listSkills({
      workspace_id: workspaceId,
      scope: 'user',
      user_id: userId
    });
    for (const s of userSkills) {
      skills.push({
        name: s.name,
        content: s.content,
        source: 'user',
        userId: s.user_id || undefined
      });
    }
  }

  return skills;
}

export function formatSkillsForPrompt(skills: LoadedSkill[]): string {
  if (skills.length === 0) return '';

  let output = '\n<skills>\n';
  output += 'The following skills are available to you. Apply their guidance when relevant to the task.\n\n';

  for (const skill of skills) {
    output += `--- SKILL: ${skill.name} (${skill.source}${skill.userId ? `, user:${skill.userId}` : ''}) ---\n`;
    output += skill.content.trim() + '\n\n';
  }

  output += '</skills>\n';
  return output;
}