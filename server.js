// ================================================
//   Telegram Mini App - Backend (All-in-One)
//   File   : server.js
//   Deploy : Render.com
//   URL    : https://ponzibackend.onrender.com
// ================================================

// ── Load .env (local dev only; on Render use Dashboard env vars) ──
require("dotenv").config();

// ── Core Dependencies ──────────────────────────
const express    = require("express");
const cors       = require("cors");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

// ================================================
//   ENVIRONMENT VARIABLES
//   Set these in Render Dashboard → Environment
// ================================================
const BOT_TOKEN    = process.env.BOT_TOKEN;          // Required
const FRONTEND_URL = process.env.FRONTEND_URL || "https://ponzifrontend.vercel.app/";
const ADMIN_KEY    = process.env.ADMIN_KEY    || "changeme";
const PORT         = process.env.PORT         || 3000;

if (!BOT_TOKEN) {
  console.error("❌  BOT_TOKEN မသတ်မှတ်ရသေး! Render Environment Variables ထဲ ထည့်ပါ။");
  process.exit(1);
}

// ================================================
//   MIDDLEWARE
// ================================================
app.use(cors({
  origin: "*",                                        // Vercel frontend ကို ခွင့်ပြုသည်
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
}));
app.use(express.json());

// ── Request Logger ──────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ================================================
//   IN-MEMORY DATA STORE
//   Production မှာ MongoDB / PostgreSQL နဲ့ အစားထိုးပါ
// ================================================
const users = new Map();      // key: telegram_id (Number)
const tasks = new Map();      // key: telegram_id → task array (future use)

// Helper: get or create user
function getUser(telegram_id) {
  return users.get(Number(telegram_id)) || null;
}

// ================================================
//   TELEGRAM BOT SETUP
// ================================================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖  Telegram Bot စတင်နေပြီ (polling mode)...");

// ── /start Command ──────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId    = msg.chat.id;
  const firstName = msg.from?.first_name || "မိတ်ဆွေ";

  // Auto-register from bot side
  if (msg.from) {
    const uid = msg.from.id;
    if (!users.has(uid)) {
      users.set(uid, {
        telegram_id: uid,
        username:    msg.from.username   || "",
        first_name:  msg.from.first_name || "",
        last_name:   msg.from.last_name  || "",
        balance:     0,
        commission:  0,
        joined_at:   new Date().toISOString(),
        last_seen:   new Date().toISOString(),
      });
      console.log(`✅  New user registered via /start: ${uid}`);
    } else {
      // Update last seen
      const u = users.get(uid);
      u.last_seen = new Date().toISOString();
      users.set(uid, u);
    }
  }

  const welcomeText =
    `👋 မင်္ဂလာပါ, ${firstName}!\n\n` +
    `🛍️  Best Buy Mini App မှ ကြိုဆိုပါသည်\n\n` +
    `✅  Commission များ ရရှိနိုင်သည်\n` +
    `💰  ငွေများ လွယ်ကူစွာ ထုတ်ယူနိုင်သည်\n` +
    `👥  မိတ်ဆွေများ ဖိတ်ကာ Bonus ရနိုင်သည်\n\n` +
    `👇  အောက်ပါ ခလုတ်ကို နှိပ်ပြီး App ဝင်ရောက်ပါ!`;

  bot.sendMessage(chatId, welcomeText, {
    reply_markup: {
      inline_keyboard: [[
        {
          text:    "🌐  Website သို့ ဝင်ရန်",
          web_app: { url: FRONTEND_URL },
        },
      ]],
    },
  });
});

// ── /balance Command ────────────────────────────
bot.onText(/\/balance/, (msg) => {
  const chatId = msg.chat.id;
  const user   = getUser(msg.from?.id);
  if (user) {
    bot.sendMessage(chatId,
      `💰  လက်ကျန်ငွေ: $${user.balance.toFixed(2)}\n` +
      `📈  Commission: $${user.commission.toFixed(2)}`
    );
  } else {
    bot.sendMessage(chatId, "❌  /start နှိပ်ပြီး အရင် မှတ်ပုံတင်ပါ။");
  }
});

// ── /stats Command (Admin) ──────────────────────
bot.onText(/\/stats/, (msg) => {
  const chatId     = msg.chat.id;
  const adminIds   = (process.env.ADMIN_IDS || "").split(",").map(Number);
  const isAdmin    = adminIds.includes(msg.from?.id);

  if (!isAdmin && adminIds.length > 0) {
    return bot.sendMessage(chatId, "❌  ဤ Command ကို Admin သာ သုံးနိုင်သည်။");
  }

  bot.sendMessage(chatId,
    `📊  Server Stats\n\n` +
    `👤  Users: ${users.size}\n` +
    `🕐  Time:  ${new Date().toISOString()}`
  );
});

// ── Unknown messages ────────────────────────────
bot.on("message", (msg) => {
  if (msg.text && !msg.text.startsWith("/") && !msg.web_app_data) {
    bot.sendMessage(msg.chat.id, "👆  /start ကို နှိပ်ပြီး App ကို ဖွင့်ပါ။");
  }
});

// ── Polling error handler ───────────────────────
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

// ================================================
//   REST API ROUTES
// ================================================

// ── Health Check ────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    status:    "✅ Server is running",
    app:       "Best Buy Mini App Backend",
    users:     users.size,
    timestamp: new Date().toISOString(),
  });
});

// ── POST /api/user/register ─────────────────────
//    Frontend Mini App မှ ခေါ်သည် (user ပွင့်တာနဲ့)
app.post("/api/user/register", (req, res) => {
  const { telegram_id, username, first_name, last_name } = req.body;

  if (!telegram_id) {
    return res.status(400).json({ error: "telegram_id လိုအပ်သည်" });
  }

  const uid = Number(telegram_id);

  if (users.has(uid)) {
    // Update existing
    const u = users.get(uid);
    u.username    = username    || u.username;
    u.first_name  = first_name  || u.first_name;
    u.last_name   = last_name   || u.last_name;
    u.last_seen   = new Date().toISOString();
    users.set(uid, u);
    return res.json({ success: true, message: "updated", user: u });
  }

  // New user
  const newUser = {
    telegram_id: uid,
    username:    username    || "",
    first_name:  first_name  || "",
    last_name:   last_name   || "",
    balance:     0,
    commission:  0,
    joined_at:   new Date().toISOString(),
    last_seen:   new Date().toISOString(),
  };
  users.set(uid, newUser);
  console.log(`✅  New user via Mini App: ${uid} (@${username})`);
  return res.json({ success: true, message: "registered", user: newUser });
});

// ── GET /api/user/:id/balance ───────────────────
app.get("/api/user/:id/balance", (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  res.json({ success: true, balance: user.balance, commission: user.commission });
});

// ── GET /api/user/:id ───────────────────────────
app.get("/api/user/:id", (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  res.json({ success: true, user });
});

// ── POST /api/user/:id/topup (Admin) ───────────
app.post("/api/user/:id/topup", (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });

  const amount = Number(req.body.amount) || 0;
  user.balance += amount;
  user.commission += amount;
  users.set(user.telegram_id, user);

  res.json({ success: true, new_balance: user.balance });
});

// ── GET /api/admin/users (Admin) ────────────────
app.get("/api/admin/users", (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const list = Array.from(users.values());
  res.json({ success: true, count: list.length, users: list });
});

// ── 404 fallback ────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route မတွေ့ပါ" });
});

// ================================================
//   START SERVER
// ================================================
app.listen(PORT, () => {
  console.log(`🚀  Server running → http://localhost:${PORT}`);
  console.log(`📱  Frontend URL  → ${FRONTEND_URL}`);
  console.log(`🌐  Backend URL   → https://ponzibackend.onrender.com`);
});
