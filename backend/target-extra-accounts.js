'use strict';

const MAX_EXTRA_TARGET_ACCOUNTS = 10;

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function parseExtraTargetAccountLines(raw = '') {
  const valid = [];
  const invalid = [];
  const duplicateInput = [];
  const seen = new Set();

  String(raw || '').split(/\r?\n/).forEach((sourceLine, index) => {
    const line = String(sourceLine || '').trim();
    if (!line) return;

    const separator = line.indexOf(':');
    const email = normalizeEmail(separator >= 0 ? line.slice(0, separator) : line);
    const password = separator >= 0 ? line.slice(separator + 1) : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) {
      invalid.push({ line: index + 1, email: email || null, reason: 'Expected email:password' });
      return;
    }
    if (seen.has(email)) {
      duplicateInput.push({ line: index + 1, email });
      return;
    }
    seen.add(email);
    valid.push({ email, password });
  });

  return { valid, invalid, duplicateInput };
}

function clampDesiredCount(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count)) return MAX_EXTRA_TARGET_ACCOUNTS;
  return Math.max(1, Math.min(MAX_EXTRA_TARGET_ACCOUNTS, count));
}

function stableRotation(value, length) {
  if (!length) return 0;
  const text = String(value || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % length;
}

function planEvenAssignments({ users = [], accounts = [], currentAssignments = [], cycleId = '', mode = 'fill' } = {}) {
  const eligibleUsers = (Array.isArray(users) ? users : [])
    .filter((user) => user && user.id && user.template_profile_id)
    .map((user) => ({ ...user, desired_count: clampDesiredCount(user.desired_count) }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const enabledAccounts = (Array.isArray(accounts) ? accounts : [])
    .filter((account) => account && account.id && String(account.status || 'available') === 'available')
    .sort((left, right) => normalizeEmail(left.login_email).localeCompare(normalizeEmail(right.login_email)));
  const eligibleIds = new Set(eligibleUsers.map((user) => String(user.id)));
  const accountIds = new Set(enabledAccounts.map((account) => String(account.id)));
  const userById = new Map(eligibleUsers.map((user) => [String(user.id), user]));

  const preserved = mode === 'new_cycle' ? [] : (Array.isArray(currentAssignments) ? currentAssignments : [])
    .filter((assignment) => assignment && !assignment.released_at)
    .filter((assignment) => eligibleIds.has(String(assignment.user_id)) && accountIds.has(String(assignment.account_id)));

  const counts = new Map(eligibleUsers.map((user) => [String(user.id), 0]));
  const kept = [];
  const release = [];
  const preservedAccountIds = new Set();
  const sortedPreserved = [...preserved].sort((left, right) => String(left.assigned_at || '').localeCompare(String(right.assigned_at || '')));
  sortedPreserved.forEach((assignment) => {
    const userId = String(assignment.user_id);
    const user = userById.get(userId);
    const currentCount = counts.get(userId) || 0;
    if (!user || currentCount >= user.desired_count || preservedAccountIds.has(String(assignment.account_id))) {
      release.push(assignment);
      return;
    }
    kept.push(assignment);
    counts.set(userId, currentCount + 1);
    preservedAccountIds.add(String(assignment.account_id));
  });

  const available = enabledAccounts.filter((account) => !preservedAccountIds.has(String(account.id)));
  const rotation = stableRotation(cycleId, eligibleUsers.length);
  const rotatedUsers = eligibleUsers.length
    ? eligibleUsers.slice(rotation).concat(eligibleUsers.slice(0, rotation))
    : [];
  const userRank = new Map(rotatedUsers.map((user, index) => [String(user.id), index]));
  const create = [];

  available.forEach((account) => {
    const candidates = eligibleUsers.filter((user) => (counts.get(String(user.id)) || 0) < user.desired_count);
    if (!candidates.length) return;
    candidates.sort((left, right) => {
      const countDifference = (counts.get(String(left.id)) || 0) - (counts.get(String(right.id)) || 0);
      if (countDifference) return countDifference;
      return (userRank.get(String(left.id)) || 0) - (userRank.get(String(right.id)) || 0);
    });
    const user = candidates[0];
    const userId = String(user.id);
    create.push({
      account_id: account.id,
      user_id: user.id,
      template_profile_id: user.template_profile_id,
      cycle_id: cycleId
    });
    counts.set(userId, (counts.get(userId) || 0) + 1);
  });

  return {
    keep: kept,
    release,
    create,
    unassignedAccountIds: available
      .filter((account) => !create.some((assignment) => String(assignment.account_id) === String(account.id)))
      .map((account) => account.id),
    counts: Object.fromEntries([...counts.entries()])
  };
}

function resolveAssignmentAtTime(assignments = [], eventAt = new Date()) {
  const eventTime = new Date(eventAt).getTime();
  if (!Number.isFinite(eventTime)) return null;
  return (Array.isArray(assignments) ? assignments : [])
    .filter((assignment) => {
      const assignedAt = new Date(assignment.assigned_at).getTime();
      const releasedAt = assignment.released_at ? new Date(assignment.released_at).getTime() : Number.POSITIVE_INFINITY;
      return Number.isFinite(assignedAt) && assignedAt <= eventTime && eventTime < releasedAt;
    })
    .sort((left, right) => new Date(right.assigned_at).getTime() - new Date(left.assigned_at).getTime())[0] || null;
}

function buildSyntheticTargetProfile(template = {}, account = {}, assignment = {}, index = 0) {
  const loginEmail = normalizeEmail(account.login_email);
  const syntheticId = `target-extra:${assignment.id || account.id || index}`;
  const address = { ...(template.addresses?.[0] || {}), profile_id: syntheticId, email: loginEmail };
  const baseCredentials = { ...(template.store_credentials || {}) };
  const targetCredential = {
    ...(baseCredentials.target || {}),
    profile_id: syntheticId,
    store: 'target',
    login_email: loginEmail,
    login_password: account.login_password || '',
    gmail_app_password: null,
    amazon_2fa_secret: null,
    use_aycd_inbox: false
  };
  return {
    ...template,
    id: syntheticId,
    profile_name: `${template.profile_name || 'Target'} - Extra Target ${index + 1}`,
    account_type: 'target',
    addresses: [address],
    payments: (template.payments || []).map((payment) => ({ ...payment, profile_id: syntheticId })),
    accounts: [{
      profile_id: syntheticId,
      provider: 'target',
      login_email: loginEmail,
      login_password: account.login_password || '',
      gmail_app_password: null,
      amazon_2fa_secret: null
    }],
    store_assignments: ['target'],
    store_credentials: { ...baseCredentials, target: targetCredential },
    is_target_extra_account: true,
    target_extra_assignment_id: assignment.id || null
  };
}

module.exports = {
  MAX_EXTRA_TARGET_ACCOUNTS,
  normalizeEmail,
  parseExtraTargetAccountLines,
  clampDesiredCount,
  planEvenAssignments,
  resolveAssignmentAtTime,
  buildSyntheticTargetProfile
};
