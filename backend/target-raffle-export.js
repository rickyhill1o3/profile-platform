const {
  normalizeEmail,
  buildSyntheticTargetProfile
} = require('./target-extra-accounts');

function validateTargetRaffleExport({
  requested = false,
  currentUserRole = '',
  group = '',
  userId = '',
  excludeCurrentUser = false,
  splitBot = ''
} = {}) {
  if (!requested) return { requested: false, ok: true };
  if (currentUserRole !== 'super_admin') {
    return { requested: true, ok: false, status: 403, error: 'Raffle Export is available only to the super admin.' };
  }
  if (String(group || '').trim().toLowerCase() !== 'target') {
    return { requested: true, ok: false, status: 400, error: 'Raffle Export is Target-only.' };
  }
  if (userId || excludeCurrentUser) {
    return { requested: true, ok: false, status: 400, error: 'Raffle Export already includes the complete active Target audience.' };
  }
  if (splitBot) {
    return { requested: true, ok: false, status: 400, error: 'Raffle Export cannot be combined with a weekly bot split.' };
  }
  return { requested: true, ok: true };
}

function targetLoginEmailForProfile(profile = {}) {
  const credential = profile.store_credentials?.target || {};
  if (credential.login_email) return normalizeEmail(credential.login_email);

  const targetAccount = (Array.isArray(profile.accounts) ? profile.accounts : []).find((account) => {
    const provider = String(account?.provider || account?.account_type || '').trim().toLowerCase();
    return provider === 'target';
  });
  if (targetAccount?.login_email) return normalizeEmail(targetAccount.login_email);
  return normalizeEmail(profile.addresses?.[0]?.email || '');
}

function buildTargetRaffleProfiles({ profiles = [], openAccounts = [], templates = [] } = {}) {
  const result = Array.isArray(profiles) ? [...profiles] : [];
  const availableTemplates = (Array.isArray(templates) ? templates : []).filter(Boolean);
  const accounts = (Array.isArray(openAccounts) ? openAccounts : [])
    .filter((account) => account && account.status !== 'disabled' && normalizeEmail(account.login_email))
    .sort((left, right) => normalizeEmail(left.login_email).localeCompare(normalizeEmail(right.login_email)));

  if (accounts.length && !availableTemplates.length) {
    throw new Error('Raffle Export needs at least one enabled Target profile on the super-admin account to supply the profile, address, and payment information for open extra accounts.');
  }

  const seenEmails = new Set(result.map(targetLoginEmailForProfile).filter(Boolean));
  let added = 0;

  accounts.forEach((account) => {
    const loginEmail = normalizeEmail(account.login_email);
    if (!loginEmail || seenEmails.has(loginEmail)) return;

    const template = availableTemplates[added % availableTemplates.length];
    const synthetic = buildSyntheticTargetProfile(template, {
      ...account,
      login_email: loginEmail
    }, {
      id: `raffle:${account.id || added + 1}`
    }, added);

    synthetic.profile_name = `${template.profile_name || 'Target'} - Raffle ${added + 1}`;
    synthetic.is_target_raffle_account = true;
    synthetic.target_extra_account_id = account.id || null;
    result.push(synthetic);
    seenEmails.add(loginEmail);
    added += 1;
  });

  return result;
}

module.exports = {
  validateTargetRaffleExport,
  targetLoginEmailForProfile,
  buildTargetRaffleProfiles
};
