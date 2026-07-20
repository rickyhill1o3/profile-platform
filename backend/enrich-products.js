
function parseMultiSkuValue(rawValue) {
    if (!rawValue) return [];

    return rawValue
        .split(/[\n,]+/)
        .map(v => v.trim())
        .filter(Boolean);
}

function countEffectiveSkus(product) {
    if (!product) return 0;

    if (Array.isArray(product.multiSkus) && product.multiSkus.length) {
        return product.multiSkus.length;
    }

    if (typeof product.sku === 'string') {
        return parseMultiSkuValue(product.sku).length || 1;
    }

    return 1;
}

require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const cheerio = require("cheerio");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function getArg(name, fallback = "") {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.split("=").slice(1).join("=") : fallback;
}

function normalizeSite(value) {
  const site = String(value || "").trim().toLowerCase();
  if (site !== "amazon" && site !== "target") {
    throw new Error("Pass --site=amazon or --site=target");
  }
  return site;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function loadPendingProducts(site) {
  const { data: activeCatalog, error: activeCatalogError } = await supabase
    .from("product_catalogs")
    .select("id")
    .eq("site", site)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeCatalogError) {
    throw new Error(activeCatalogError.message);
  }

  if (!activeCatalog?.id) {
    throw new Error(`No active catalog found for ${site}`);
  }

  const { data, error } = await supabase
    .from("catalog_products")
    .select("id, site, sku, product_name, image_url")
    .eq("catalog_id", activeCatalog.id)
    .eq("is_enabled", true)
    .order("sku", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}

async function fetchTargetProduct(page, sku) {
  const url = `https://www.target.com/p/-/A-${sku}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1200);
  const html = await page.content();
  const $ = cheerio.load(html);

  let productName = cleanText($('meta[property="og:title"]').attr("content"));
  let imageUrl = $('meta[property="og:image"]').attr("content") || "";
  let productUrl = $('meta[property="og:url"]').attr("content") || url;
  let brand = "";

  if (!productName) {
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const value = JSON.parse($(el).contents().text());
        const candidates = Array.isArray(value) ? value : [value];
        for (const item of candidates) {
          if (item && item["@type"] === "Product") {
            productName = productName || cleanText(item.name);
            brand = brand || cleanText(item?.brand?.name || item?.brand || "");
            if (!imageUrl) {
              if (Array.isArray(item.image)) {
                imageUrl = item.image[0] || "";
              } else {
                imageUrl = item.image || "";
              }
            }
          }
        }
      } catch (_) {}
    });
  }

  return {
    product_name: productName || sku,
    image_url: imageUrl,
    product_url: productUrl,
    brand
  };
}

async function fetchAmazonProduct(page, sku) {
  const url = `https://www.amazon.com/dp/${sku}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1800);

  try {
    const continueButton = page.getByText(/continue shopping/i);
    if (await continueButton.count()) {
      await continueButton.first().click({ timeout: 2000 });
      await page.waitForTimeout(1200);
    }
  } catch (_) {}

  const html = await page.content();
  const $ = cheerio.load(html);

  let productName =
    cleanText($("#productTitle").text()) ||
    cleanText($('meta[property="og:title"]').attr("content")) ||
    cleanText($("title").text());

  let imageUrl =
    $("#landingImage").attr("src") ||
    $('meta[property="og:image"]').attr("content") ||
    "";

  let brand = cleanText($("#bylineInfo").text());
  const productUrl = url;

  return {
    product_name: productName || sku,
    image_url: imageUrl,
    product_url: productUrl,
    brand
  };
}

async function updateProduct(productId, payload) {
  const { error } = await supabase
    .from("catalog_products")
    .update({
      ...payload,
      last_enriched_at: new Date().toISOString()
    })
    .eq("id", productId);

  if (error) {
    throw new Error(error.message);
  }
}

async function main() {
  const site = normalizeSite(getArg("site"));
  const headless = getArg("headless", "true") !== "false";
  const limit = Number(getArg("limit", "0")) || 0;

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    throw new Error("This optional catalog enrichment utility requires Playwright. It is not used by the deployed website. Install it locally with: npm install --no-save playwright");
  }

  const browser = await chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US"
  });

  const page = await context.newPage();
  const products = await loadPendingProducts(site);
  const items = limit > 0 ? products.slice(0, limit) : products;

  console.log(`Enriching ${items.length} ${site} products`);

  for (const row of items) {
    try {
      const data =
        site === "target"
          ? await fetchTargetProduct(page, row.sku)
          : await fetchAmazonProduct(page, row.sku);

      await updateProduct(row.id, data);
      console.log(`✔ ${row.sku} -> ${data.product_name}`);
    } catch (err) {
      console.error(`✖ ${row.sku}: ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
