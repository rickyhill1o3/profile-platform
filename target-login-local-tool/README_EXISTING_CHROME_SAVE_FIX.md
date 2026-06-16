# Existing Chrome save-session fix

This version reconnects to Chrome over `http://127.0.0.1:9222` at the moment you click **Save Session From Existing Chrome After Login**.

Use this flow:

1. Run `start-existing-chrome-debug.bat`.
2. In the Chrome window that opens, log in to Target manually.
3. Keep that Chrome window open. Do not close it.
4. Open `http://localhost:7777`.
5. Enter the Target email.
6. Click **Connect To Existing Chrome**.
7. Click **Save Session From Existing Chrome After Login**.

Saved sessions go to `target-login-local-tool/sessions/<email>.storageState.json`.
