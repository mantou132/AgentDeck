import type { SkillBundle } from './agent/api';

/** Hash of `skills/`, defined at build time by `rsbuild.config.ts`, which emits the files as `skills.json`. */
declare const __SKILLS_HASH__: string;
/** Group of each skill: its parent folder in `skills/`. */
declare const __SKILL_GROUPS__: Record<string, string>;

export const skillsHash = __SKILLS_HASH__;

export const skillGroups = __SKILL_GROUPS__;

export const loadSkills = async () => {
  const response = await fetch('/skills.json');
  if (!response.ok) throw new Error(`Failed to load skills: ${response.status}`);
  return (await response.json()) as SkillBundle;
};
