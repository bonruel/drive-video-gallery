// Tracks which folders have been marked "posted" and "optimized", shared
// across every visitor/device. Backed by the Redis database connected in the
// Vercel dashboard (Storage tab), which injects POSTED_REDIS_URL.
//
// When a folder is newly marked posted, an SMS goes to NOTIFY_PHONE via
// Semaphore (SEMAPHORE_API_KEY). Both are Vercel environment variables, so the
// phone number and key never appear in this public repo. With either missing,
// the SMS step is skipped and everything else works as normal.
const { createClient } = require("redis");

const KEYS = { posted: "dvg_posted", optimized: "dvg_optimized" };
const ID_RE = /^[A-Za-z0-9_-]{10,80}$/;
const MAX_SMS_PER_HOUR = 20;

async function withClient(fn) {
  const client = createClient({ url: process.env.POSTED_REDIS_URL });
  client.on("error", function () {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.quit();
  }
}

function cleanName(name) {
  return String(name || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
}

// The endpoint is public, so cap how often a text can fire: once per folder
// per 10 minutes, and 20 per hour overall.
async function claimSmsSlot(client, id) {
  const fresh = await client.set("dvg_sms_recent:" + id, "1", { NX: true, EX: 600 });
  if (!fresh) return false;
  const count = await client.incr("dvg_sms_hourly");
  if (count === 1) await client.expire("dvg_sms_hourly", 3600);
  return count <= MAX_SMS_PER_HOUR;
}

async function sendSms(folderName) {
  const apiKey = process.env.SEMAPHORE_API_KEY;
  const number = process.env.NOTIFY_PHONE;
  if (!apiKey || !number || !folderName) return;
  const params = new URLSearchParams({
    apikey: apiKey,
    number: number,
    message: "Hi Bon! " + folderName + " is posted please optimize!"
  });
  if (process.env.SEMAPHORE_SENDER) params.set("sendername", process.env.SEMAPHORE_SENDER);
  try {
    await fetch("https://api.semaphore.co/api/v4/messages", {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    // A failed text must never break the checkbox.
  }
}

module.exports = async (req, res) => {
  if (!process.env.POSTED_REDIS_URL) {
    res.status(500).json({ error: "Storage is not configured yet." });
    return;
  }

  if (req.method === "GET") {
    try {
      var getKind = req.query && req.query.kind === "optimized" ? "optimized" : "posted";
      var stored = await withClient(function (client) { return client.hGetAll(KEYS[getKind]); });
      var map = {};
      for (var key in stored) map[key] = stored[key] === "1";
      res.status(200).json(map);
    } catch (err) {
      res.status(502).json({ error: "Could not reach storage." });
    }
    return;
  }

  if (req.method === "POST") {
    try {
      var body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      var id = body && body.id;
      var value = !!(body && body.value);
      var kind = body && body.kind === "optimized" ? "optimized" : "posted";
      if (!id || !ID_RE.test(String(id))) {
        res.status(400).json({ error: "Missing or invalid id" });
        return;
      }
      var notifyName = "";
      await withClient(async function (client) {
        await client.hSet(KEYS[kind], id, value ? "1" : "0");
        if (kind === "posted" && value) {
          var name = cleanName(body.name);
          if (name && (await claimSmsSlot(client, id))) notifyName = name;
        }
      });
      if (notifyName) await sendSms(notifyName);
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: "Could not reach storage." });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
