import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { MongoClient, ObjectId } from 'mongodb';
import path from 'path';

// --- Environment variables ---
const BOT_TOKEN = process.env.CLIENT_BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// --- Bot init ---
const bot = new Telegraf(BOT_TOKEN);

// --- Session object ---
const sessions = {};
bot.use((ctx, next) => {
  if (!sessions[ctx.chat.id]) sessions[ctx.chat.id] = {};
  ctx.session = sessions[ctx.chat.id];
  return next();
});

// --- MongoDB connection ---
let db;
async function connectDB() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db();
  console.log("MongoDB ga ulandi ✅");
  return db;
}

// --- Helper functions ---
async function addClient(chatId, name, phone) {
  const database = await connectDB();
  const clients = database.collection('clients');
  const existing = await clients.findOne({ chatId });
  if (existing) return existing;
  const result = await clients.insertOne({ chatId, name, phone, date: new Date() });
  return result;
}

async function getProductsByCategory(category) {
  const database = await connectDB();
  const products = database.collection('botProducts');
  return await products.find({ category }).toArray();
}

async function getProductById(productId) {
  const database = await connectDB();
  const products = database.collection('botProducts');
  return await products.findOne({ _id: new ObjectId(productId) });
}

// --- Keyboards ---
const categoriesKeyboard = [
  [Markup.button.callback('Ichimliklar', 'category_ichimliklar')],
  [Markup.button.callback('Fastfood', 'category_fastfood')],
  [Markup.button.callback('Shirinliklar', 'category_shirinlik')],
  [Markup.button.callback('Milliy taomlar', 'category_milliy')]
];

const cartKeyboard = [
  [Markup.button.callback('Naqd', 'pay_cash')],
  [Markup.button.callback('Karta', 'pay_card')]
];

// --- /start command ---
bot.start(async (ctx) => {
  ctx.reply("Salom! Ismingizni kiriting:");
  ctx.session.step = 'get_name';

  ctx.session.handleMessage = async (msgCtx) => {
    if (ctx.session.step === 'get_name') {
      ctx.session.name = msgCtx.text;
      ctx.reply("Telefon raqamingizni kiriting (format: +998901234567):");
      ctx.session.step = 'get_phone';
    } else if (ctx.session.step === 'get_phone') {
      const phone = msgCtx.text;
      await addClient(ctx.chat.id, ctx.session.name, phone);
      ctx.reply("Ro‘yxatdan muvaffaqiyatli o‘tdingiz ✅", Markup.inlineKeyboard(categoriesKeyboard));
      ctx.session.step = null;
      ctx.session.handleMessage = null;
    }
  };
});

// --- Text messages ---
bot.on('text', async (ctx) => {
  if (ctx.session.handleMessage) return ctx.session.handleMessage(ctx);

  // Karta to‘lovni qabul qilish
  if (ctx.session.step === 'pay_card') {
    const cardInfo = ctx.message.text;
    const cart = ctx.session.cart;
    if (!cart || !cart.length) return ctx.reply("Savat bo‘sh ❌");

    // Adminga yuborish
    let orderMessage = `Yangi buyurtma (Karta to‘lov):\n\n`;
    let total = 0;
    cart.forEach((item, i) => {
      orderMessage += `${i+1}. ${item.name} - ${item.price} so'm\n`;
      total += Number(item.price);
    });
    orderMessage += `\nJami: ${total} so'm\nFoydalanuvchi: ${ctx.chat.first_name}, ChatID: ${ctx.chat.id}\nKartaga biriktirilgan: ${cardInfo}`;

    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, orderMessage);
    ctx.reply("Buyurtmangiz yuborildi ✅");
    ctx.session.cart = [];
    ctx.session.step = null;
  }
});

// --- /cart command ---
bot.command('cart', async (ctx) => {
  const cart = ctx.session.cart;
  if (!cart || !cart.length) return ctx.reply("Savat bo‘sh 🛒");

  let message = "Sizning savatingiz:\n\n";
  let total = 0;
  cart.forEach((item, index) => {
    message += `${index + 1}. ${item.name} - ${item.price} so'm\n`;
    total += Number(item.price);
  });
  message += `\nJami: ${total} so'm`;

  ctx.reply(message, Markup.inlineKeyboard(cartKeyboard));
});

// --- Callback query handler ---
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  // --- Kategoriya ---
  if (data.startsWith('category_')) {
    const category = data.replace('category_', '');
    const products = await getProductsByCategory(category);

    if (!products.length) {
      return ctx.reply("Bu kategoriyada mahsulot topilmadi ❌");
    }

    for (const product of products) {
      const image = product.stock > 0 ? product.img : product.img_gray;
      const caption = `${product.name}\nNarxi: ${product.price} so'm\nStock: ${product.stock}`;
      const buttons = product.stock > 0
        ? Markup.inlineKeyboard([[Markup.button.callback('Savatga qo‘shish', `add_${product._id}`)]])
        : null;

      await ctx.replyWithPhoto({ source: path.join('./data/images', image) }, { caption, ...buttons });
    }
  }

  // --- Savatga qo‘shish ---
  else if (data.startsWith('add_')) {
    const productId = data.replace('add_', '');
    const product = await getProductById(productId);
    if (!product || product.stock <= 0) {
      return ctx.answerCbQuery('Mahsulot mavjud emas ❌', { show_alert: true });
    }

    if (!ctx.session.cart) ctx.session.cart = [];
    ctx.session.cart.push({ name: product.name, price: product.price, productId });

    ctx.answerCbQuery(`${product.name} savatga qo‘shildi ✅`);
  }

  // --- Naqd to‘lov ---
  else if (data === 'pay_cash') {
    const cart = ctx.session.cart;
    if (!cart || !cart.length) return ctx.answerCbQuery('Savat bo‘sh ❌');

    let orderMessage = `Yangi buyurtma (Naqd to‘lov):\n\n`;
    let total = 0;
    cart.forEach((item, i) => {
      orderMessage += `${i+1}. ${item.name} - ${item.price} so'm\n`;
      total += Number(item.price);
    });
    orderMessage += `\nJami: ${total} so'm\nFoydalanuvchi: ${ctx.chat.first_name}, ChatID: ${ctx.chat.id}`;

    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, orderMessage);
    ctx.reply("Buyurtmangiz yuborildi ✅");
    ctx.session.cart = [];
  }

  // --- Karta to‘lovni boshlash ---
  else if (data === 'pay_card') {
    ctx.reply("Iltimos, to‘lov kartangizni kiriting va chekni biriktiring 📎");
    ctx.session.step = 'pay_card';
  }
});

// --- Launch bot ---
bot.launch().then(() => console.log("Client bot ishlayapti ✅"));
