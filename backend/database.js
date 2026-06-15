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

const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");

require("dotenv").config();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
    {
        realtime: {
            transport: WebSocket
        }
    }
);

module.exports = supabase;
