// ================================================
//   Best Buy Mini App - Backend v4
//   New: /setvip bot command, /api/buy-vip endpoint
// ================================================

require("dotenv").config();

const express     = require("express");
const cors        = require("cors");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

const BOT_TOKEN    = process.env.BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://ponzifrontend.vercel.app/";
const ADMIN_KEY    = process.env.ADMIN_KEY     || "changeme";
const ADMIN_IDS    = (process.env.ADMIN_IDS || "").split(",").map(Number).filter(Boolean);
const PORT         = process.env.PORT          || 3000;
const MONGO_URI    = process.env.MONGO_URI     || null;

if (!BOT_TOKEN) {
  console.error("❌  BOT_TOKEN မသတ်မှတ်ရသေး!");
  process.exit(1);
}

// ================================================
//   DB ADAPTER  (MongoDB ↔ In-Memory)
// ================================================
let db = null;

async function initDB() {
  if (MONGO_URI) {
    try {
      const { MongoClient } = require("mongodb");
      const client = new MongoClient(MONGO_URI);
      await client.connect();
      db = client.db("bestbuy");
      console.log("✅  MongoDB ချိတ်ဆက်ပြီး!");
    } catch (err) {
      console.warn("⚠️  MongoDB မချိတ်နိုင်ပါ, In-Memory သုံးမည်:", err.message);
      db = null;
    }
  } else {
    console.log("ℹ️  In-Memory Map သုံးနေသည်");
  }
}

const usersMap    = new Map();
const depositsMap = new Map();
const withdrawMap = new Map();

async function dbGetUser(telegram_id) {
  const uid = Number(telegram_id);
  if (db) return await db.collection("users").findOne({ telegram_id: uid });
  return usersMap.get(uid) || null;
}

async function dbSetUser(user) {
  const uid = Number(user.telegram_id);
  if (db) {
    await db.collection("users").updateOne(
      { telegram_id: uid }, { $set: user }, { upsert: true }
    );
  } else {
    usersMap.set(uid, user);
  }
}

async function dbGetAllUsers() {
  if (db) return await db.collection("users").find({}).toArray();
  return Array.from(usersMap.values());
}

async function dbSaveDeposit(dep) {
  if (db) await db.collection("deposits").insertOne(dep);
  else depositsMap.set(dep.id, dep);
}

async function dbSaveWithdraw(w) {
  if (db) await db.collection("withdrawals").insertOne(w);
  else withdrawMap.set(w.id, w);
}

// ================================================
//   PRODUCT DATA
// ================================================
function generateProducts() {
  const lv1 = [];
  for (let i = 1; i <= 5; i++) {
    const price = Math.floor(Math.random() * (4500 - 2000 + 1) + 2000);
    lv1.push({ id: `p${i}`, image: `/images/p${i}.png`, price, level: 1, commission: Math.round(price * 0.1) });
  }
  const lv2 = [];
  for (let i = 6; i <= 15; i++) {
    const price = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    lv2.push({ id: `p${i}`, image: `/images/p${i}.png`, price, level: 2, commission: Math.round(price * 0.1) });
  }
  return { lv1, lv2 };
}

// VIP config
const VIP_CONFIG = {
  1: { cost: 5000,  daily_limit: 10,  label: "VIP-1" },
  2: { cost: 50000, daily_limit: 20,  label: "VIP-2" },
};

// ================================================
//   MIDDLEWARE
// ================================================
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","x-admin-key"] }));
app.use(express.json());
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next(); });

// ================================================
//   TELEGRAM BOT
// ================================================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖  Telegram Bot စတင်နေပြီ...");

function notifyAdmins(text) {
  ADMIN_IDS.forEach(id => bot.sendMessage(id, text).catch(() => {}));
}

// ── /start ───────────────────────────────────────
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
  const chatId    = msg.chat.id;
  const uid       = msg.from.id;
  const firstName = msg.from?.first_name || "မိတ်ဆွေ";
  const refId     = match[1] ? Number(match[1]) : null;

  let user = await dbGetUser(uid);
  if (!user) {
    user = {
      telegram_id: uid, username: msg.from.username || "",
      first_name: msg.from.first_name || "", last_name: msg.from.last_name || "",
      balance: 0, commission: 0, vip_level: 0,
      daily_orders: 0, last_order_date: "",
      referral_by: refId, banned: false,
      joined_at: new Date().toISOString(), last_seen: new Date().toISOString(),
    };
    await dbSetUser(user);
    if (refId && refId !== uid) {
      const refUser = await dbGetUser(refId);
      if (refUser) {
        refUser.balance += 1000; refUser.commission += 1000;
        await dbSetUser(refUser);
        bot.sendMessage(refId, `🎉 Referral Bonus ၁,၀၀၀ ကျပ် ရရှိပြီ!`).catch(() => {});
      }
    }
  } else {
    user.last_seen = new Date().toISOString();
    await dbSetUser(user);
  }

  bot.sendMessage(chatId,
    `👋 မင်္ဂလာပါ, ${firstName}!\n\n🛍️  Best Buy Mini App မှ ကြိုဆိုပါသည်\n\n` +
    `✅  Commission ၁၀% ရရှိနိုင်သည်\n💰  ငွေများ လွယ်ကူထုတ်ယူနိုင်သည်\n👥  မိတ်ဆွေဖိတ်ကာ Bonus ရနိုင်သည်\n\n` +
    `👇 App ဝင်ရောက်ပါ!`,
    { reply_markup: { inline_keyboard: [[{ text: "🌐  App ဖွင့်မည်", web_app: { url: FRONTEND_URL } }]] } }
  );
});

// ── /balance ─────────────────────────────────────
bot.onText(/\/balance/, async (msg) => {
  const user = await dbGetUser(msg.from.id);
  if (!user) return bot.sendMessage(msg.chat.id, "❌  /start နှိပ်ပြီး မှတ်ပုံတင်ပါ");
  bot.sendMessage(msg.chat.id,
    `💰 လက်ကျန်ငွေ: ${user.balance.toLocaleString()} ကျပ်\n` +
    `📈 Commission: ${user.commission.toLocaleString()} ကျပ်\n` +
    `💎 VIP Level: ${user.vip_level || 0}\n` +
    `📦 ယနေ့ Orders: ${user.daily_orders || 0}`
  );
});

// ── /topup <uid> <amount> ─────────────────────────
bot.onText(/\/topup (\d+) (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const uid = Number(match[1]), amount = Number(match[2]);
  const user = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ");
  user.balance += amount;
  await dbSetUser(user);
  bot.sendMessage(msg.chat.id, `✅ ID ${uid} ထံ ${amount.toLocaleString()} ကျပ် ဖြည့်ပြီး\nလက်ကျန်: ${user.balance.toLocaleString()} ကျပ်`);
  bot.sendMessage(uid, `💰 သင့်အကောင့်သို့ ${amount.toLocaleString()} ကျပ် ဝင်ရောက်ပြီ!`).catch(() => {});
});

// ── /setvip <uid> <level>  ← NEW ──────────────────
bot.onText(/\/setvip (\d+) (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "❌ Admin သာ သုံးနိုင်သည်");
  }
  const uid   = Number(match[1]);
  const level = Number(match[2]);

  if (![0, 1, 2].includes(level)) {
    return bot.sendMessage(msg.chat.id, "❌ VIP Level သည် 0, 1, 2 သာ ဖြစ်နိုင်သည်");
  }

  const user = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ");

  user.vip_level = level;
  await dbSetUser(user);

  const label = level === 0 ? "VIP မဟုတ်" : `VIP-${level}`;
  bot.sendMessage(msg.chat.id, `✅ ID ${uid} (@${user.username || "—"}) ကို ${label} သတ်မှတ်ပြီး`);
  bot.sendMessage(uid,
    `💎 သင့် VIP Level ကို Admin မှ ${label} အဖြစ် Update ပြုလုပ်ပြီး!\n` +
    `${level > 0 ? "App ကို Refresh လုပ်ပြီး Order Grab စလုပ်နိုင်ပြီ 🎉" : ""}`
  ).catch(() => {});
});

// ── /ban /unban ───────────────────────────────────
bot.onText(/\/ban (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const user = await dbGetUser(Number(match[1]));
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ");
  user.banned = true; await dbSetUser(user);
  bot.sendMessage(msg.chat.id, `🚫 ID ${match[1]} ပိတ်ဆို့ပြီး`);
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const user = await dbGetUser(Number(match[1]));
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ");
  user.banned = false; await dbSetUser(user);
  bot.sendMessage(msg.chat.id, `✅ ID ${match[1]} ပြန်ဖွင့်ပြီး`);
});

// ── /withdraw_approve ─────────────────────────────
bot.onText(/\/withdraw_approve (\d+) (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const uid = Number(match[1]), amount = Number(match[2]);
  const user = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ");
  if (user.balance < amount) return bot.sendMessage(msg.chat.id, "❌ လက်ကျန် မလုံလောက်ပါ");
  user.balance -= amount; await dbSetUser(user);
  bot.sendMessage(msg.chat.id, `✅ ID ${uid} ထံ ${amount.toLocaleString()} ကျပ် ထုတ်ပေးပြီး`);
  bot.sendMessage(uid, `✅ ငွေထုတ်မှု ${amount.toLocaleString()} ကျပ် အတည်ပြုပြီး!`).catch(() => {});
});

// ── /stats ────────────────────────────────────────
bot.onText(/\/stats/, async (msg) => {
  if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(msg.from.id)) return;
  const users    = await dbGetAllUsers();
  const totalBal = users.reduce((s, u) => s + (u.balance || 0), 0);
  const vip1     = users.filter(u => u.vip_level === 1).length;
  const vip2     = users.filter(u => u.vip_level === 2).length;
  bot.sendMessage(msg.chat.id,
    `📊 Server Stats\n\n👤 Users: ${users.length}\n💎 VIP-1: ${vip1} | VIP-2: ${vip2}\n` +
    `💰 Total Balance: ${totalBal.toLocaleString()} ကျပ်`
  );
});

// ── /help (admin) ─────────────────────────────────
bot.onText(/\/help/, (msg) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
    `🛠 Admin Commands\n\n` +
    `/topup <uid> <amount> — ငွေဖြည့်ပေးရန်\n` +
    `/setvip <uid> <0|1|2> — VIP Level သတ်မှတ်ရန်\n` +
    `/ban <uid> — User ပိတ်ရန်\n` +
    `/unban <uid> — User ဖွင့်ရန်\n` +
    `/withdraw_approve <uid> <amount> — ငွေထုတ်အတည်ပြုရန်\n` +
    `/stats — စာရင်းကြည့်ရန်`
  );
});

bot.on("polling_error", (err) => console.error("Polling error:", err.message));

// ================================================
//   REST API
// ================================================

app.get("/", async (_req, res) => {
  const users = await dbGetAllUsers();
  res.json({ status: "✅ Running", app: "Best Buy v4", users: users.length, time: new Date().toISOString() });
});

// GET /api/products
app.get("/api/products", (_req, res) => {
  res.json({ success: true, products: generateProducts() });
});

// POST /api/user/register
app.post("/api/user/register", async (req, res) => {
  const { telegram_id, username, first_name, last_name, ref } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id လိုအပ်သည်" });

  const uid  = Number(telegram_id);
  let   user = await dbGetUser(uid);

  if (user) {
    user.username = username || user.username;
    user.first_name = first_name || user.first_name;
    user.last_name  = last_name  || user.last_name;
    user.last_seen  = new Date().toISOString();
    await dbSetUser(user);
    return res.json({ success: true, user });
  }

  const refId   = ref ? Number(ref) : null;
  const newUser = {
    telegram_id: uid, username: username || "", first_name: first_name || "", last_name: last_name || "",
    balance: 0, commission: 0, vip_level: 0, daily_orders: 0, last_order_date: "",
    referral_by: refId, banned: false,
    joined_at: new Date().toISOString(), last_seen: new Date().toISOString(),
  };
  await dbSetUser(newUser);

  if (refId && refId !== uid) {
    const refUser = await dbGetUser(refId);
    if (refUser) {
      refUser.balance += 1000; refUser.commission += 1000;
      await dbSetUser(refUser);
      bot.sendMessage(refId, `🎉 Referral Bonus ၁,၀၀၀ ကျပ် ရရှိပြီ!`).catch(() => {});
    }
  }

  return res.json({ success: true, user: newUser });
});

// GET /api/user/:id
app.get("/api/user/:id", async (req, res) => {
  const user = await dbGetUser(req.params.id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  res.json({ success: true, user });
});

// POST /api/buy-vip  ← MAIN NEW ENDPOINT
app.post("/api/buy-vip", async (req, res) => {
  const { telegram_id, vip_level } = req.body;
  if (!telegram_id || !vip_level) return res.status(400).json({ error: "ပါမတာ မပြည့်စုံပါ" });

  const level = Number(vip_level);
  if (![1, 2].includes(level)) return res.status(400).json({ error: "VIP Level မမှန်ကန်ပါ" });

  const user = await dbGetUser(telegram_id);
  if (!user)        return res.status(404).json({ error: "User မတွေ့ပါ" });
  if (user.banned)  return res.status(403).json({ error: "သင့်အကောင့် ပိတ်ဆို့ထားသည်" });

  const cfg  = VIP_CONFIG[level];
  const cost = cfg.cost;

  // Already owns this or higher level
  if (user.vip_level >= level) {
    return res.status(400).json({ error: `VIP-${level} ကို ပိုင်ဆိုင်ပြီး ဖြစ်သည်` });
  }

  // Balance check
  if (user.balance < cost) {
    return res.status(400).json({
      error: `လက်ကျန်ငွေ မလုံလောက်ပါ။ လိုအပ်သည်: ${cost.toLocaleString()} ကျပ် | လက်ကျန်: ${user.balance.toLocaleString()} ကျပ်`,
      required: cost,
      current_balance: user.balance,
    });
  }

  user.balance  -= cost;
  user.vip_level = level;
  await dbSetUser(user);

  notifyAdmins(`💎 User ${telegram_id} (@${user.username || "—"}) က VIP-${level} ဝယ်ယူပြီ! Balance: ${user.balance.toLocaleString()} ကျပ်`);

  res.json({
    success:         true,
    vip_level:       user.vip_level,
    new_balance:     user.balance,
    daily_limit:     cfg.daily_limit,
    message:         `VIP-${level} အောင်မြင်စွာ ဝယ်ယူပြီ! Order Grab စလုပ်နိုင်ပြီ 🎉`,
  });
});

// POST /api/order/grab
app.post("/api/order/grab", async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id လိုအပ်သည်" });

  const user = await dbGetUser(telegram_id);
  if (!user)       return res.status(404).json({ error: "User မတွေ့ပါ" });
  if (user.banned) return res.status(403).json({ error: "သင့်အကောင့် ပိတ်ဆို့ထားသည်" });
  if (!user.vip_level) return res.status(403).json({ error: "VIP ဝယ်ယူမှသာ Order Grab လုပ်နိုင်သည်" });

  const today = new Date().toISOString().slice(0, 10);
  if (user.last_order_date === today) {
    const limit = VIP_CONFIG[user.vip_level]?.daily_limit || 10;
    if (user.daily_orders >= limit) return res.status(429).json({ error: `နေ့စဉ် Order Limit (${limit}) ပြည့်နေပြီ` });
  } else {
    user.daily_orders    = 0;
    user.last_order_date = today;
  }

  const { lv1, lv2 }  = generateProducts();
  const pool           = user.vip_level === 1 ? lv1 : [...lv1, ...lv2];
  const product        = pool[Math.floor(Math.random() * pool.length)];
  const commission     = Math.round(product.price * 0.1);

  user.balance      += commission;
  user.commission   += commission;
  user.daily_orders += 1;
  await dbSetUser(user);

  res.json({
    success: true, product, commission,
    new_balance: user.balance, daily_orders: user.daily_orders,
    message: `Commission ${commission.toLocaleString()} ကျပ် ရရှိပြီ!`,
  });
});

// POST /api/deposit/request
app.post("/api/deposit/request", async (req, res) => {
  const { telegram_id, amount, method } = req.body;
  if (!telegram_id || !amount) return res.status(400).json({ error: "ပါမတာ မပြည့်စုံ" });
  const dep = { id: `dep_${Date.now()}`, telegram_id: Number(telegram_id), amount: Number(amount), method: method || "KPay", status: "pending", created_at: new Date().toISOString() };
  await dbSaveDeposit(dep);
  notifyAdmins(`💳 ငွေဖြည့်တောင်းဆိုမှု\nUser: ${telegram_id}\nပမာဏ: ${Number(amount).toLocaleString()} ကျပ်\nMethod: ${method}\nConfirm: /topup ${telegram_id} ${amount}`);
  res.json({ success: true, message: "Admin မှ ၁-၂ နာရီအတွင်း ဖြည့်ပေးပါမည်" });
});

// POST /api/withdraw/request
app.post("/api/withdraw/request", async (req, res) => {
  const { telegram_id, amount, method, account } = req.body;
  if (!telegram_id || !amount) return res.status(400).json({ error: "ပါမတာ မပြည့်စုံ" });
  const user = await dbGetUser(telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  if (user.balance < Number(amount)) return res.status(400).json({ error: "လက်ကျန်ငွေ မလုံလောက်ပါ" });
  const w = { id: `wth_${Date.now()}`, telegram_id: Number(telegram_id), amount: Number(amount), method: method || "KPay", account: account || "", status: "pending", created_at: new Date().toISOString() };
  await dbSaveWithdraw(w);
  notifyAdmins(`💸 ငွေထုတ်တောင်းဆိုမှု\nUser: ${telegram_id}\nပမာဏ: ${Number(amount).toLocaleString()} ကျပ်\n${method} → ${account}\nApprove: /withdraw_approve ${telegram_id} ${amount}`);
  res.json({ success: true, message: "Admin မှ စစ်ဆေးပြီး လုပ်ဆောင်ပေးမည်" });
});

// Admin REST endpoints
app.post("/api/admin/topup", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const user = await dbGetUser(req.body.telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.balance += Number(req.body.amount); await dbSetUser(user);
  res.json({ success: true, new_balance: user.balance });
});

app.post("/api/admin/setvip", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const user  = await dbGetUser(req.body.telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.vip_level = Number(req.body.vip_level); await dbSetUser(user);
  res.json({ success: true, vip_level: user.vip_level });
});

app.get("/api/admin/users", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const list = await dbGetAllUsers();
  res.json({ success: true, count: list.length, users: list });
});

app.use((_req, res) => res.status(404).json({ error: "Route မတွေ့ပါ" }));

// ================================================
//   START
// ================================================
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server → http://localhost:${PORT}`);
    console.log(`📱 Frontend → ${FRONTEND_URL}`);
  });
});
