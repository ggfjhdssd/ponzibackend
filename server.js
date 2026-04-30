// ================================================
//   Wealth Flow Myanmar - Backend v7
//   File   : server.js
//   Deploy : Render.com
//   v7 အသစ်ထည့်ဆောင်ချက်များ:
//     • Channel Join စစ်ဆေးခြင်း (@wealthflowmyanmar)
//     • Callback query (check_join) ကိုင်တွယ်ခြင်း
//     • Frontend URL → https://ponzifrontend-7cvb.vercel.app/
//     • VIP 3 & 4 (prices: 50k, 100k)
//     • Products P16–P30 (VIP3: P16-P22, VIP4: P23-P30)
//     • Tiered withdrawal fees (VIP1-2: 20%, VIP3-4: 5%)
//     • Principal Lock: withdrawable = balance - total_deposited
//     • Min withdraw profit: 3,000 MMK
//     • referral_earned_total field
//     • Lucky Spin (daily, last_spin_date)
//     • My Invitation API
//     • Error handling + process handlers
// ================================================

require("dotenv").config();

const express     = require("express");
const cors        = require("cors");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

const BOT_TOKEN    = process.env.BOT_TOKEN;
// Fix 3: Updated frontend URL
const FRONTEND_URL = process.env.FRONTEND_URL || "https://ponzifrontend-7cvb.vercel.app/";
const ADMIN_KEY    = process.env.ADMIN_KEY    || "changeme";
const ADMIN_IDS    = (process.env.ADMIN_IDS || "").split(",").map(Number).filter(Boolean);
const PORT         = process.env.PORT         || 3000;
const MONGO_URI    = process.env.MONGO_URI    || null;
const CHANNEL_ID   = "@wealthflowmyanmar";   // Fix 1: Channel to check

if (!BOT_TOKEN) {
  console.error("❌  BOT_TOKEN မသတ်မှတ်ရသေး!");
  process.exit(1);
}

// ================================================
//   MONGODB ADAPTER
// ================================================
let db = null;

async function initDB() {
  if (MONGO_URI) {
    try {
      const { MongoClient } = require("mongodb");
      const client = new MongoClient(MONGO_URI);
      await client.connect();
      db = client.db("wealthflow");
      console.log("✅  MongoDB ချိတ်ဆက်ပြီး!");

      // ── TTL Index: grab_history auto-delete after 3 days (259200s) ──
      await db.collection("grab_history").createIndex(
        { "createdAt": 1 },
        { expireAfterSeconds: 259200 }
      ).catch(e => console.log("TTL index grab_history:", e.message));

      // ── TTL Index: deposits auto-delete after 10 days (864000s) ──
      await db.collection("deposits").createIndex(
        { "createdAt": 1 },
        { expireAfterSeconds: 864000 }
      ).catch(e => console.log("TTL index deposits:", e.message));

      // ── Index: users by telegram_id for fast lookup ──
      await db.collection("users").createIndex(
        { "telegram_id": 1 }, { unique: true }
      ).catch(e => console.log("Users index:", e.message));

      console.log("✅  Indexes created (TTL + user)");
    } catch (err) {
      console.warn("⚠️  MongoDB မချိတ်နိုင်:", err.message);
      db = null;
    }
  } else {
    console.log("ℹ️  In-Memory Map သုံးနေသည်");
  }
}

const usersMap    = new Map();
const depositsMap = new Map();
const withdrawMap = new Map();
const spinsMap    = new Map();

// ── Race Condition Prevention: track in-progress grab requests ──
const grabLocks = new Set();

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

async function dbSaveDeposit(deposit) {
  if (db) await db.collection("deposits").insertOne(deposit);
  else    depositsMap.set(deposit.id, deposit);
}

async function dbSaveWithdraw(w) {
  if (db) await db.collection("withdrawals").insertOne(w);
  else    withdrawMap.set(w.id, w);
}

// ================================================
//   PRODUCT DATA — v7: P1-P30
// ================================================
const PRODUCT_NAMES = {
  // VIP 1 (P1-P5)
  p1:  "သွားတိုက်တံ (Toothbrush)",
  p2:  "သွားတိုက်ဆေး (Toothpaste)",
  p3:  "ဖိနပ် (Shoes)",
  p4:  "ရေချိုးခန်းအခင်း (Bath Mat)",
  p5:  "မြက်အခင်း (Grass Mat)",
  // VIP 2 (P6-P15)
  p6:  "Computer Mouse",
  p7:  "Keyboard",
  p8:  "Phone Cover",
  p9:  "USB Stick",
  p10: "Bluetooth Box",
  p11: "Bluetooth Headphones",
  p12: "Charger Head & Cable",
  p13: "Charging Cable Only",
  p14: "Powerbank",
  p15: "Bluetooth Airpods",
  // VIP 3 (P16-P22)
  p16: "Smart Watch (အဆင့်မြင့် စမတ်နာရီ)",
  p17: "Bluetooth Speaker (အသံထွက်ကောင်း စပီကာ)",
  p18: "Portable Projector (အိတ်ဆောင် ပရိုဂျက်တာ)",
  p19: "Gaming Keyboard (မီးလင်းကီးဘုတ်)",
  p20: "Security Camera (ဝိုင်ဖိုင် ကင်မရာ)",
  p21: "Power Bank 30,000 mAh (အကြီးစား)",
  p22: "Wireless Mouse (ကြိုးမဲ့ မောက်စ်)",
  // VIP 4 (P23-P30)
  p23: "VR Headset (Virtual Reality မှန်ဘီလူး)",
  p24: "High-End Tablet (တက်ဘလက်)",
  p25: "Noise Cancelling Headphones (နားကြပ်)",
  p26: "Smart Home Hub (အိမ်သုံး စမတ်စနစ်)",
  p27: "DSLR Lens (ကင်မရာ မှန်ဘီလူး)",
  p28: "Drone (ကင်မရာပါသော ဒရုန်း)",
  p29: "Laptop Stand with RGB (မီးလင်း လပ်တော့စင်)",
  p30: "Professional Microphone (အဆင့်မြင့် မိုက်ကရိုဖုန်း)",
};

// Price ranges per VIP level
const VIP_PRICE_RANGES = {
  1: { min: 5000,  max: 15000  },
  2: { min: 15000, max: 30000  },
  3: { min: 30000, max: 50000  },
  4: { min: 50000, max: 100000 },
};

function randPrice(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

function makeProduct(id, level) {
  const r     = VIP_PRICE_RANGES[level];
  const price = randPrice(r.min, r.max);
  return { id, name: PRODUCT_NAMES[id] || id, image: `/images/${id}.png`, price, level, commission: Math.round(price * 0.1) };
}

function generateProducts() {
  const lv1 = [1,2,3,4,5].map(i => makeProduct(`p${i}`, 1));
  const lv2 = [6,7,8,9,10,11,12,13,14,15].map(i => makeProduct(`p${i}`, 2));
  const lv3 = [16,17,18,19,20,21,22].map(i => makeProduct(`p${i}`, 3));
  const lv4 = [23,24,25,26,27,28,29,30].map(i => makeProduct(`p${i}`, 4));
  return { lv1, lv2, lv3, lv4 };
}

// ================================================
//   CONSTANTS
// ================================================
const VIP_PRICES = { 1: 5000, 2: 20000, 3: 50000, 4: 100000 };
const VIP_LIMITS = { 1: 10,   2: 10,    3: 15,    4: 20    };
const MIN_WITHDRAW_PROFIT = 3000;

// Tiered withdrawal fees
function getWithdrawFee(vip_level) {
  return (vip_level >= 3) ? 0.05 : 0.20;   // VIP3-4: 5%, VIP1-2: 20%
}

function calcReferralBonus(depositAmount) {
  if (depositAmount >= 20000) return 4000;
  if (depositAmount >= 5000)  return 1000;
  return 0;
}

// Lucky Spin rewards pool
const SPIN_REWARDS = [100, 200, 200, 500, 100, 200, 500, 100, 200, 1000];

// ================================================
//   MIDDLEWARE
// ================================================
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","x-admin-key"] }));
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ================================================
//   TELEGRAM BOT
// ================================================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖  Wealth Flow Myanmar Bot v7 စတင်နေပြီ...");

function notifyAdmins(text) {
  ADMIN_IDS.forEach(id =>
    bot.sendMessage(id, text).catch(err => console.log("Admin notify error:", err.message))
  );
}

// Fix 1: Check channel membership
async function isChannelMember(userId) {
  try {
    const member = await bot.getChatMember(CHANNEL_ID, userId);
    return ["member","administrator","creator"].includes(member.status);
  } catch (err) {
    console.log("getChatMember error:", err.message);
    return false;
  }
}

function sendJoinWarning(chatId) {
  bot.sendMessage(chatId,
    `⚠️ အရေးကြီးသတိပေးချက်\n\n` +
    `သင်သည် ကျွန်ုပ်တို့၏ Official Channel ကို Join ထားခြင်း မရှိသေးပါ။\n` +
    `Channel Join ပြီးမှသာ App ကို အသုံးပြုခွင့် ရရှိမည်ဖြစ်သည်။\n\n` +
    `👇 အောက်ပါခလုတ်ကိုနှိပ်ပြီး Channel Join ပါ။`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 Channel Join ရန်", url: "https://t.me/wealthflowmyanmar" }],
          [{ text: "✅ Joined", callback_data: "check_join" }],
        ],
      },
    }
  ).catch(err => console.log("Telegram Send Error:", err.message));
}

function sendWelcome(chatId, firstName, refId) {
  const uid = chatId;
  bot.sendMessage(chatId,
    `👋 မင်္ဂလာပါ, ${firstName}!\n\n` +
    `🛍️ Best Buy Mini App မှ ကြိုဆိုပါသည်\n` +
    `✅ Commission များ ရရှိနိုင်သည်\n` +
    `💰 ငွေများ လွယ်ကူစွာ ထုတ်ယူနိုင်သည်\n` +
    `👥 မိတ်ဆွေများ ဖိတ်ကာ Bonus ရနိုင်သည်\n\n` +
    `👇 အောက်ပါ ခလုတ်ကို နှိပ်ပြီး App ဝင်ရောက်ပါ!`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "🌐 App ဖွင့်ရန်", web_app: { url: FRONTEND_URL } },
        ]],
      },
    }
  ).catch(err => console.log("Telegram Send Error:", err.message));
}

// ─── /start ──────────────────────────────────────
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
  const chatId    = msg.chat.id;
  const uid       = msg.from.id;
  const firstName = msg.from?.first_name || "မိတ်ဆွေ";
  const refId     = match[1] ? Number(match[1]) : null;

  // Fix 1: Check channel membership first
  const isMember = await isChannelMember(uid);
  if (!isMember) {
    sendJoinWarning(chatId);
    return;
  }

  let user = await dbGetUser(uid);
  if (!user) {
    user = {
      telegram_id:          uid,
      username:             msg.from.username   || "",
      first_name:           msg.from.first_name || "",
      last_name:            msg.from.last_name  || "",
      balance:              0,
      commission:           0,
      vip_level:            0,
      daily_orders:         0,
      last_order_date:      "",
      referral_by:          refId,
      total_deposited:      0,
      referral_earned_total:0,   // v7: track referral earnings
      last_spin_date:       "",  // v7: lucky spin
      banned:               false,
      joined_at:            new Date().toISOString(),
      last_seen:            new Date().toISOString(),
    };
    await dbSetUser(user);
    if (refId && refId !== uid) notifyAdmins(`👤 New user ${uid} joined via ref of ${refId}`);
  } else {
    user.last_seen = new Date().toISOString();
    await dbSetUser(user);
  }

  sendWelcome(chatId, firstName, refId);
});

// Fix 3: Callback query for check_join
bot.on("callback_query", async (query) => {
  const chatId    = query.message.chat.id;
  const uid       = query.from.id;
  const firstName = query.from?.first_name || "မိတ်ဆွေ";
  const data      = query.data;

  if (data === "check_join") {
    const isMember = await isChannelMember(uid);
    if (isMember) {
      // Answer callback first
      bot.answerCallbackQuery(query.id, { text: "✅ Join ပြီးပါပြီ! App ဖွင့်နိုင်ပြီ" })
        .catch(err => console.log("Telegram Send Error:", err.message));

      // Register user if new
      let user = await dbGetUser(uid);
      if (!user) {
        user = {
          telegram_id:           uid,
          username:              query.from.username   || "",
          first_name:            query.from.first_name || "",
          last_name:             query.from.last_name  || "",
          balance:               0, commission: 0, vip_level: 0,
          daily_orders:          0, last_order_date: "",
          referral_by:           null, total_deposited: 0,
          referral_earned_total: 0, last_spin_date: "",
          banned: false,
          joined_at:  new Date().toISOString(),
          last_seen:  new Date().toISOString(),
        };
        await dbSetUser(user);
      }

      sendWelcome(chatId, firstName, null);
    } else {
      bot.answerCallbackQuery(query.id, { text: "⚠️ Channel Join မထားသေးပါ" })
        .catch(err => console.log("Telegram Send Error:", err.message));
      sendJoinWarning(chatId);
    }
  }
});

// ─── /balance ────────────────────────────────────
bot.onText(/\/balance/, async (msg) => {
  const user = await dbGetUser(msg.from.id);
  if (user) {
    bot.sendMessage(msg.chat.id,
      `💰 လက်ကျန်ငွေ: ${user.balance.toLocaleString()} ကျပ်\n` +
      `📈 Commission: ${user.commission.toLocaleString()} ကျပ်\n` +
      `💎 VIP Level: ${user.vip_level || 0}`
    ).catch(err => console.log("Telegram Send Error:", err.message));
  } else {
    bot.sendMessage(msg.chat.id, "❌ /start နှိပ်ပြီး မှတ်ပုံတင်ပါ")
      .catch(err => console.log("Telegram Send Error:", err.message));
  }
});

// ─── Admin: /topup ────────────────────────────────
bot.onText(/\/topup (\d+) (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const uid    = Number(match[1]);
  const amount = Number(match[2]);
  const user   = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ").catch(err => console.log("Telegram Send Error:", err.message));

  user.balance         += amount;
  user.total_deposited  = (user.total_deposited || 0) + amount;
  await dbSetUser(user);

  if (user.referral_by && user.referral_by !== uid) {
    const bonus = calcReferralBonus(amount);
    if (bonus > 0) {
      const refUser = await dbGetUser(user.referral_by);
      if (refUser) {
        refUser.balance               += bonus;
        refUser.commission            += bonus;
        refUser.referral_earned_total  = (refUser.referral_earned_total || 0) + bonus;
        await dbSetUser(refUser);
        bot.sendMessage(user.referral_by,
          `🎉 Referral Bonus!\nUser ${uid} က ${amount.toLocaleString()} ကျပ် ဖြည့်လို့\nသင် ${bonus.toLocaleString()} ကျပ် Bonus ရပြီ! 💰`
        ).catch(err => console.log("Telegram Send Error:", err.message));
      }
    }
  }

  bot.sendMessage(msg.chat.id,
    `✅ ID ${uid} ထံ ${amount.toLocaleString()} ကျပ် ဖြည့်ပြီး\nလက်ကျန်: ${user.balance.toLocaleString()} ကျပ်`
  ).catch(err => console.log("Telegram Send Error:", err.message));
  bot.sendMessage(uid, `💰 သင့်အကောင့်သို့ ${amount.toLocaleString()} ကျပ် ဝင်ရောက်ပြီ!`)
    .catch(err => console.log("Telegram Send Error:", err.message));
});

// ─── Admin: /setvip ───────────────────────────────
bot.onText(/\/setvip (\d+) (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id))
    return bot.sendMessage(msg.chat.id, "❌ Admin သာ သုံးနိုင်").catch(err => console.log("Telegram Send Error:", err.message));

  const uid = Number(match[1]), vipLevel = Number(match[2]);
  if (vipLevel < 0 || vipLevel > 4)
    return bot.sendMessage(msg.chat.id, "❌ VIP Level 0-4 ဖြစ်ရမည်").catch(err => console.log("Telegram Send Error:", err.message));

  const user = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ").catch(err => console.log("Telegram Send Error:", err.message));

  user.vip_level = vipLevel;
  await dbSetUser(user);
  bot.sendMessage(msg.chat.id, `✅ ID ${uid} → VIP-${vipLevel} သတ်မှတ်ပြီး`).catch(err => console.log("Telegram Send Error:", err.message));
  if (vipLevel > 0)
    bot.sendMessage(uid, `🎉 VIP-${vipLevel} ရရှိပြီ!`).catch(err => console.log("Telegram Send Error:", err.message));
});

// ─── Admin: /ban /unban ───────────────────────────
bot.onText(/\/ban (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const user = await dbGetUser(Number(match[1]));
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ").catch(err => console.log("Telegram Send Error:", err.message));
  user.banned = true; await dbSetUser(user);
  bot.sendMessage(msg.chat.id, `🚫 ID ${match[1]} ပိတ်ဆို့ပြီး`).catch(err => console.log("Telegram Send Error:", err.message));
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const user = await dbGetUser(Number(match[1]));
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ").catch(err => console.log("Telegram Send Error:", err.message));
  user.banned = false; await dbSetUser(user);
  bot.sendMessage(msg.chat.id, `✅ ID ${match[1]} ပြန်ဖွင့်ပြီး`).catch(err => console.log("Telegram Send Error:", err.message));
});

// ─── Admin: /withdraw_approve ─────────────────────
bot.onText(/\/withdraw_approve (\d+) (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const uid = Number(match[1]), amount = Number(match[2]);
  const user = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ").catch(err => console.log("Telegram Send Error:", err.message));
  if (user.balance < amount) return bot.sendMessage(msg.chat.id, "❌ Balance မလုံပါ").catch(err => console.log("Telegram Send Error:", err.message));
  user.balance -= amount; await dbSetUser(user);
  bot.sendMessage(msg.chat.id, `✅ ID ${uid} ထံ ${amount.toLocaleString()} ကျပ် ထုတ်ပေးပြီး`).catch(err => console.log("Telegram Send Error:", err.message));
  bot.sendMessage(uid, `✅ ${amount.toLocaleString()} ကျပ် ငွေထုတ် အတည်ပြုပြီး!`).catch(err => console.log("Telegram Send Error:", err.message));
});

// ─── Admin: /stats ────────────────────────────────
bot.onText(/\/stats/, async (msg) => {
  if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(msg.from.id))
    return bot.sendMessage(msg.chat.id, "❌ Admin သာ").catch(err => console.log("Telegram Send Error:", err.message));
  const users    = await dbGetAllUsers();
  const totalBal = users.reduce((s,u) => s+(u.balance||0), 0);
  [1,2,3,4].forEach(v => {});
  bot.sendMessage(msg.chat.id,
    `📊 Stats\n👤 Users: ${users.length}\n` +
    [1,2,3,4].map(v => `VIP-${v}: ${users.filter(u=>u.vip_level===v).length}`).join("\n") + "\n" +
    `💰 Total Balance: ${totalBal.toLocaleString()} ကျပ်`
  ).catch(err => console.log("Telegram Send Error:", err.message));
});

// Fix 4: Polling error with detailed log
bot.on("polling_error", (err) => {
  console.error("Polling error code:", err.code, "| message:", err.message);
});

// ================================================
//   REST API
// ================================================
app.get("/", async (_req, res) => {
  const users = await dbGetAllUsers();
  res.json({ status: "✅ Wealth Flow Myanmar Backend v7", users: users.length, timestamp: new Date().toISOString() });
});

app.get("/api/products", (_req, res) => {
  res.json({ success: true, products: generateProducts() });
});

// ─── Register ─────────────────────────────────────
app.post("/api/user/register", async (req, res) => {
  const { telegram_id, username, first_name, last_name, ref } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id လိုအပ်သည်" });

  const uid  = Number(telegram_id);
  let user   = await dbGetUser(uid);

  if (user) {
    user.username   = username   || user.username;
    user.first_name = first_name || user.first_name;
    user.last_name  = last_name  || user.last_name;
    user.last_seen  = new Date().toISOString();
    if (user.referral_earned_total === undefined) user.referral_earned_total = 0;
    if (user.last_spin_date        === undefined) user.last_spin_date        = "";
    await dbSetUser(user);
    return res.json({ success: true, message: "updated", user });
  }

  const newUser = {
    telegram_id:           uid,
    username:              username   || "",
    first_name:            first_name || "",
    last_name:             last_name  || "",
    balance:               0, commission: 0, vip_level: 0,
    daily_orders:          0, last_order_date: "",
    referral_by:           ref ? Number(ref) : null,
    total_deposited:       0,
    referral_earned_total: 0,
    last_spin_date:        "",
    banned:                false,
    joined_at:  new Date().toISOString(),
    last_seen:  new Date().toISOString(),
  };
  await dbSetUser(newUser);
  return res.json({ success: true, message: "registered", user: newUser });
});

// ─── Get User ─────────────────────────────────────
app.get("/api/user/:id", async (req, res) => {
  const user = await dbGetUser(req.params.id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  res.json({ success: true, user });
});

// ─── Check Channel Membership ─────────────────────
app.post("/api/check-channel", async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id လိုအပ်" });
  const isMember = await isChannelMember(Number(telegram_id));
  res.json({ success: true, is_member: isMember });
});

// ─── Buy VIP ──────────────────────────────────────
app.post("/api/buy-vip", async (req, res) => {
  const { telegram_id, vip_level } = req.body;
  if (!telegram_id || !vip_level) return res.status(400).json({ error: "ပါမတာ မပြည့်စုံ" });

  const level = Number(vip_level);
  if (level < 1 || level > 4) return res.status(400).json({ error: "VIP Level 1-4 ဖြစ်ရမည်" });

  const user = await dbGetUser(telegram_id);
  if (!user)       return res.status(404).json({ error: "User မတွေ့ပါ" });
  if (user.banned) return res.status(403).json({ error: "အကောင့် ပိတ်ဆို့ထားသည်" });

  if (user.vip_level >= level)
    return res.json({ success: true, already: true, vip_level: user.vip_level, new_balance: user.balance });

  const cost = VIP_PRICES[level];
  if (user.balance < cost)
    return res.status(400).json({ success: false, insufficient: true, required: cost, current_balance: user.balance, shortfall: cost - user.balance, error: `Balance မလုံပါ (လိုအပ်: ${cost.toLocaleString()} ကျပ်)` });

  user.balance  -= cost;
  user.vip_level = level;
  await dbSetUser(user);

  notifyAdmins(`💎 VIP-${level} Purchase!\nUser: ${telegram_id} (@${user.username||user.first_name})\nCost: ${cost.toLocaleString()} ကျပ်\nBalance: ${user.balance.toLocaleString()} ကျပ်`);
  bot.sendMessage(Number(telegram_id), `🎉 VIP-${level} ဝယ်ယူပြီ!\n💳 ${cost.toLocaleString()} ကျပ် နှုတ်ပြီး\nလက်ကျန်: ${user.balance.toLocaleString()} ကျပ်`)
    .catch(err => console.log("Telegram Send Error:", err.message));

  return res.json({ success: true, vip_level: user.vip_level, new_balance: user.balance, cost });
});

// ─── Order Grab v8 ─────────────────────────────────────────────
//  • Balance CHECK only (price မနှုတ်) — Commission ပဲ ထည့်
//  • Race Condition: grabLocks Set ဖြင့် ကာကွယ်
//  • Max 20 history per user (storage optimization)
//  • TTL collection: grab_history auto-delete after 3 days
// ───────────────────────────────────────────────────────────────
app.post("/api/order/grab", async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id လိုအပ်" });

  const uid = Number(telegram_id);

  // ── Race Condition Guard ────────────────────────────────────
  if (grabLocks.has(uid)) {
    return res.status(429).json({ error: "ခေတ္တစောင့်ပါ - Request လုပ်ဆောင်နေသည်", locked: true });
  }
  grabLocks.add(uid);

  try {
    const user = await dbGetUser(uid);
    if (!user)       { grabLocks.delete(uid); return res.status(404).json({ error: "User မတွေ့ပါ" }); }
    if (user.banned) { grabLocks.delete(uid); return res.status(403).json({ error: "အကောင့် ပိတ်ဆို့ထားသည်" }); }
    if (!user.vip_level) { grabLocks.delete(uid); return res.status(403).json({ error: "VIP ဝယ်ယူမှသာ Grab လုပ်နိုင်" }); }

    // ── Daily Limit ─────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    if (user.last_order_date === today) {
      const limit = VIP_LIMITS[user.vip_level] || 10;
      if (user.daily_orders >= limit) {
        grabLocks.delete(uid);
        return res.status(429).json({
          error: `နေ့စဉ် Limit (${limit}) ပြည့်ပြီ`,
          limit_reached: true, limit, vip_level: user.vip_level,
        });
      }
    } else {
      user.daily_orders    = 0;
      user.last_order_date = today;
    }

    // ── Product Selection ───────────────────────────────────
    const products = generateProducts();
    let pool;
    if      (user.vip_level === 1) pool = products.lv1;
    else if (user.vip_level === 2) pool = [...products.lv1, ...products.lv2];
    else if (user.vip_level === 3) pool = [...products.lv1, ...products.lv2, ...products.lv3];
    else                           pool = [...products.lv1, ...products.lv2, ...products.lv3, ...products.lv4];

    const product = pool[Math.floor(Math.random() * pool.length)];

    // ── v8: Balance CHECK only (threshold) — မနှုတ် ─────────
    if (user.balance < product.price) {
      grabLocks.delete(uid);
      return res.status(400).json({
        success: false, insufficient: true,
        required: product.price, current_balance: user.balance,
        shortfall: product.price - user.balance,
        error: "ပစ္စည်းဝယ်ယူရန် လက်ကျန်ငွေ မလုံလောက်ပါ၊ ငွေထပ်ဖြည့်ပါ",
        product_preview: { id: product.id, name: product.name, price: product.price },
      });
    }

    // ── Commission only — balance မနှုတ် ────────────────────
    const commission = product.commission;
    user.balance      += commission;    // Commission ပဲ ထည့်
    user.commission   += commission;
    user.total_grab_count = (user.total_grab_count || 0) + 1;
    user.daily_orders += 1;

    // ── Grab History: max 20 per user (storage optimization) ─
    if (!user.grabHist) user.grabHist = [];
    user.grabHist.unshift({
      pid: product.id,
      pn:  product.name.substring(0, 25),
      cm:  commission,
      ca:  new Date().toISOString().slice(0, 16),
    });
    if (user.grabHist.length > 20) user.grabHist.length = 20;

    await dbSetUser(user);

    // ── Save to TTL collection (auto-delete 3 days) ──────────
    if (db) {
      db.collection("grab_history").insertOne({
        uid, pid: product.id, cm: commission, ca: new Date(),
      }).catch(e => console.log("grab_history:", e.message));
    }

    grabLocks.delete(uid);
    return res.json({
      success: true, product, commission,
      new_balance:  user.balance,
      daily_orders: user.daily_orders,
      total_grabs:  user.total_grab_count,
    });

  } catch (err) {
    grabLocks.delete(uid);
    console.error("Grab error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─── My Invitation ────────────────────────────────
app.get("/api/invitation/:id", async (req, res) => {
  const uid  = Number(req.params.id);
  const user = await dbGetUser(uid);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });

  const allUsers = await dbGetAllUsers();
  const referrals = allUsers.filter(u => u.referral_by === uid);
  const active    = referrals.filter(u => (u.total_deposited || 0) > 0);

  res.json({
    success:        true,
    total_referrals:referrals.length,
    active_referrals:active.length,
    total_earned:   user.referral_earned_total || 0,
  });
});

// ─── Deposit Request ──────────────────────────────
app.post("/api/deposit/request", async (req, res) => {
  const { telegram_id, amount, method, transaction_id, sender_name } = req.body;
  if (!telegram_id || !amount) return res.status(400).json({ error: "ပါမတာ မပြည့်စုံ" });

  const deposit = {
    id:             `dep_${Date.now()}`,
    telegram_id:    Number(telegram_id),
    amount:         Number(amount),
    method:         method         || "KPay",
    transaction_id: transaction_id || "",
    sender_name:    sender_name    || "",
    status:         "pending",
    created_at:     new Date().toISOString(),
  };
  await dbSaveDeposit(deposit);

  notifyAdmins(
    `💳 ငွေဖြည့်တောင်းဆိုမှု\n━━━━━━━━━━━━━━━━━━━\n` +
    `👤 User ID   : ${telegram_id}\n` +
    `💰 ပမာဏ     : ${Number(amount).toLocaleString()} ကျပ်\n` +
    `📱 Method    : ${method || "KPay"}\n` +
    `🔖 Txn ID   : ${transaction_id || "မဖြည့်ဘူး"}\n` +
    `👤 ငွေလွှဲသူ : ${sender_name || "မဖြည့်ဘူး"}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Confirm: /topup ${telegram_id} ${amount}`
  );

  res.json({ success: true, message: "ငွေဖြည့်တောင်းဆိုမှု ပေးပို့ပြီး! Admin မှ ၁-၂ နာရီတွင် ဖြည့်ပေးမည်", deposit_id: deposit.id });
});

// ─── Withdraw Request — v7: principal lock + tiered fee ──
app.post("/api/withdraw/request", async (req, res) => {
  const { telegram_id, amount, method, account } = req.body;
  if (!telegram_id || !amount) return res.status(400).json({ error: "ပါမတာ မပြည့်စုံ" });

  const amt  = Number(amount);
  const user = await dbGetUser(telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });

  // Principal lock: withdrawable = balance - total_deposited
  const totalDeposited   = user.total_deposited || 0;
  const withdrawableProfit = Math.max(0, user.balance - totalDeposited);

  if (withdrawableProfit < MIN_WITHDRAW_PROFIT)
    return res.status(400).json({
      error: `အမြတ် ${MIN_WITHDRAW_PROFIT.toLocaleString()} ကျပ် မပြည့်သေး (လက်ကျန်အမြတ်: ${withdrawableProfit.toLocaleString()} ကျပ်)`,
    });

  if (amt > withdrawableProfit)
    return res.status(400).json({
      error: `ထုတ်နိုင်သည့် အမြတ်ငွေ: ${withdrawableProfit.toLocaleString()} ကျပ်သာ (အရင်းကို ထုတ်ခွင့်မပြုပါ)`,
    });

  // Tiered fee
  const feeRate  = getWithdrawFee(user.vip_level);
  const feeAmt   = Math.round(amt * feeRate);
  const netAmt   = amt - feeAmt;
  const priority = user.vip_level >= 3;

  const w = {
    id:          `wth_${Date.now()}`,
    telegram_id: Number(telegram_id),
    amount:      amt,
    fee:         feeAmt,
    net_amount:  netAmt,
    method:      method  || "KPay",
    account:     account || "",
    status:      priority ? "Pending (Priority Processing)" : "Pending",
    created_at:  new Date().toISOString(),
  };
  await dbSaveWithdraw(w);

  notifyAdmins(
    `💸 ငွေထုတ်တောင်းဆိုမှု\n` +
    `User: ${telegram_id} | VIP-${user.vip_level}\n` +
    `ပမာဏ: ${amt.toLocaleString()} ကျပ်\n` +
    `ဝန်ဆောင်ခ (${Math.round(feeRate*100)}%): ${feeAmt.toLocaleString()} ကျပ်\n` +
    `ထုတ်ပေးရမည်: ${netAmt.toLocaleString()} ကျပ်\n` +
    `${priority ? "⚡ PRIORITY" : ""}\n` +
    `Approve: /withdraw_approve ${telegram_id} ${amt}`
  );

  res.json({
    success:    true,
    fee:        feeAmt,
    net_amount: netAmt,
    fee_rate:   Math.round(feeRate * 100),
    status:     w.status,
    message:    `ငွေထုတ်တောင်းဆိုမှု ပေးပို့ပြီး! ဝန်ဆောင်ခ ${Math.round(feeRate*100)}% (${feeAmt.toLocaleString()} ကျပ်)`,
  });
});

// ─── Lucky Spin ───────────────────────────────────
app.post("/api/spin", async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id လိုအပ်" });

  const user = await dbGetUser(telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });

  const today = new Date().toISOString().slice(0, 10);
  if (user.last_spin_date === today)
    return res.status(429).json({ error: "နောက်ထပ် လှည့်ရန် ၂၄ နာရီ စောင့်ပါ", already_spun: true });

  const reward = SPIN_REWARDS[Math.floor(Math.random() * SPIN_REWARDS.length)];
  user.balance       += reward;
  user.commission    += reward;
  user.last_spin_date = today;
  await dbSetUser(user);

  res.json({ success: true, reward, new_balance: user.balance, message: `🎉 ${reward.toLocaleString()} ကျပ် ရရှိပြီ!` });
});

// ─── Admin REST ───────────────────────────────────
app.post("/api/admin/topup", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const user = await dbGetUser(req.body.telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  const amt = Number(req.body.amount);
  user.balance += amt; user.total_deposited = (user.total_deposited||0) + amt;
  await dbSetUser(user);
  if (user.referral_by) {
    const bonus = calcReferralBonus(amt);
    if (bonus > 0) {
      const refUser = await dbGetUser(user.referral_by);
      if (refUser) { refUser.balance += bonus; refUser.commission += bonus; refUser.referral_earned_total = (refUser.referral_earned_total||0)+bonus; await dbSetUser(refUser); }
    }
  }
  res.json({ success: true, new_balance: user.balance });
});

app.post("/api/admin/setvip", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const user = await dbGetUser(req.body.telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.vip_level = Number(req.body.vip_level); await dbSetUser(user);
  res.json({ success: true, vip_level: user.vip_level });
});

app.post("/api/admin/ban", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const user = await dbGetUser(req.body.telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.banned = true; await dbSetUser(user); res.json({ success: true });
});

app.post("/api/admin/unban", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const user = await dbGetUser(req.body.telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.banned = false; await dbSetUser(user); res.json({ success: true });
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
    console.log(`📢 Channel  → ${CHANNEL_ID}`);
    console.log(`💎 VIP Prices: 1=${VIP_PRICES[1]}, 2=${VIP_PRICES[2]}, 3=${VIP_PRICES[3]}, 4=${VIP_PRICES[4]}`);
    console.log(`📦 Products: P1-P30 (VIP1-4)`);
  });
});

// ================================================
//   Fix 4: Global Error Handlers
// ================================================
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
