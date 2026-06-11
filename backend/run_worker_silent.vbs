Set WshShell = CreateObject("WScript.Shell")
' Get the directory of this script to resolve paths dynamically
strScriptPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
' Construct command targeting virtual environment python and worker script in drain mode
cmd = """" & strScriptPath & "\.venv\Scripts\python.exe"" """ & strScriptPath & "\run_worker.py"" --drain"
' Run command hidden (0) and asynchronously (false)
WshShell.Run cmd, 0, false
