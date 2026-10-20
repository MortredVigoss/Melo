// Runtime fixtures create local accounts/chats and enable Accessibility. Never
// dispatch this suite to a personal handset or an unselected second device.
export function fixtureEmulator(devices, requested) {
  const rows = devices.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(row => row.length >= 2 && !['List', '*'].includes(row[0]));
  if (rows.length !== 1 || rows[0][1] !== 'device' || !rows[0][0].startsWith('emulator-') || requested && requested !== rows[0][0]) {
    throw new Error('Android runtime fixtures require exactly one ready Emulator and no other devices on this ADB server; ANDROID_SERIAL must select that Emulator. No device was modified.');
  }
  return rows[0][0];
}
