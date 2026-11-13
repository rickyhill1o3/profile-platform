'use strict';

// Target's rendered catalog scan launches Chromium, while order reconciliation parses large
// MIME messages. A 256 MB Render service cannot safely run both workloads at once. These small
// process-local guards make scheduled mail scans defer while a Target batch is active, and let
// the Target endpoint tell the browser to retry if an email scan was already in progress.
let targetCatalogWorkers = 0;
let emailWorkers = 0;
let targetCatalogCooldownUntil = 0;
let targetCatalogPriorityUntil = 0;
let emailResumeHandler = null;
let emailResumeTimer = null;

function requestTargetCatalogPriority(ttlMs = 2 * 60 * 1000) {
  const boundedTtl = Math.max(30000, Math.min(10 * 60 * 1000, Number(ttlMs || 0)));
  targetCatalogPriorityUntil = Math.max(targetCatalogPriorityUntil, Date.now() + boundedTtl);
}

function shouldYieldEmailWorkToTargetCatalog() {
  return targetCatalogWorkers > 0 || Date.now() < targetCatalogPriorityUntil;
}

function isTargetCatalogWorkActive() {
  return shouldYieldEmailWorkToTargetCatalog() || Date.now() < targetCatalogCooldownUntil;
}

function isEmailHeavyWorkActive() {
  return emailWorkers > 0;
}

function beginTargetCatalogWork() {
  targetCatalogWorkers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    targetCatalogWorkers = Math.max(0, targetCatalogWorkers - 1);
    targetCatalogCooldownUntil = Math.max(targetCatalogCooldownUntil, Date.now() + 15000);
  };
}

function beginEmailHeavyWork() {
  emailWorkers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    emailWorkers = Math.max(0, emailWorkers - 1);
  };
}

function setEmailResumeHandler(handler) {
  emailResumeHandler = typeof handler === 'function' ? handler : null;
}

function targetEmailResumeDelayMs() {
  return Math.max(15000, Number(process.env.TARGET_EMAIL_RESUME_DELAY_MS || 35000));
}

function scheduleEmailResumeAfterTarget(delayMs = targetEmailResumeDelayMs() + 1000) {
  if (!emailResumeHandler || emailResumeTimer) return;
  // Chromium closes itself after its idle window. Give it time to exit before large MIME parsing
  // resumes so both workloads never share the 256 MB Render instance.
  emailResumeTimer = setTimeout(async () => {
    emailResumeTimer = null;
    if (isTargetCatalogWorkActive() || isEmailHeavyWorkActive()) {
      scheduleEmailResumeAfterTarget();
      return;
    }
    try {
      await emailResumeHandler();
    } catch (error) {
      console.error('[ORDER TRACKER] Post-Target email resume failed:', error?.message || error);
    }
  }, delayMs);
  if (typeof emailResumeTimer.unref === 'function') emailResumeTimer.unref();
}

function clearTargetCatalogPriority({ resumeEmail = true } = {}) {
  targetCatalogPriorityUntil = 0;
  const resumeDelayMs = targetEmailResumeDelayMs();
  // Continue blocking scheduled IMAP until Chromium's idle-close timer has fired.
  targetCatalogCooldownUntil = resumeEmail ? Date.now() + resumeDelayMs : 0;
  if (resumeEmail) scheduleEmailResumeAfterTarget(resumeDelayMs + 1000);
}

module.exports = {
  beginEmailHeavyWork,
  beginTargetCatalogWork,
  clearTargetCatalogPriority,
  isEmailHeavyWorkActive,
  isTargetCatalogWorkActive,
  requestTargetCatalogPriority,
  setEmailResumeHandler,
  shouldYieldEmailWorkToTargetCatalog
};
