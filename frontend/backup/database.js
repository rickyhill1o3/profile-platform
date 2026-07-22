
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
let WebSocketTransport = null;
try {
    WebSocketTransport = require("ws");
    if (!global.WebSocket) global.WebSocket = WebSocketTransport;
} catch (_) {}

require("dotenv").config();

const supabaseOptions = WebSocketTransport ? { realtime: { transport: WebSocketTransport } } : undefined;
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
    supabaseOptions
);

module.exports = supabase;
