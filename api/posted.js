// Stores which folders/files have been marked "Posted", shared across every
// visitor/device. Backed by the Redis database connected in the Vercel
// dashboard (Storage tab), which injects POSTED_REDIS_URL automatically.
const { createClient } = require("redis");

const REDIS_KEY = "dvg_posted";

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

module.exports = async (req, res) => {
if (!process.env.POSTED_REDIS_URL) {
res.status(500).json({ error: "Storage is not configured yet." });
return;
}

if (req.method === "GET") {
try {
var stored = await withClient(function (client) { return client.hGetAll(REDIS_KEY); });
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
if (!id) {
res.status(400).json({ error: "Missing id" });
return;
}
await withClient(function (client) { return client.hSet(REDIS_KEY, id, value ? "1" : "0"); });
res.status(200).json({ ok: true });
} catch (err) {
res.status(502).json({ error: "Could not reach storage." });
}
return;
}

res.status(405).json({ error: "Method not allowed" });
};
