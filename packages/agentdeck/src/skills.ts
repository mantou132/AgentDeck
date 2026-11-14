import type { SkillBundle } from './agent/api';

/** Hash of `skills/`, defined at build time by `rsbuild.config.ts`, which emits the files as `skills.json`. */
declare const __SKILLS_HASH__: string;

export const skillsHash = __SKILLS_HASH__;

export const loadSkills = async () => {
  const response = await fetch('/skills.json');
  if (!response.ok) throw new Error(`Failed to load skills: ${response.status}`);
  return (await response.json()) as SkillBundle;
};
