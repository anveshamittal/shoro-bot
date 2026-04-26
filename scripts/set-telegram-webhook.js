"use strict";

const axios = require("axios");
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const token = process.env.TELEGRAM_TOKEN;
const raw = process.argv[2];

if (!token) {
  console.error("Missing TELEGRAM_TOKEN in .env");
  process.exit(1);
}
if (!raw) {
  console.error("Usage: npm run set-webhook -- https://<your-ngrok-host>");
  console.error("Example: npm run set-webhook -- https://abcd-12-34-56-78.ngrok-free.app");
  process.exit(1);
}

let base = raw.trim().replace(/\/$/, "");
if (!/^https:\/\//i.test(base)) {
  console.error("Webhook base must be an https:// URL (ngrok gives you https).");
  process.exit(1);
}

const webhookUrl = `${base}/webhook`;

async function main() {
  const { data } = await axios.get(`https://api.telegram.org/bot${token}/setWebhook`, {
    params: { url: webhookUrl },
    timeout: 20000,
  });

  if (!data?.ok) {
    console.error("setWebhook failed:", data);
    process.exit(1);
  }

  console.log("Webhook set to:", webhookUrl);

  const info = await axios.get(`https://api.telegram.org/bot${token}/getWebhookInfo`, { timeout: 20000 });
  console.log("getWebhookInfo:", JSON.stringify(info.data, null, 2));
}

main().catch((err) => {
  console.error(err?.response?.data || err.message || err);
  process.exit(1);
});
