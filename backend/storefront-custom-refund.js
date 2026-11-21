'use strict';

function parseCustomRefundAmountCents(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = String(value).trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return Number.NaN;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : Number.NaN;
}

function allocateCustomRefundCents(sales = [], amountCents = 0) {
  let remaining = Math.max(0, Number(amountCents || 0));
  const allocations = [];

  for (const sale of sales || []) {
    if (remaining <= 0) break;
    const alreadyRefunded = Math.max(0, Number(sale?.metadata?.refunded_amount_cents || 0));
    const rowRemaining = Math.max(0, Number(sale?.total_cents || 0) - alreadyRefunded);
    const amount = Math.min(remaining, rowRemaining);
    if (amount > 0) {
      allocations.push({ sale, amount });
      remaining -= amount;
    }
  }

  // Stripe is authoritative. If legacy local row totals do not fully represent the
  // payment, retain the remaining adjustment on the first row as order-level money.
  if (remaining > 0 && sales?.[0]) {
    const first = allocations.find((row) => row.sale === sales[0]);
    if (first) first.amount += remaining;
    else allocations.unshift({ sale: sales[0], amount: remaining });
    remaining = 0;
  }

  return allocations;
}

module.exports = {
  allocateCustomRefundCents,
  parseCustomRefundAmountCents
};
