on fileExists(posixPath)
  tell application "System Events"
    return exists disk item (POSIX file posixPath)
  end tell
end fileExists

on run
  set appBundlePath to POSIX path of (path to me)
  set bundleDir to do shell script ("/usr/bin/dirname " & quoted form of appBundlePath)
  set siblingProjectDir to bundleDir & "/Melo Desktop Project"
  set localLaunchScriptPath to bundleDir & "/Melo.command"
  set siblingLaunchScriptPath to siblingProjectDir & "/Melo.command"
  set projectDir to bundleDir
  set launchScriptPath to localLaunchScriptPath

  if not fileExists(localLaunchScriptPath) then
    set projectDir to siblingProjectDir
    set launchScriptPath to siblingLaunchScriptPath
  end if

  if fileExists(launchScriptPath) then
    set scriptExists to "yes"
  else
    set scriptExists to "no"
  end if
  set debugOutput to "appBundlePath=" & appBundlePath & linefeed & "bundleDir=" & bundleDir & linefeed & "projectDir=" & projectDir & linefeed & "launchScriptPath=" & launchScriptPath & linefeed & "scriptExists=" & scriptExists & linefeed

  do shell script ("/bin/mkdir -p " & quoted form of (projectDir & "/.tmp"))
  do shell script ("/usr/bin/printf %s " & quoted form of debugOutput & " > " & quoted form of (projectDir & "/.tmp/launcher-debug.txt"))

  set launchCommand to "zsh " & quoted form of launchScriptPath
  tell application "Terminal" to activate
  tell application "Terminal" to do script launchCommand
end run
