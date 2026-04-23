export function buildReActOperatingInstructions({ kind = 'chat' } = {}) {
  if (kind === 'task') {
    return [
      'Agent execution loop (LangGraph/ReAct style):',
      '- Observe the task goal, lane identity, project state, and recent artifacts.',
      '- Decide internally what matters most before answering.',
      '- Use the available context blocks like observations, not as text to repeat blindly.',
      '- Keep internal reasoning private and respond with the final execution-ready answer only.',
      '- Stay grounded in the selected lane role and preserve the lane persona while solving the task.',
    ].join('\n');
  }

  return [
    'Agent execution loop (LangGraph/ReAct style):',
    '- Observe the latest user turn, recent thread memory, and continuity hints before answering.',
    '- Decide internally whether the user is continuing the current topic or starting a new one.',
    '- Treat project, connector, skill, and workspace context as observations you may use when relevant.',
    '- Think through the next best response internally, but never reveal chain-of-thought or scratchpad text.',
    '- Reply with the final user-facing answer only, while preserving the active agent persona.',
  ].join('\n');
}
