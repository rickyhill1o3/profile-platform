THE SHORE SHACK AYCD BRIDGE

1. Extract the entire ZIP before running anything.
2. Open the local-aycd-bridge folder.
3. Double-click start-aycd-bridge.bat.
4. Keep the black command window open.
5. Your browser should open http://127.0.0.1:43821 automatically.
6. Enter the pairing code from Order Tracker and your AYCD IMAP settings.

If Chrome says 127.0.0.1 refused to connect, the helper is not running.
Run test-aycd-bridge.bat. If startup fails, send install-log.txt or a screenshot
of the black command window. This error happens before AYCD credentials are used.

DIRECT ACCOUNT SCANNING (v7)
The bridge now logs into exposed AYCD accounts individually rather than reading inbox@aycd.me.
Use the same AYCD IMAP Server password. The username field on the local setup page is only used by the Test button.
Each mailbox receives its own checkpoint, and the exact mailbox email is sent to the website with every message.
