require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function normalizeSite(siteArg, fileSite) {
  const value = String(siteArg || fileSite || "").trim().toLowerCase();
  if (value === "amazon") return "amazon";
  if (value === "target") return "target";
  throw new Error(`Unsupported site: ${value}`);
}

function shouldSkipSku(rawSku) {
  const sku = String(rawSku || "").trim();
  if (!sku) return true;
  return sku.includes("PLACEHOLDER");
}

function normalizeProductRow(site, row) {
  const sku = String(row?.sku || "").trim();
  const defaultMax = Number(row?.userSetMaxPrice ?? row?.default_max_price ?? 0);

  return {
    site,
    sku,
    default_max_price: Number.isFinite(defaultMax) ? Number(defaultMax.toFixed(2)) : null,
    release_mode_default: "current",
    is_enabled: true,
    metadata: {}
  };
}

async function main() {
  const filePath = process.argv[2];
  const siteArg = process.argv[3];

  if (!filePath) {
    throw new Error("Usage: node import-products.js <path-to-json> <amazon|target>");
  }

  const fullPath = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(fullPath, "utf8");
  const parsed = JSON.parse(raw);
  const site = normalizeSite(siteArg, parsed.site);
  const catalogName = String(parsed.name || `${site} catalog`).trim();
  const exportDate = parsed.exportDate || null;
  const products = Array.isArray(parsed.products) ? parsed.products : [];

  const cleanProducts = products
    .filter((row) => !shouldSkipSku(row?.sku))
    .map((row) => normalizeProductRow(site, row));

  console.log(`Importing ${cleanProducts.length} ${site} products into catalog "${catalogName}"`);

  const { data: existingActiveCatalogs, error: findCatalogError } = await supabase
    .from("product_catalogs")
    .select("id")
    .eq("site", site)
    .eq("is_active", true);

  if (findCatalogError) {
    throw new Error(findCatalogError.message);
  }

  if (existingActiveCatalogs?.length) {
    const activeIds = existingActiveCatalogs.map((row) => row.id);
    const { error: deactivateError } = await supabase
      .from("product_catalogs")
      .update({ is_active: false })
      .in("id", activeIds);

    if (deactivateError) {
      throw new Error(deactivateError.message);
    }
  }

  const { data: catalog, error: catalogError } = await supabase
    .from("product_catalogs")
    .insert({
      site,
      name: catalogName,
      export_date: exportDate,
      is_active: true
    })
    .select("id, site, name")
    .single();

  if (catalogError) {
    throw new Error(catalogError.message);
  }

  const batchSize = 250;
  for (let i = 0; i < cleanProducts.length; i += batchSize) {
    const chunk = cleanProducts.slice(i, i + batchSize).map((row) => ({
      ...row,
      catalog_id: catalog.id
    }));

    const { error } = await supabase
      .from("catalog_products")
      .insert(chunk);

    if (error) {
      throw new Error(error.message);
    }
  }

  console.log(`Done. Created catalog ${catalog.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
