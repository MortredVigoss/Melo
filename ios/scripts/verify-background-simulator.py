#!/usr/bin/env python3
"""Run the fixture-only native background acceptance on an already booted QA simulator.

Usage: python3 ios/scripts/verify-background-simulator.py SIMULATOR_UUID
Install a Debug Melo build on that disposable simulator first. No real providers,
device installs, accounts, or user chat folders are used by the diagnostic.
"""
import json, subprocess, sys, time
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sim = sys.argv[1]
bundle = sys.argv[2] if len(sys.argv) > 2 else 'com.melo.iphone.mfpiao'
def simctl(*args):
    return subprocess.check_output(['xcrun', 'simctl', *args], text=True).strip()
container = Path(simctl('get_app_container', sim, bundle, 'data'))
report = container / 'Library/Application Support/background-verification.json'
report.unlink(missing_ok=True)  # Only our diagnostic result, never chat data.
evidence = root / '.tmp/ios-background'
evidence.mkdir(parents=True, exist_ok=True)
print(simctl('launch', sim, bundle, '-melo-verify-background'), flush=True)
deadline = time.monotonic() + 50
switched = False
returned = False
switched_at = None
while time.monotonic() < deadline:
    if report.exists():
        result = json.loads(report.read_text())
        if result.get('failure') or result.get('phase') == 'complete':
            (evidence / 'simulator-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
            sys.exit(0 if result.get('passed') else 1)
        if not switched and result.get('phase') == 'ready-to-background':
            print(simctl('launch', sim, 'com.apple.Preferences'), flush=True)
            switched = True
            switched_at = time.monotonic()
            print('Switched to Settings while reply is pending; no debugger attached', flush=True)
        if switched and not returned and time.monotonic() - switched_at > 18:
            # The allowance ends on reply completion. The unrelated diagnostic
            # timer can then be suspended; bring the app back for assertions.
            snapshot = Path(result['directory']) / 'real-allowance/conversations.json'
            data = json.loads(snapshot.read_text())
            if len(data['chats'][0]['messages']) != 2:
                raise SystemExit('Reply was not saved while the app was backgrounded')
            print(simctl('launch', sim, bundle), flush=True)
            returned = True
    time.sleep(.2)
raise SystemExit('Native background acceptance timed out; inspect simulator logs')
