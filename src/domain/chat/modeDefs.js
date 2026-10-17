// Chat mode catalogue — sub-phase 7d-5δ commit 7a of the desktopStore
// decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Static three-entry array describing the available chat modes (chat /
// cowork / code) with their UI label and the persona prompt the runner
// hands to the model. Pure data, no dependencies. Pulled out as a leaf
// module so the chat execution graph runner (commit 7b of this phase)
// can import the catalogue without re-importing desktopStore.

// 2026-10-17 (audit B-10): modes are working styles layered on the selected
// agent, not a second identity. They used to open with "You are Melo Chat /
// Cowork / Code" right after the agent section's "User-selected role: …",
// which diluted custom personas with a competing "You are".
export const MODE_DEFS = [
  {
    id: 'chat',
    label: 'Chat',
    prompt:
      'Working style (Chat): focus on clear answers, planning, and steady collaboration. This adjusts style only; the selected role above stays who you are.',
  },
  {
    id: 'cowork',
    label: 'Cowork',
    prompt:
      'Working style (Cowork): collaborate like a thoughtful teammate, keep momentum, and suggest next steps. This adjusts style only; the selected role above stays who you are.',
  },
  {
    id: 'code',
    label: 'Code',
    prompt:
      'Working style (Code): be implementation-focused, structured, and explicit about technical tradeoffs. This adjusts style only; the selected role above stays who you are.',
  },
];
