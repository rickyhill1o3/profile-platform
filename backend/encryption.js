const crypto = require("crypto");

const algorithm = "aes-256-cbc";

if (!process.env.ENCRYPTION_KEY) {
    throw new Error("Missing ENCRYPTION_KEY");
}

const key = crypto
    .createHash("sha256")
    .update(process.env.ENCRYPTION_KEY)
    .digest();

function encrypt(text) {
    if (!text) return "";

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);

    let encrypted = cipher.update(String(text), "utf8", "hex");
    encrypted += cipher.final("hex");

    return iv.toString("hex") + ":" + encrypted;
}

function decrypt(text) {
    if (!text) return "";

    const parts = String(text).split(":");
    if (parts.length < 2) return "";

    const ivHex = parts.shift();
    const encryptedText = parts.join(":");

    if (!ivHex || !encryptedText) return "";

    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(algorithm, key, iv);

    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
}

module.exports = { encrypt, decrypt };
