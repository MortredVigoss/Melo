// Pure routing decision for `melo-tts` CustomEvents fired by the Swift
// bridge. The point of the helper is the cross-engine stale-event guard:
// when playAudio terminates an in-flight `say`, the killed say's
// waitUntilExit returns and Swift dispatches `sayEnded` AFTER the new
// AVAudio bridgeRef is already installed. A stale sayEnded must NOT call
// the new bridgeRef's _onAudioEnded — that would clear the indicator and
// drop the _ttsAudio ref while AVAudio is still playing.

export function selectTtsBridgeCallback(detail, currentRef) {
  const action = detail?.action || '';
  if (!currentRef || typeof currentRef !== 'object') return null;
  if (action === 'audioEnded' || action === 'audioFailed') {
    if (currentRef.source !== 'avaudio') return null;
    return typeof currentRef._onAudioEnded === 'function'
      ? currentRef._onAudioEnded
      : null;
  }
  if (action === 'sayEnded') {
    if (currentRef.source !== 'say') return null;
    return typeof currentRef._onSayEnded === 'function'
      ? currentRef._onSayEnded
      : null;
  }
  return null;
}
