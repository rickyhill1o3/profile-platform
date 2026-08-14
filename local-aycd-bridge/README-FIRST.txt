THE SHORE SHACK AYCD BRIDGE

1. Keep AYCD open and enable AYCD > IMAP Server.
2. Keep the AYCD IMAP port/password configured in this helper.
3. Run start-aycd-bridge.bat and leave the black window open.
4. To import the ENTIRE AYCD archive, use Reset AYCD checkpoint once, then Scan AYCD now.

Bridge v8 scan order:
- Current/recent messages from the AYCD unified inbox first.
- Entire unified inbox history on first/reset scan (SEARCH ALL, no fixed message cap).
- Individual AYCD accounts after that for ongoing new-mail verification.

The first complete archive scan can be long if AYCD exposes thousands of messages. Progress is checkpointed after each historical batch, so it can resume.
