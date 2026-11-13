'use strict';

// Target's rendered catalog scan launches Chromium, while order reconciliation parses large
// MIME messages. A 256 MB Render service cannot safely run both workloads at once. These small
// process-local guards make scheduled mail scans defer while a Target batch is active, and let
// the Target endpoint tell the browser to retry if an email scan was already in progress.
let targetCatalogWorkers = 0;
let emailWorkers = 0;
let targetCatalogCooldownUntil = 0;

function isTargetCatalogWorkActive() {
  return targetCatalogWorkers > 0 || Date.now() < targetCatalogCooldownUntil;
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

module.exports = {
  beginEmailHeavyWork,
  beginTargetCatalogWork,
  isEmailHeavyWorkActive,
  isTargetCatalogWorkActive
};
