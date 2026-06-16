# Target Local Login Tool

This is a separate local-only helper. It is not Render-hosted. It opens a real Chromium window on your Windows PC so you can manually complete Target login through the same proxy used by the checkout.

## Install

Open PowerShell or VS Code terminal:

```bash
cd C:\Users\Ricky Hill\Downloads\profile-platform-main\target-login-local-tool
npm install
npx playwright install chromium
copy .env.example .env
npm start
```

Then open:

```text
http://localhost:7777
```

## Use

1. Paste the Target account email.
2. Paste the checkout proxy, e.g. `46.203.173.196:36612:DZgHm83n:RqLRyRoq`.
3. Click **Open Chrome + Capture Session**.
4. Complete the Target login manually in the Chrome window.
5. Come back to the local tool and click **Save Session After Login**.

Sessions are stored in `sessions/` and are separated by Target account email.

## Why this exists

Render cannot open a visible browser. Browserless requires a paid cloud-unit plan to use third-party checkout proxies. This local helper lets your Windows PC open the browser directly and apply the checkout proxy.


## Existing Chrome capture method

This method uses your normal Chrome instead of Playwright launching a new browser.

1. Start the local tool:

```bash
cd C:\Users\Ricky Hill\Downloads\profile-platform-main\target-login-local-tool
npm install
npm start
```

2. Run `start-existing-chrome-debug.bat`, or run this in Command Prompt:

```bat
taskkill /F /IM chrome.exe
start chrome.exe --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\target-login-profile"
```

3. In that Chrome window, go to Target and login manually.
4. Open `http://localhost:7777`.
5. Enter the Target account email.
6. Click **Capture From Existing Chrome**.
7. Click **Save Session After Login**.

This saves the logged-in Target storage state under `target-login-local-tool/sessions/`.
