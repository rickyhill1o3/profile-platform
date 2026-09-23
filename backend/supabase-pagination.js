'use strict';

async function fetchAllSupabaseRows(queryFactory, pageSize = 1000) {
  const rows = [];
  const size = Math.max(1, Number(pageSize) || 1000);

  for (let from = 0; ; from += size) {
    const result = await queryFactory().range(from, from + size - 1);
    if (result.error) return { data: null, error: result.error };
    const page = Array.isArray(result.data) ? result.data : [];
    rows.push(...page);
    if (page.length < size) break;
  }

  return { data: rows, error: null };
}

async function fetchAllSupabaseRowsInBatches(values = [], queryFactory, options = {}) {
  const uniqueValues = [...new Set((values || []).filter(Boolean).map(String))];
  const batchSize = Math.max(1, Number(options.batchSize) || 200);
  const pageSize = Math.max(1, Number(options.pageSize) || 1000);
  const rows = [];

  for (let index = 0; index < uniqueValues.length; index += batchSize) {
    const batch = uniqueValues.slice(index, index + batchSize);
    const result = await fetchAllSupabaseRows(() => queryFactory(batch), pageSize);
    if (result.error) return result;
    rows.push(...(result.data || []));
  }

  return { data: rows, error: null };
}

module.exports = { fetchAllSupabaseRows, fetchAllSupabaseRowsInBatches };
