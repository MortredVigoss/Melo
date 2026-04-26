// Curated local-command templates — sub-phase 7d-5γ commit 1 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Holds the static `COMMAND_TEMPLATES` registry (used by the workspace
// snapshot UI, the command runner, and the tool-routing prompt) plus
// the `commandTemplateDescriptor` shaper that turns a template into the
// minimal client-facing payload. Both are pure data / pure functions —
// no desktopStore-local dependencies — so they ship together as a
// single self-contained leaf.

export const COMMAND_TEMPLATES = [
  {
    id: 'pwd',
    label: 'Show working directory',
    command: 'pwd',
    args: () => [],
    description: 'Confirm the current project workspace root.',
  },
  {
    id: 'list-files',
    label: 'List files',
    command: 'ls',
    args: () => ['-la'],
    description: 'Show files at the workspace root.',
  },
  {
    id: 'git-status',
    label: 'Git status',
    command: 'git',
    args: () => ['status', '--short', '--branch'],
    description: 'Inspect local repository state.',
  },
  {
    id: 'npm-build',
    label: 'Run build',
    command: 'npm',
    args: () => ['run', 'build'],
    description: 'Run the workspace build command if the project supports it.',
  },
  {
    id: 'search-text',
    label: 'Search text',
    command: 'rg',
    requiresInput: true,
    inputPlaceholder: 'Search term',
    args: query => ['--line-number', '--hidden', '--glob', '!.git', '--glob', '!node_modules', query],
    description: 'Search the workspace with ripgrep.',
  },
];

export function commandTemplateDescriptor(template) {
  return {
    id: template.id,
    label: template.label,
    description: template.description,
    requiresInput: Boolean(template.requiresInput),
    inputPlaceholder: template.inputPlaceholder || '',
  };
}
