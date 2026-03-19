const { createClient } = require("@supabase/supabase-js");

require("dotenv").config();

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!process.env.SUPABASE_URL || !supabaseKey) {
    throw new Error("Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)");
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    supabaseKey
);

module.exports = supabase;
