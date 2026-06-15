
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

const crypto = require("crypto")

const algorithm = "aes-256-cbc"

const key = crypto
    .createHash("sha256")
    .update(process.env.ENCRYPTION_KEY)
    .digest()

function encrypt(text) {

    if (!text) return ""

    const iv = crypto.randomBytes(16)

    const cipher = crypto.createCipheriv(algorithm, key, iv)

    let encrypted = cipher.update(text, "utf8", "hex")
    encrypted += cipher.final("hex")

    return iv.toString("hex") + ":" + encrypted
}

function decrypt(text) {

    if (!text) return ""

    const parts = text.split(":")

    const iv = Buffer.from(parts.shift(), "hex")

    const encryptedText = parts.join(":")

    const decipher = crypto.createDecipheriv(algorithm, key, iv)

    let decrypted = decipher.update(encryptedText, "hex", "utf8")
    decrypted += decipher.final("utf8")

    return decrypted
}

module.exports = { encrypt, decrypt }