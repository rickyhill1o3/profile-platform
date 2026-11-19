const TARGET_RAFFLE_CHECKOUT_LINK_PREFIX = 'target_raffle_checkout:';

function normalizeTargetRaffleEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function targetRaffleCheckoutLinkKey(email = '') {
  const normalized = normalizeTargetRaffleEmail(email);
  return normalized ? `${TARGET_RAFFLE_CHECKOUT_LINK_PREFIX}${normalized}` : '';
}

function buildTargetRaffleCheckoutLink({ accountEmail, userId, linkedBy, linkedAt = new Date().toISOString() } = {}) {
  const email = normalizeTargetRaffleEmail(accountEmail);
  if (!email || !userId) throw new Error('A Target account email and website user are required.');
  return {
    version: 1,
    status: 'active',
    target_login_email: email,
    user_id: String(userId),
    linked_by: linkedBy ? String(linkedBy) : null,
    linked_at: linkedAt,
    consumed_at: null,
    consumed_order_id: null,
    consumed_external_order_id: null,
    released_at: null,
    released_by: null
  };
}

function targetRaffleCheckoutLinkIsActiveAt(link = {}, eventAt = null) {
  if (!link || link.status !== 'active' || link.consumed_at || link.released_at) return false;
  if (!normalizeTargetRaffleEmail(link.target_login_email) || !link.user_id || !link.linked_at) return false;
  const linkedTime = new Date(link.linked_at).getTime();
  const eventTime = eventAt ? new Date(eventAt).getTime() : Date.now();
  if (!Number.isFinite(linkedTime) || !Number.isFinite(eventTime)) return false;
  return linkedTime <= eventTime;
}

function consumeTargetRaffleCheckoutLink(link = {}, {
  userId,
  orderId = null,
  externalOrderId = null,
  consumedAt = new Date().toISOString()
} = {}) {
  if (!targetRaffleCheckoutLinkIsActiveAt(link, consumedAt)) return null;
  if (String(link.user_id || '') !== String(userId || '')) return null;
  return {
    ...link,
    status: 'consumed',
    consumed_at: consumedAt,
    consumed_order_id: orderId || null,
    consumed_external_order_id: externalOrderId || null
  };
}

function releaseTargetRaffleCheckoutLink(link = {}, {
  releasedBy = null,
  releasedAt = new Date().toISOString()
} = {}) {
  if (!link || link.status !== 'active' || link.consumed_at || link.released_at) return null;
  return {
    ...link,
    status: 'released',
    released_at: releasedAt,
    released_by: releasedBy ? String(releasedBy) : null
  };
}

module.exports = {
  TARGET_RAFFLE_CHECKOUT_LINK_PREFIX,
  normalizeTargetRaffleEmail,
  targetRaffleCheckoutLinkKey,
  buildTargetRaffleCheckoutLink,
  targetRaffleCheckoutLinkIsActiveAt,
  consumeTargetRaffleCheckoutLink,
  releaseTargetRaffleCheckoutLink
};
