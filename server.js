// ================================================
//   Best Buy Mini App - Backend v4 (Upgraded)
//   File   : server.js
//   Deploy : Render.com
//   New    : /setvip bot cmd, /api/buy-vip endpoint,
//            instant VIP purchase from balance,
//            vip_level stored on all users
// ================================================

require("dotenv").config();

const express     = require("express");
const cors        = require("cors");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

// ================================================
//   ENVIRONMENT VARIABLES
//   Set these in Render Dashboard → Environment
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
//   MONGODB ADAPTER (Swap in/out seamlessly)
//   Production: set MONGO_URI env var
//   Development: falls back to in-memory Map
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
  if (db) {
    return await db.collection("users").findOne({ telegram_id: uid });
  }
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
  if (db) {
    return await db.collection("users").find({}).toArray();
  }
  return Array.from(usersMap.values());
}

async function dbSaveDeposit(deposit) {
  if (db) {
    await db.collection("deposits").insertOne(deposit);
  } else {
    depositsMap.set(deposit.id, deposit);
  }
}

async function dbSaveWithdraw(w) {
  if (db) {
    await db.collection("withdrawals").insertOne(w);
  } else {
    withdrawMap.set(w.id, w);
  }
}

// ================================================
//   PRODUCT DATA
// ================================================
function generateProducts() {
  const lv1 = [];
  for (let i = 1; i <= 5; i++) {
    const price = Math.floor(Math.random() * (4500 - 2000 + 1) + 2000);
    lv1.push({
      id:    `p${i}`,
      image: `/public/p${i}.png`,
      price,
      level: 1,
      commission: Math.round(price * 0.1),
    });
  }
  const lv2 = [];
  for (let i = 6; i <= 15; i++) {
    const price = Math.floor(Math.random() * (45000 - 20000 + 1) + 20000);
    lv2.push({
      id:    `p${i}`,
      image: `/public/p${i}.png`,
      price,
      level: 2,
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
  2: 50000,
};

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
console.log("🤖  Telegram Bot စတင်နေပြီ...");

// ─── Helper: notify admin ─────────────────────────
function notifyAdmins(text) {
  ADMIN_IDS.forEach(id => {
    bot.sendMessage(id, text).catch(() => {});
  });
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
      banned:          false,
      joined_at:       new Date().toISOString(),
      last_seen:       new Date().toISOString(),
    };
    await dbSetUser(user);
    console.log(`✅  New user: ${uid} ref by ${refId}`);

    // Referral bonus
    if (refId && refId !== uid) {
      const refUser = await dbGetUser(refId);
      if (refUser) {
        refUser.balance    += 1000;
        refUser.commission += 1000;
        await dbSetUser(refUser);
        bot.sendMessage(refId,
          `🎉 မိတ်ဆွေ တစ်ဦး ဖိတ်ခေါ်မှုအတွက် Bonus ၁,၀၀၀ ကျပ် ရရှိပြီ!`
        ).catch(() => {});
      }
    }
  } else {
    user.last_seen = new Date().toISOString();
    await dbSetUser(user);
  }

  bot.sendMessage(chatId,
    `👋 မင်္ဂလာပါ, ${firstName}!\n\n` +
    `🛍️  Best Buy Mini App မှ ကြိုဆိုပါသည်\n\n` +
    `✅  Commission များ ရရှိနိုင်သည်\n` +
    `💰  ငွေများ လွယ်ကူစွာ ထုတ်ယူနိုင်သည်\n` +
    `👥  မိတ်ဆွေများ ဖိတ်ကာ Bonus ရနိုင်သည်\n\n` +
    `👇  အောက်ပါ ခလုတ်ကို နှိပ်ပြီး App ဝင်ရောက်ပါ!`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "🌐  Website သို့ ဝင်ရန်", web_app: { url: FRONTEND_URL } },
        ]],
      },
    }
  );
});

// ─── /balance ─────────────────────────────────────
bot.onText(/\/balance/, async (msg) => {
  const user = await dbGetUser(msg.from.id);
  if (user) {
    bot.sendMessage(msg.chat.id,
      `💰  လက်ကျန်ငွေ: ${user.balance.toLocaleString()} ကျပ်\n` +
      `📈  Commission: ${user.commission.toLocaleString()} ကျပ်\n` +
      `💎  VIP Level: ${user.vip_level || 0}`
    );
  } else {
    bot.sendMessage(msg.chat.id, "❌  /start နှိပ်ပြီး အရင် မှတ်ပုံတင်ပါ။");
  }
});

// ─── Admin: /topup <user_id> <amount> ─────────────
bot.onText(/\/topup (\d+) (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) return;
  const uid    = Number(match[1]);
  const amount = Number(match[2]);
  const user   = await dbGetUser(uid);
  if (!user) return bot.sendMessage(msg.chat.id, "❌ User မတွေ့ပါ");
  user.balance += amount;
  await dbSetUser(user);
  bot.sendMessage(msg.chat.id,
    `✅ ID ${uid} ထံ ${amount.toLocaleString()} ကျပ် ဖြည့်ပြီး\nလက်ကျန်: ${user.balance.toLocaleString()} ကျပ်`
  );
  bot.sendMessage(uid,
    `💰 သင့်အကောင့်သို့ ${amount.toLocaleString()} ကျပ် ဝင်ရောက်ပြီ!`
  ).catch(() => {});
});

// ─── Admin: /setvip <user_id> <vip_level> ────────
//     Example: /setvip 123456789 2
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

  const oldLevel  = user.vip_level || 0;
  user.vip_level  = vipLevel;
  await dbSetUser(user);

  const levelText = vipLevel === 0 ? "VIP မရှိ" : `VIP-${vipLevel}`;
  bot.sendMessage(msg.chat.id,
    `✅ ID ${uid} (@${user.username || user.first_name})\n` +
    `VIP ${oldLevel} → ${vipLevel} သတ်မှတ်ပြီး!\n` +
    `အဆင့်: ${levelText}`
  );

  // Notify the user
  if (vipLevel > 0) {
    bot.sendMessage(uid,
      `🎉 VIP-${vipLevel} အဆင့် ရရှိပြီ!\n` +
      `✅ Order Grab လုပ်ကာ Commission ရယူနိုင်ပါပြီ။\n` +
      `🛍️ App ဖွင့်ပြီး Cart Tab သို့ သွားပါ!`
    ).catch(() => {});
  } else {
    bot.sendMessage(uid,
      `ℹ️ သင့် VIP အဆင့်ကို ပြောင်းလဲပြီးပါပြီ။`
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
    `📊 Server Stats\n\n` +
    `👤 Users: ${users.length}\n` +
    `💎 VIP-1: ${vip1} ယောက်\n` +
    `👑 VIP-2: ${vip2} ယောက်\n` +
    `💰 Total Balance: ${totalBal.toLocaleString()} ကျပ်\n` +
    `🕐 Time: ${new Date().toISOString()}\n\n` +
    `📝 Admin Commands:\n` +
    `/topup <id> <amount>\n` +
    `/setvip <id> <0|1|2>\n` +
    `/ban <id>  /unban <id>\n` +
    `/withdraw_approve <id> <amount>`
  );
});

bot.on("polling_error", (err) => console.error("Polling error:", err.message));

// ================================================
//   REST API ROUTES
// ================================================

// ─── Health Check ─────────────────────────────────
app.get("/", async (_req, res) => {
  const users = await dbGetAllUsers();
  res.json({
    status:    "✅ Server is running",
    app:       "Best Buy Mini App Backend v4",
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

  const refId  = ref ? Number(ref) : null;
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
    banned:          false,
    joined_at:       new Date().toISOString(),
    last_seen:       new Date().toISOString(),
  };
  await dbSetUser(newUser);

  if (refId && refId !== uid) {
    const refUser = await dbGetUser(refId);
    if (refUser) {
      refUser.balance    += 1000;
      refUser.commission += 1000;
      await dbSetUser(refUser);
      bot.sendMessage(refId, `🎉 Referral Bonus ၁,၀၀၀ ကျပ် ရရှိပြီ!`).catch(() => {});
    }
  }

  console.log(`✅ New user via Mini App: ${uid} (@${username})`);
  return res.json({ success: true, message: "registered", user: newUser });
});

// ─── GET /api/user/:id ────────────────────────────
app.get("/api/user/:id", async (req, res) => {
  const user = await dbGetUser(req.params.id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  res.json({ success: true, user });
});

// ─── POST /api/buy-vip ────────────────────────────
//     Instantly deduct balance and upgrade VIP level.
//     Body: { telegram_id, vip_level }
app.post("/api/buy-vip", async (req, res) => {
  const { telegram_id, vip_level } = req.body;

  if (!telegram_id || !vip_level) {
    return res.status(400).json({ error: "telegram_id နှင့် vip_level လိုအပ်သည်" });
  }

  const level = Number(vip_level);
  if (level !== 1 && level !== 2) {
    return res.status(400).json({ error: "VIP Level သည် 1 သို့မဟုတ် 2 ဖြစ်ရမည်" });
  }

  const user = await dbGetUser(telegram_id);
  if (!user)         return res.status(404).json({ error: "User မတွေ့ပါ" });
  if (user.banned)   return res.status(403).json({ error: "သင့်အကောင့် ပိတ်ဆို့ထားသည်" });

  // Already owns this or higher level
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
  if (!cost) return res.status(400).json({ error: "မမှန်သော VIP Level" });

  // ── (1) Check balance ──────────────────────────
  if (user.balance < cost) {
    return res.status(400).json({
      success:          false,
      insufficient:     true,
      required:         cost,
      current_balance:  user.balance,
      shortfall:        cost - user.balance,
      error:            `လက်ကျန်ငွေ မလုံလောက်ပါ။ ကျေးဇူးပြု၍ ငွေဖြည့်ပါ (လိုအပ်သည်: ${cost.toLocaleString()} ကျပ်، လက်ကျန်: ${user.balance.toLocaleString()} ကျပ်)`,
    });
  }

  // ── (2) Deduct cost ────────────────────────────
  user.balance  -= cost;

  // ── (3) Upgrade VIP level ─────────────────────
  user.vip_level = level;

  await dbSetUser(user);

  // ── (4) Notify admins ──────────────────────────
  notifyAdmins(
    `💎 VIP Purchase!\nUser: ${telegram_id} (@${user.username || user.first_name})\n` +
    `Level: VIP-${level}\nCost: ${cost.toLocaleString()} ကျပ်\n` +
    `Remaining Balance: ${user.balance.toLocaleString()} ကျပ်`
  );

  // Notify user via bot
  bot.sendMessage(Number(telegram_id),
    `🎉 VIP-${level} ဝယ်ယူမှု အောင်မြင်ပြီ!\n` +
    `💰 ကျသင့်ငွေ: ${cost.toLocaleString()} ကျပ်\n` +
    `💳 လက်ကျန်: ${user.balance.toLocaleString()} ကျပ်\n` +
    `✅ Cart Tab မှ Order Grab လုပ်နိုင်ပြီ!`
  ).catch(() => {});

  // ── (5) Return success ─────────────────────────
  return res.json({
    success:     true,
    vip_level:   user.vip_level,
    new_balance: user.balance,
    cost,
    message:     `VIP-${level} အောင်မြင်စွာ ဝယ်ယူပြီ! Balance မှ ${cost.toLocaleString()} ကျပ် နှုတ်ပြီး`,
  });
});

// ─── POST /api/vip/buy (legacy, keep for compat) ──
app.post("/api/vip/buy", async (req, res) => {
  // Redirect to new endpoint logic
  req.url = "/api/buy-vip";
  return app._router.handle(
    Object.assign(req, { url: "/api/buy-vip" }),
    res,
    () => {}
  );
});

// ─── POST /api/order/grab ─────────────────────────
app.post("/api/order/grab", async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id လိုအပ်သည်" });

  const user = await dbGetUser(telegram_id);
  if (!user)       return res.status(404).json({ error: "User မတွေ့ပါ" });
  if (user.banned) return res.status(403).json({ error: "သင့်အကောင့် ပိတ်ဆို့ထားသည်" });

  if (!user.vip_level || user.vip_level === 0) {
    return res.status(403).json({ error: "VIP ဝယ်ယူမှသာ Order Grab လုပ်နိုင်သည်" });
  }

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

  const { lv1, lv2 } = generateProducts();
  const pool    = user.vip_level === 1 ? lv1 : [...lv1, ...lv2];
  const product = pool[Math.floor(Math.random() * pool.length)];

  const commission = Math.round(product.price * 0.1);
  user.balance    += commission;
  user.commission += commission;
  user.daily_orders += 1;
  await dbSetUser(user);

  res.json({
    success:      true,
    product,
    commission,
    new_balance:  user.balance,
    daily_orders: user.daily_orders,
    message:      `အော်ဒါတင်ခြင်း အောင်မြင်ပါသည်! Commission ${commission.toLocaleString()} ကျပ် ရရှိပြီ`,
  });
});

// ─── POST /api/deposit/request ────────────────────
app.post("/api/deposit/request", async (req, res) => {
  const { telegram_id, amount, method, screenshot_url } = req.body;
  if (!telegram_id || !amount) return res.status(400).json({ error: "ပါမတာ မပြည့်စုံ" });

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
    message:    "ငွေဖြည့်တောင်းဆိုမှု ပေးပို့ပြီး! Admin မှ အတည်ပြုပေးပါမည်",
    deposit_id: deposit.id,
  });
});

// ─── POST /api/withdraw/request ──────────────────
app.post("/api/withdraw/request", async (req, res) => {
  const { telegram_id, amount, method, account } = req.body;
  if (!telegram_id || !amount) return res.status(400).json({ error: "ပါမတာ မပြည့်စုံ" });

  const user = await dbGetUser(telegram_id);
  if (!user)                        return res.status(404).json({ error: "User မတွေ့ပါ" });
  if (user.balance < Number(amount)) return res.status(400).json({ error: "လက်ကျန်ငွေ မလုံလောက်ပါ" });

  const w = {
    id:          `wth_${Date.now()}`,
    telegram_id: Number(telegram_id),
    amount:      Number(amount),
    method:      method  || "KPay",
    account:     account || "",
    status:      "pending",
    created_at:  new Date().toISOString(),
  };
  await dbSaveWithdraw(w);

  notifyAdmins(
    `💸 ငွေထုတ်တောင်းဆိုမှု\n` +
    `User: ${telegram_id}\nပမာဏ: ${Number(amount).toLocaleString()} ကျပ်\nMethod: ${method} / ${account}\n` +
    `Approve: /withdraw_approve ${telegram_id} ${amount}`
  );

  res.json({ success: true, message: "ငွေထုတ်တောင်းဆိုမှု ပေးပို့ပြီး! Admin မှ စစ်ဆေးမည်" });
});

// ─── Admin REST: topup ────────────────────────────
app.post("/api/admin/topup", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const { telegram_id, amount } = req.body;
  const user = await dbGetUser(telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.balance += Number(amount);
  await dbSetUser(user);
  res.json({ success: true, new_balance: user.balance });
});

// ─── Admin REST: setvip ───────────────────────────
app.post("/api/admin/setvip", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const { telegram_id, vip_level } = req.body;
  const user = await dbGetUser(telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.vip_level = Number(vip_level);
  await dbSetUser(user);
  res.json({ success: true, vip_level: user.vip_level });
});

// ─── Admin REST: ban / unban ──────────────────────
app.post("/api/admin/ban", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const user = await dbGetUser(req.body.telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.banned = true;
  await dbSetUser(user);
  res.json({ success: true });
});

app.post("/api/admin/unban", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const user = await dbGetUser(req.body.telegram_id);
  if (!user) return res.status(404).json({ error: "User မတွေ့ပါ" });
  user.banned = false;
  await dbSetUser(user);
  res.json({ success: true });
});

// ─── Admin REST: list users ───────────────────────
app.get("/api/admin/users", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
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
    console.log(`🚀  Server → http://localhost:${PORT}`);
    console.log(`📱  Frontend → ${FRONTEND_URL}`);
    console.log(`💎  New: /api/buy-vip endpoint active`);
    console.log(`🤖  New: /setvip bot command active`);
  });
});
