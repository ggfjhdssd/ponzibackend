// ================================================
//   Wealth Flow Myanmar - Backend v5
//   File   : server.js
//   Deploy : Render.com
//   v5 ထည့်သွင်းမှုများ:
//     • Order Grab ကို Balance ဖြင့် စစ်ဆေးခြင်း
//       (VIP ရုံနှင့် မလုံ - ပစ္စည်းဈေးနှုန်း ရှိမှသာ Grab ရ)
//     • ပစ္စည်းအမည်များ (Myanmar names)
//     • Referral Bonus tier: 5k→1k, 20k→4k
//     • Withdrawal အနည်းဆုံး 20,000 MMK
//     • /setvip admin bot command (ရှိပြီးသား + improve)
//     • /stats, /topup, /ban, /unban commands
// ================================================

require("dotenv").config();

const express     = require("express");
const cors        = require("cors");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

// ================================================
//   ENVIRONMENT VARIABLES
//   Render Dashboard → Environment မှ သတ်မှတ်ပါ
// ================================================
const BOT_TOKEN    = process.env.BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL  || "https://ponzifrontend.vercel.app/";
const ADMIN_KEY    = process.env.ADMIN_KEY      || "changeme";
const ADMIN_IDS    = (process.env.ADMIN_IDS || "").split(",").map(Number).filter(Boolean);
const PORT         = process.env.PORT           || 3000;
const MONGO_URI    = process.env.MONGO_URI      || null;

if (!BOT_TOKEN) {
  console.error("❌  BOT_TOKEN မသတ်မှတ်ရသေး! Render Environment Variables ထဲ ထည့်ပါ။");
  process.exit(1);
}

// ================================================
//   MONGODB ADAPTER
//   Production: MONGO_URI env var သတ်မှတ်ပါ
//   Development: In-Memory Map ကို အစားထိုးသုံးသည်
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
    } catch (err) {
      console.warn("⚠️  MongoDB မချိတ်နိုင်ပါ, In-Memory သုံးမည်:", err.message);
      db = null;
    }
  } else {
    console.log("ℹ️  MONGO_URI မရှိ, In-Memory Map သုံးနေသည်");
  }
}

// ─── In-Memory fallback ───────────────────────────
const usersMap    = new Map();
const depositsMap = new Map();
const withdrawMap = new Map();

// ─── DB Adapter Functions ─────────────────────────
async function dbGetUser(telegram_id) {
  const uid = Number(telegram_id);
  if (db) return await db.collection("users").findOne({ telegram_id: uid });
  return usersMap.get(uid) || null;
}

async function dbSetUser(user) {
  const uid = Number(user.telegram_id);
  if (db) {
    await db.collection("users").updateOne(
      { telegram_id: uid },
      { $set: user },
      { upsert: true }
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
//   PRODUCT DATA  (Myanmar names ပါဝင်)
// ================================================

// ပစ္စည်းအမည်များ မြန်မာဘာသာ
const PRODUCT_NAMES = {
  p1:  "သွားတိုက်တံ (Toothbrush)",
  p2:  "သွားတိုက်ဆေး (Toothpaste)",
  p3:  "ဖိနပ် (Shoes)",
  p4:  "ရေချိုးခန်းအခင်း (Bath Mat)",
  p5:  "မြက်အခင်း (Grass Mat)",
  p6:  "အိပ်ရာခင်း (Bed Sheet)",
  p7:  "မျက်နှာသုတ်ပဝါ (Face Towel)",
  p8:  "ဆပ်ပြာ (Soap)",
  p9:  "ရေနံဆီ (Hair Oil)",
  p10: "ဆံပင်သုတ်ပဝါ (Hair Towel)",
  p11: "ပန်းကန် (Plate)",
  p12: "ဇွန်း (Spoon)",
  p13: "ဖန်ခွက် (Glass)",
  p14: "ဆန်ခြင်းတောင်း (Rice Basket)",
  p15: "ထမင်းအိုး (Rice Pot)",
};

function generateProducts() {
  const lv1 = [];
  for (let i = 1; i <= 5; i++) {
    const price = Math.floor(Math.random() * (4500 - 2000 + 1) + 2000);
    lv1.push({
      id:         `p${i}`,
      name:       PRODUCT_NAMES[`p${i}`] || `Product ${i}`,
      image:      `/images/p${i}.png`,
      price,
      level:      1,
      commission: Math.round(price * 0.1),
    });
  }
  const lv2 = [];
  for (let i = 6; i <= 15; i++) {
    const price = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    lv2.push({
      id:         `p${i}`,
      name:       PRODUCT_NAMES[`p${i}`] || `Product ${i}`,
      image:      `/images/p${i}.png`,
      price,
      level:      2,
      commission: Math.round(price * 0.1),
    });
  }
  return { lv1, lv2 };
}

// ================================================
//   VIP PRICE TABLE
// ================================================
const VIP_PRICES = {
  1: 5000,
  2: 20000,
};

// ================================================
//   WITHDRAWAL MINIMUM
// ================================================
const WITHDRAW_MIN = 20000;   // ၂၀,၀၀၀ ကျပ် အနည်းဆုံး

// ================================================
//   REFERRAL BONUS TIERS
//   Referrer ရရှိမည့် Bonus (Deposit ပမာဏ အပေါ်မူတည်)
// ================================================
function calcReferralBonus(depositAmount) {
  if (depositAmount >= 20000) return 4000;   // 20k ဖြည့်ရင် 4k ရ
  if (depositAmount >= 5000)  return 1000;   // 5k ဖြည့်ရင် 1k ရ
  return 0;
}

// ================================================
//   MIDDLEWARE
// ================================================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
}));
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ================================================
//   TELEGRAM BOT
// ================================================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖  Wealth Flow Myanmar Bot စတင်နေပြီ...");

function notifyAdmins(text) {
  ADMIN_IDS.forEach(id => bot.sendMessage(id, text).catch(() => {}));
}

// ─── /start ──────────────────────────────────────
bot.onText(/\/start(?:\s+ref_(\d+))?/, async (msg, match) => {
  const chatId    = msg.chat.id;
  const uid       = msg.from.id;
  const firstName = msg.from?.first_name || "မိတ်ဆွေ";
  const refId     = match[1] ? Number(match[1]) : null;

  let user = await dbGetUser(uid);
  if (!user) {
    user = {
      telegram_id:     uid,
      username:        msg.from.username   || "",
      first_name:      msg.from.first_name || "",
      last_name:       msg.from.last_name  || "",
      balance:         0,
      commission:      0,
      vip_level:       0,
      daily_orders:    0,
      last_order_date: "",
      referral_by:     refId,
      total_deposited: 0,
      banned:          false,
      joined_at:       new Date().toISOString(),
      last_seen:       new Date().toISOString(),
    };
    await dbSetUser(user);

    // Referral bonus တွက်ချက်ခြင်း - Registration တွင် ဆောင်ရွက်မည်
    // (Actual bonus ကို Topup approval တွင် ဆောင်ရွက်မည်)
    if (refId && refId !== uid) {
      notifyAdmins(`👤 New user ${uid} joined via ref of ${refId}`);
    }
  } else {
    user.last_seen = new Date().toISOString();
    await dbSetUser(user);
  }

  bot.sendMessage(chatId,
    `👋 မင်္ဂလာပါ, ${firstName}!\n\n` +
    `💎 Wealth Flow Myanmar မှ ကြိုဆိုပါသည်\n\n` +
    `✅ Order Grab → Commission ရရှိနိုင်\n` +
    `💰 ငွေများ လွယ်ကူစွာ ထုတ်ယူနိုင်\n` +
    `👥 မိတ်ဆွေများ ဖိတ်ကာ Bonus ရနိုင်\n\n` +
    `👇 App ဝင်ရောက်ရန် ခလုတ်နှိပ်ပါ!`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "🌐 App ဖွင့်ရန်", web_app: { url: FRONTEND_URL } },
        ]],
      },
    }
  );
});

// ─── /balance ────────────────────────────────────
bot.onText(/\/balance/, async (msg) => {
  const user = await dbGetUser(msg.from.id);
  if (user) {
    bot.sendMessage(msg.chat.id,
      `💰 လက်ကျန်ငွေ: ${user.balance.toLocaleString()} ကျပ်\n` +
      `📈 Commission: ${user.commission.toLocaleString()} ကျပ်\n` +
      `💎 VIP Level: ${user.vip_level || 0}`
    );
  } else {
    bot.sendMessage(msg.chat.id, "❌ /start နှိပ်ပြီး အရင် မှတ်ပုံတင်ပါ။");
  }
});

// ─── Admin: /topup <user_id> <amount> ────────────
bot.onText(/\/topup (\d+) (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const uid    = Number(match[1]);
  const amount = Number(match[2]);
  const user   = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ");

  user.balance         += amount;
  user.total_deposited  = (user.total_deposited || 0) + amount;
  await dbSetUser(user);

  // ── Referral Bonus: ဖိတ်ကြားသူကို Bonus ပေးမည် ──
  if (user.referral_by && user.referral_by !== uid) {
    const bonus = calcReferralBonus(amount);
    if (bonus > 0) {
      const refUser = await dbGetUser(user.referral_by);
      if (refUser) {
        refUser.balance    += bonus;
        refUser.commission += bonus;
        await dbSetUser(refUser);
        bot.sendMessage(user.referral_by,
          `🎉 မိတ်ဆွေ Referral Bonus!\n` +
          `User ${uid} က ${amount.toLocaleString()} ကျပ် ဖြည့်လို့\n` +
          `သင် ${bonus.toLocaleString()} ကျပ် Bonus ရပြီ! 💰`
        ).catch(() => {});
      }
    }
  }

  bot.sendMessage(msg.chat.id,
    `✅ ID ${uid} ထံ ${amount.toLocaleString()} ကျပ် ဖြည့်ပြီး\nလက်ကျန်: ${user.balance.toLocaleString()} ကျပ်`
  );
  bot.sendMessage(uid,
    `💰 သင့်အကောင့်သို့ ${amount.toLocaleString()} ကျပ် ဝင်ရောက်ပြီ!`
  ).catch(() => {});
});

// ─── Admin: /setvip <user_id> <0|1|2> ───────────
//     Admin က User ကို တိုက်ရိုက် VIP Level ပေးနိုင်
//     Example: /setvip 123456789 1
bot.onText(/\/setvip (\d+) (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "❌ Admin သာ သုံးနိုင်သည်");
  }

  const uid      = Number(match[1]);
  const vipLevel = Number(match[2]);

  if (vipLevel < 0 || vipLevel > 2) {
    return bot.sendMessage(msg.chat.id, "❌ VIP Level သည် 0, 1 သို့မဟုတ် 2 သာ ဖြစ်နိုင်သည်");
  }

  const user = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ");

  const oldLevel = user.vip_level || 0;
  user.vip_level = vipLevel;
  await dbSetUser(user);

  bot.sendMessage(msg.chat.id,
    `✅ ID ${uid} (@${user.username || user.first_name})\n` +
    `VIP ${oldLevel} → ${vipLevel} သတ်မှတ်ပြီး!\n` +
    `အဆင့်: ${vipLevel === 0 ? "VIP မရှိ" : `VIP-${vipLevel}`}`
  );

  if (vipLevel > 0) {
    bot.sendMessage(uid,
      `🎉 VIP-${vipLevel} အဆင့် ရရှိပြီ!\n` +
      `✅ Order Grab လုပ်ကာ Commission ရယူနိုင်ပါပြီ\n` +
      `🛍️ App ဖွင့်ပြီး Cart Tab သို့ သွားပါ!`
    ).catch(() => {});
  }
});

// ─── Admin: /ban <user_id> ────────────────────────
bot.onText(/\/ban (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const uid  = Number(match[1]);
  const user = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ");
  user.banned = true;
  await dbSetUser(user);
  bot.sendMessage(msg.chat.id, `🚫 ID ${uid} ကို ပိတ်ဆို့ပြီး`);
});

// ─── Admin: /unban <user_id> ──────────────────────
bot.onText(/\/unban (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const uid  = Number(match[1]);
  const user = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ");
  user.banned = false;
  await dbSetUser(user);
  bot.sendMessage(msg.chat.id, `✅ ID ${uid} ကို ပြန်ဖွင့်ပြီး`);
});

// ─── Admin: /withdraw_approve <user_id> <amount> ──
bot.onText(/\/withdraw_approve (\d+) (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const uid    = Number(match[1]);
  const amount = Number(match[2]);
  const user   = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ");
  if (user.balance < amount) return bot.sendMessage(msg.chat.id, "❌ လက်ကျန် မလုံလောက်ပါ");
  user.balance -= amount;
  await dbSetUser(user);
  bot.sendMessage(msg.chat.id, `✅ ID ${uid} ထံ ${amount.toLocaleString()} ကျပ် ထုတ်ပေးပြီး`);
  bot.sendMessage(uid, `✅ ငွေထုတ်မှု ${amount.toLocaleString()} ကျပ် အတည်ပြုပြီး! မကြာမီ ရောက်ပါမည်`).catch(() => {});
});

// ─── Admin: /stats ────────────────────────────────
bot.onText(/\/stats/, async (msg) => {
  if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "❌ Admin သာ သုံးနိုင်သည်");
  }
  const users    = await dbGetAllUsers();
  const totalBal = users.reduce((s, u) => s + (u.balance || 0), 0);
  const vip1     = users.filter(u => u.vip_level === 1).length;
  const vip2     = users.filter(u => u.vip_level === 2).length;
  bot.sendMessage(msg.chat.id,
    `📊 Wealth Flow Stats\n\n` +
    `👤 Users: ${users.length}\n` +
    `💎 VIP-1: ${vip1} ယောက်\n` +
    `👑 VIP-2: ${vip2} ယောက်\n` +
    `💰 Total Balance: ${totalBal.toLocaleString()} ကျပ်\n` +
    `🕐 Time: ${new Date().toISOString()}\n\n` +
    `📝 Admin Commands:\n` +
    `/topup <id> <amount>    → Balance ဖြည့်\n` +
    `/setvip <id> <0|1|2>   → VIP Level သတ်မှတ်\n` +
    `/ban <id>               → Account ပိတ်\n` +
    `/unban <id>             → Account ဖွင့်\n` +
    `/withdraw_approve <id> <amount>`
  );
});

bot.on("polling_error", (err) => console.error("Polling error:", err.message));

// ================================================
//   REST API ROUTES
// ================================================

// Health Check
app.get("/", async (_req, res) => {
  const users = await dbGetAllUsers();
  res.json({
    status:    "✅ Wealth Flow Myanmar Backend v5",
    users:     users.length,
    timestamp: new Date().toISOString(),
  });
});

// ─── GET /api/products ────────────────────────────
app.get("/api/products", (_req, res) => {
  res.json({ success: true, products: generateProducts() });
});

// ─── POST /api/user/register ──────────────────────
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
    await dbSetUser(user);
    return res.json({ success: true, message: "updated", user });
  }

  const refId   = ref ? Number(ref) : null;
  const newUser = {
    telegram_id:     uid,
    username:        username   || "",
    first_name:      first_name || "",
    last_name:       last_name  || "",
    balance:         0,
    commission:      0,
    vip_level:       0,
    daily_orders:    0,
    last_order_date: "",
    referral_by:     refId,
    total_deposited: 0,
    banned:          false,
    joined_at:       new Date().toISOString(),
    last_seen:       new Date().toISOString(),
  };
  await dbSetUser(newUser);

  console.log(`✅ New user via Mini App: ${uid} (@${username}) ref:${refId}`);
  return res.json({ success: true, message: "registered", user: newUser });
});

// ─── GET /api/user/:id ────────────────────────────
app.get("/api/user/:id", async (req, res) => {
  const user = await dbGetUser(req.params.id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  res.json({ success: true, user });
});

// ─── POST /api/buy-vip ────────────────────────────
//   Body: { telegram_id, vip_level }
//   Logic: Balance ထဲမှ ဈေးနှုန်း နှုတ်ပြီး VIP Level တိုး
app.post("/api/buy-vip", async (req, res) => {
  const { telegram_id, vip_level } = req.body;

  if (!telegram_id || !vip_level)
    return res.status(400).json({ error: "telegram_id နှင့် vip_level လိုအပ်သည်" });

  const level = Number(vip_level);
  if (level !== 1 && level !== 2)
    return res.status(400).json({ error: "VIP Level သည် 1 သို့မဟုတ် 2 ဖြစ်ရမည်" });

  const user = await dbGetUser(telegram_id);
  if (!user)       return res.status(404).json({ error: "User မတွေ့ပါ" });
  if (user.banned) return res.status(403).json({ error: "သင့်အကောင့် ပိတ်ဆို့ထားသည်" });

  if (user.vip_level >= level) {
    return res.json({
      success:     true,
      already:     true,
      vip_level:   user.vip_level,
      new_balance: user.balance,
      message:     `VIP-${level} ပိုင်ဆိုင်ပြီး ဖြစ်သည်`,
    });
  }

  const cost = VIP_PRICES[level];

  // Balance စစ်ဆေးခြင်း
  if (user.balance < cost) {
    return res.status(400).json({
      success:         false,
      insufficient:    true,
      required:        cost,
      current_balance: user.balance,
      shortfall:       cost - user.balance,
      error:           `လက်ကျန်ငွေ မလုံလောက်ပါ (လိုအပ်: ${cost.toLocaleString()} ကျပ်, လက်ကျန်: ${user.balance.toLocaleString()} ကျပ်)`,
    });
  }

  // Balance နှုတ်ပြီး VIP Level တိုးပေးခြင်း
  user.balance  -= cost;
  user.vip_level = level;
  await dbSetUser(user);

  notifyAdmins(
    `💎 VIP Purchase!\nUser: ${telegram_id} (@${user.username || user.first_name})\n` +
    `Level: VIP-${level}\nCost: ${cost.toLocaleString()} ကျပ်\n` +
    `Remaining: ${user.balance.toLocaleString()} ကျပ်`
  );

  bot.sendMessage(Number(telegram_id),
    `🎉 VIP-${level} ဝယ်ယူမှု အောင်မြင်ပြီ!\n` +
    `💰 ကျသင့်ငွေ: ${cost.toLocaleString()} ကျပ်\n` +
    `💳 လက်ကျန်: ${user.balance.toLocaleString()} ကျပ်\n` +
    `✅ Order Grab လုပ်နိုင်ပြီ!`
  ).catch(() => {});

  return res.json({
    success:     true,
    vip_level:   user.vip_level,
    new_balance: user.balance,
    cost,
    message:     `VIP-${level} ဝယ်ယူပြီး! Balance မှ ${cost.toLocaleString()} ကျပ် နှုတ်ပြီး`,
  });
});

// ─── POST /api/order/grab ─────────────────────────
//   v5 ထည့်: Balance ထဲမှာ ပစ္စည်းဈေးနှုန်း ရှိမှသာ Grab ရ
//   Commission ရပြီးမှ balance ကို ပိုငွေပေး (ဈေးနှုတ်ပြီး comm ထည့်)
app.post("/api/order/grab", async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id လိုအပ်သည်" });

  const user = await dbGetUser(telegram_id);
  if (!user)       return res.status(404).json({ error: "User မတွေ့ပါ" });
  if (user.banned) return res.status(403).json({ error: "သင့်အကောင့် ပိတ်ဆို့ထားသည်" });

  // VIP စစ်ဆေးခြင်း
  if (!user.vip_level || user.vip_level === 0) {
    return res.status(403).json({ error: "VIP ဝယ်ယူမှသာ Order Grab လုပ်နိုင်သည်" });
  }

  // နေ့စဉ် Limit စစ်ဆေးခြင်း
  const today = new Date().toISOString().slice(0, 10);
  if (user.last_order_date === today) {
    const limit = user.vip_level === 1 ? 10 : 20;
    if (user.daily_orders >= limit) {
      return res.status(429).json({ error: `နေ့စဉ် Order Limit (${limit}) ပြည့်နေပြီ` });
    }
  } else {
    user.daily_orders    = 0;
    user.last_order_date = today;
  }

  // ပစ္စည်း ကျပန်းရွေးခြင်း
  const { lv1, lv2 } = generateProducts();
  const pool    = user.vip_level === 1 ? lv1 : [...lv1, ...lv2];
  const product = pool[Math.floor(Math.random() * pool.length)];

  // ── v5 Balance Logic ──
  // ပစ္စည်းဈေးနှုန်း Balance ထဲ ရှိမှသာ Order Grab ရသည်
  if (user.balance < product.price) {
    return res.status(400).json({
      success:         false,
      insufficient:    true,
      required:        product.price,
      current_balance: user.balance,
      shortfall:       product.price - user.balance,
      error:           `Balance မလုံလောက်ပါ။ ပစ္စည်းဈေးနှုန်း ${product.price.toLocaleString()} ကျပ် လိုအပ်သည်`,
      product_preview: { id: product.id, name: product.name, price: product.price },
    });
  }

  // ပစ္စည်းဈေး နှုတ်ပြီး Commission ထည့်ပေးခြင်း
  // Net change = commission - price (ဈေးပေး၊ comm ရ)
  // တကယ်တမ်း User က ပစ္စည်း "ဝယ်" ပြီး 10% commission ပြန်ရ
  const commission = product.commission;   // price * 10%

  user.balance      -= product.price;      // ဈေးနှုတ်
  user.balance      += commission;         // commission ထည့် (net loss = price * 90%)
  user.commission   += commission;
  user.daily_orders += 1;
  await dbSetUser(user);

  res.json({
    success:      true,
    product,
    commission,
    new_balance:  user.balance,
    daily_orders: user.daily_orders,
    message:      `Order Grab အောင်မြင်! Commission ${commission.toLocaleString()} ကျပ် ရရှိပြီ`,
  });
});

// ─── POST /api/deposit/request ────────────────────
app.post("/api/deposit/request", async (req, res) => {
  const { telegram_id, amount, method, screenshot_url } = req.body;
  if (!telegram_id || !amount)
    return res.status(400).json({ error: "ပါမတာ မပြည့်စုံ" });

  const deposit = {
    id:             `dep_${Date.now()}`,
    telegram_id:    Number(telegram_id),
    amount:         Number(amount),
    method:         method || "KPay",
    screenshot_url: screenshot_url || "",
    status:         "pending",
    created_at:     new Date().toISOString(),
  };
  await dbSaveDeposit(deposit);

  notifyAdmins(
    `💳 ငွေဖြည့်တောင်းဆိုမှု\n` +
    `User: ${telegram_id}\nပမာဏ: ${Number(amount).toLocaleString()} ကျပ်\nMethod: ${method}\n` +
    `Confirm: /topup ${telegram_id} ${amount}`
  );

  res.json({
    success:    true,
    message:    "ငွေဖြည့်တောင်းဆိုမှု ပေးပို့ပြီး! Admin မှ ၁-၂ နာရီအတွင်း ဖြည့်ပေးမည်",
    deposit_id: deposit.id,
  });
});

// ─── POST /api/withdraw/request ──────────────────
//   v5: အနည်းဆုံး 20,000 ကျပ် သတ်မှတ်ပြီ
app.post("/api/withdraw/request", async (req, res) => {
  const { telegram_id, amount, method, account } = req.body;
  if (!telegram_id || !amount)
    return res.status(400).json({ error: "ပါမတာ မပြည့်စုံ" });

  const amt  = Number(amount);
  const user = await dbGetUser(telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });

  // အနည်းဆုံး စစ်ဆေးခြင်း
  if (amt < WITHDRAW_MIN) {
    return res.status(400).json({
      error: `အနည်းဆုံး ${WITHDRAW_MIN.toLocaleString()} ကျပ် မှသာ ထုတ်ယူနိုင်သည်`,
    });
  }

  if (user.balance < amt) {
    return res.status(400).json({ error: "လက်ကျန်ငွေ မလုံလောက်ပါ" });
  }

  const w = {
    id:          `wth_${Date.now()}`,
    telegram_id: Number(telegram_id),
    amount:      amt,
    method:      method  || "KPay",
    account:     account || "",
    status:      "pending",
    created_at:  new Date().toISOString(),
  };
  await dbSaveWithdraw(w);

  notifyAdmins(
    `💸 ငွေထုတ်တောင်းဆိုမှု\n` +
    `User: ${telegram_id}\nပမာဏ: ${amt.toLocaleString()} ကျပ်\nMethod: ${method} / ${account}\n` +
    `Approve: /withdraw_approve ${telegram_id} ${amount}`
  );

  res.json({ success: true, message: "ငွေထုတ်တောင်းဆိုမှု ပေးပို့ပြီး! Admin မှ စစ်ဆေးမည်" });
});

// ─── Admin REST: topup (with referral bonus) ──────
app.post("/api/admin/topup", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY)
    return res.status(403).json({ error: "Forbidden" });

  const { telegram_id, amount } = req.body;
  const user = await dbGetUser(telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });

  const amt = Number(amount);
  user.balance         += amt;
  user.total_deposited  = (user.total_deposited || 0) + amt;
  await dbSetUser(user);

  // Referral bonus
  if (user.referral_by) {
    const bonus = calcReferralBonus(amt);
    if (bonus > 0) {
      const refUser = await dbGetUser(user.referral_by);
      if (refUser) {
        refUser.balance    += bonus;
        refUser.commission += bonus;
        await dbSetUser(refUser);
      }
    }
  }

  res.json({ success: true, new_balance: user.balance });
});

// ─── Admin REST: setvip ───────────────────────────
app.post("/api/admin/setvip", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY)
    return res.status(403).json({ error: "Forbidden" });
  const { telegram_id, vip_level } = req.body;
  const user = await dbGetUser(telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.vip_level = Number(vip_level);
  await dbSetUser(user);
  res.json({ success: true, vip_level: user.vip_level });
});

// ─── Admin REST: ban / unban ──────────────────────
app.post("/api/admin/ban", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY)
    return res.status(403).json({ error: "Forbidden" });
  const user = await dbGetUser(req.body.telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.banned = true;
  await dbSetUser(user);
  res.json({ success: true });
});

app.post("/api/admin/unban", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY)
    return res.status(403).json({ error: "Forbidden" });
  const user = await dbGetUser(req.body.telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.banned = false;
  await dbSetUser(user);
  res.json({ success: true });
});

// ─── Admin REST: list users ───────────────────────
app.get("/api/admin/users", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY)
    return res.status(403).json({ error: "Forbidden" });
  const list = await dbGetAllUsers();
  res.json({ success: true, count: list.length, users: list });
});

// ─── 404 ──────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route မတွေ့ပါ" }));

// ================================================
//   START SERVER
// ================================================
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server → http://localhost:${PORT}`);
    console.log(`📱 Frontend → ${FRONTEND_URL}`);
    console.log(`💎 VIP Prices: VIP1=${VIP_PRICES[1].toLocaleString()}, VIP2=${VIP_PRICES[2].toLocaleString()}`);
    console.log(`💸 Withdraw Minimum: ${WITHDRAW_MIN.toLocaleString()} ကျပ်`);
    console.log(`🎁 Referral Tiers: 5k→1k bonus, 20k→4k bonus`);
  });
});
