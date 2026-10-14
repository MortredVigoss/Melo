// Chat mode catalogue — sub-phase 7d-5δ commit 7a of the desktopStore
// decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Static three-entry array describing the available chat modes (chat /
// cowork / code) with their UI label and the persona prompt the runner
// hands to the model. Pure data, no dependencies. Pulled out as a leaf
// module so the chat execution graph runner (commit 7b of this phase)
// can import the catalogue without re-importing desktopStore.

export const MODE_DEFS = [
  {
    id: 'chat',
    label: 'Chat',
    prompt:
      'You are Melo Chat. Focus on clear answers, planning, and steady collaboration.',
  },
  {
    id: 'cowork',
    label: 'Cowork',
    prompt:
      'You are Melo Cowork. Collaborate like a thoughtful teammate, keep momentum, and suggest next steps.',
  },
  {
    id: 'code',
    label: 'Code',
    prompt:
      'You are Melo Code. Be implementation-focused, structured, and explicit about technical tradeoffs.',
  },
];
