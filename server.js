import "dotenv/config";
import express from "express";
import { GoogleGenAI } from "@google/genai";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const JWT_SECRET = process.env.JWT_SECRET;
app.use(express.json({ limit: "30kb" }));
app.use(express.static(path.join(__dirname, "public")));

async function readUsers() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { return JSON.parse(await fs.readFile(USERS_FILE, "utf8")); }
  catch { return []; }
}
async function writeUsers(users) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}
function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !JWT_SECRET) return res.status(401).json({ error: "कृपया पहले लॉगिन करें।" });
  try { req.auth = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "सेशन समाप्त हो गया। फिर लॉगिन करें।" }); }
}
function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, premium: Boolean(user.premium) };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, aiConfigured: Boolean(process.env.GEMINI_API_KEY), authConfigured: Boolean(JWT_SECRET) });
});

app.post("/api/register", async (req, res) => {
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: "सर्वर सेटअप अधूरा है: JWT_SECRET सेट करें।" });
    const name = String(req.body?.name || "").trim().slice(0, 60);
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (name.length < 2) return res.status(400).json({ error: "नाम कम से कम 2 अक्षरों का होना चाहिए।" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "सही ईमेल लिखें।" });
    if (password.length < 8) return res.status(400).json({ error: "पासवर्ड कम से कम 8 अक्षरों का रखें।" });
    const users = await readUsers();
    if (users.some(u => u.email === email)) return res.status(409).json({ error: "इस ईमेल से अकाउंट पहले से है। लॉगिन करें।" });
    const user = {
      id: crypto.randomUUID(), name, email,
      passwordHash: await bcrypt.hash(password, 12),
      premium: false, createdAt: new Date().toISOString()
    };
    users.push(user);
    await writeUsers(users);
    res.status(201).json({ token: createToken(user), user: publicUser(user) });
  } catch (e) {
    console.error("Register error:", e?.message || e);
    res.status(500).json({ error: "रजिस्ट्रेशन पूरा नहीं हो पाया।" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    if (!JWT_SECRET) return res.status(503).json({ error: "सर्वर सेटअप अधूरा है: JWT_SECRET सेट करें।" });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const users = await readUsers();
    const user = users.find(u => u.email === email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "ईमेल या पासवर्ड सही नहीं है।" });
    }
    res.json({ token: createToken(user), user: publicUser(user) });
  } catch (e) {
    console.error("Login error:", e?.message || e);
    res.status(500).json({ error: "लॉगिन नहीं हो पाया।" });
  }
});

app.get("/api/me", auth, async (req, res) => {
  const users = await readUsers();
  const user = users.find(u => u.id === req.auth.id);
  if (!user) return res.status(404).json({ error: "अकाउंट नहीं मिला।" });
  res.json({ user: publicUser(user) });
});

app.post("/api/chat", auth, async (req, res) => {
  try {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
    if (!message) return res.status(400).json({ error: "अपना सवाल लिखें।" });
    if (message.length > 4000) return res.status(400).json({ error: "सवाल 4000 अक्षरों से छोटा रखें।" });
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "Gemini API key सर्वर पर सेट नहीं है।" });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const safeHistory = history
      .filter(x => x && ["user", "model"].includes(x.role) && typeof x.text === "string")
      .map(x => ({ role: x.role, parts: [{ text: x.text.slice(0, 4000) }] }));
    const chat = ai.chats.create({
      model: "gemini-2.5-flash",
      history: safeHistory,
      config: {
        systemInstruction: `You are Philosophy AI, a careful, thoughtful philosophy guide. Answer in the user's language. Explain concepts clearly and fairly; distinguish established facts, interpretations, and opinions. When discussing philosophers, represent their views accurately and avoid inventing quotes or sources. If uncertain, say so and suggest what should be verified. Compare perspectives when useful (e.g. Indian, Greek, Buddhist, existentialist, Stoic and modern philosophy). Ask a clarifying question if the prompt is ambiguous. Do not claim to be a human or guarantee absolute correctness.`
      }
    });
    const result = await chat.sendMessage({ message });
    const answer = result.text?.trim();
    if (!answer) throw new Error("Empty AI response");
    res.json({ answer });
  } catch (e) {
    console.error("Chat error:", e?.message || e);
    res.status(500).json({ error: "जवाब नहीं मिल पाया। API quota, model access और server logs जाँचें।" });
  }
});

// Premium UI is included, but payments are intentionally not faked.
// Connect a real payment provider and verify payments on the server before enabling premium.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Philosophy AI running on port ${PORT}`));