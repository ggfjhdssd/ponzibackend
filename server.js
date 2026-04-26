require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;

// ✅ Real URLs ထည့်ထားပြီ
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://ponzifrontend.vercel.app';
const WEBHOOK_URL  = process.env.WEBHOOK_URL  || 'https://ponzibackend.onrender.com';

// ═══════════════════════════════════════════
//  Middleware
// ═══════════════════════════════════════════
app.use(express.json());
app.use(cors({
  origin: ['https://ponzifrontend.vercel.app', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

// ═══════════════════════════════════════════
//  Telegram Bot (Webhook Mode)
// ═══════════════════════════════════════════
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });
const webhookPath = `/webhook/${BOT_TOKEN}`;

bot.setWebHook(`${WEBHOOK_URL}${webhookPath}`)
  .then(() => console.log(`✅ Webhook set: ${WEBHOOK_URL}${webhookPath}`))
  .catch(err => console.error('❌ Webhook error:', err.message));

// Telegram က update ပို့လာတဲ့ endpoint
app.post(webhookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ═══════════════════════════════════════════
//  Bot Commands
// ═══════════════════════════════════════════

// /start command
bot.onText(/\/start/, async (msg) => {
  const chatId    = msg.chat.id;
  const firstName = msg.from.first_name || 'User';
  const username  = msg.from.username ? `@${msg.from.username}` : '';

  const text =
    `👋 မင်္ဂလာပါ ${firstName}! ${username}\n\n` +
    `🚀 ကျွန်တော်တို့ရဲ့ Mini App ထဲသို့ ကြိုဆိုပါတယ်။\n\n` +
    `အောက်ပါ button ကို နှိပ်ပြီး Website ထဲ ဝင်ရောက်နိုင်ပါတယ်။`;

  try {
    await bot.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🌐 Website သို့ ဝင်ရန်',
              web_app: { url: 'https://ponzifrontend.vercel.app' }
            }
          ],
          [
            {
              text: '💬 Support',
              url: 'https://t.me/your_support_username' // ← သင့် support ထည့်ပါ
            }
          ]
        ]
      }
    });
  } catch (err) {
    console.error('sendMessage error:', err.message);
  }
});

// /help command
bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `📋 အကူအညီ\n\n` +
    `/start - Bot စတင်ရန်\n` +
    `/help  - အကူအညီ ကြည့်ရန်\n\n` +
    `Website: https://ponzifrontend.vercel.app`
  );
});

// ═══════════════════════════════════════════
//  REST API Endpoints
// ═══════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Ponzi Backend is running 🚀', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────
//  Telegram initData Validation
// ─────────────────────────────────────────
app.post('/api/validate', (req, res) => {
  const { initData } = req.body;

  if (!initData) {
    return res.status(400).json({ valid: false, error: 'initData မပါဘူး' });
  }

  try {
    const isValid = validateTelegramInitData(initData, BOT_TOKEN);

    if (!isValid) {
      return res.status(401).json({ valid: false, error: 'Unauthorized - initData မမှန်ပါ' });
    }

    const params  = new URLSearchParams(initData);
    const userStr = params.get('user');
    const user    = userStr ? JSON.parse(userStr) : null;

    return res.json({
      valid: true,
      user: {
        id:            user?.id,
        first_name:    user?.first_name,
        last_name:     user?.last_name,
        username:      user?.username,
        language_code: user?.language_code,
        is_premium:    user?.is_premium || false
      },
      auth_date: params.get('auth_date')
    });

  } catch (err) {
    console.error('Validation error:', err);
    return res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// ─────────────────────────────────────────
//  User save API (Optional - DB ချိတ်မယ်ဆိုသုံးပါ)
// ─────────────────────────────────────────
app.post('/api/user/save', (req, res) => {
  const { initData, extraData } = req.body;

  if (!validateTelegramInitData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ဒီနေရာ MongoDB / PostgreSQL / Firebase etc. ထည့်နိုင်
  console.log('User saved:', extraData);
  res.json({ success: true, message: 'Saved successfully' });
});

// ═══════════════════════════════════════════
//  HMAC-SHA256 Validation (Telegram Official)
// ═══════════════════════════════════════════
function validateTelegramInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    if (!hash) return false;

    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    return calculatedHash === hash;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════
//  Start Server
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Frontend : https://ponzifrontend.vercel.app`);
  console.log(`📡 Backend  : https://ponzibackend.onrender.com`);
});
