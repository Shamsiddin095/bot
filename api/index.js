import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { MongoClient, ObjectId } from 'mongodb';

// --- Environment ---
const BOT_TOKEN_CLIENT = process.env.BOT_TOKEN_CLIENT;
const BOT_TOKEN_ADMIN = process.env.BOT_TOKEN_ADMIN;
const BOT_TOKEN_DELIVERY = process.env.BOT_TOKEN_DELIVERY;
const MONGO_URI = process.env.MONGO_URI;

// --- MongoDB ---
let db;
async function connectDB() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db();
  return db;
}

// --- Botlar ---
const clientBot = new Telegraf(BOT_TOKEN_CLIENT);
const adminBot = new Telegraf(BOT_TOKEN_ADMIN);
const deliveryBot = new Telegraf(BOT_TOKEN_DELIVERY);

// --- Session ---
const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { cart: [] };
  return sessions[chatId];
}

// ------------------
// 1️⃣ Mijoz bot
// ------------------
clientBot.start(async (ctx) => {
  const session = getSession(ctx.chat.id);
  session.cart = [];
  await ctx.reply("Salom! Bot ishlayapti ✅\nIsmingizni kiriting:");
  session.step = 'get_name';
});

clientBot.on('text', async (ctx) => {
  const session = getSession(ctx.chat.id);

  if (session.step === 'get_name') {
    session.name = ctx.message.text;
    await ctx.reply("Telefon raqamingizni yuboring:", Markup.keyboard([
      [Markup.button.contactRequest('Telefonni yuborish')]
    ]).oneTime().resize());
    session.step = 'get_phone';
  } else if (session.step === 'category') {
    const category = ctx.message.text;
    const db = await connectDB();
    const products = await db.collection('botProducts').find({ category }).toArray();
    if (!products.length) return ctx.reply("Ushbu kategoriyada mahsulot yo'q.");
    session.step = 'product';
    session.currentCategory = category;
    for (const p of products) {
      const available = p.stock > 0;
      await ctx.replyWithPhoto(
        { url: available ? p.image : p.image_hira },
        { caption: `${p.name}\nNarxi: ${p.price} so'm`, reply_markup: Markup.inlineKeyboard([
          available ? Markup.button.callback('Savatga qo\'shish', `add_${p._id}`) : Markup.button.callback('Sotuvda yo\'q', 'none')
        ]) }
      );
    }
  }
});

clientBot.on('contact', async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (session.step === 'get_phone') {
    session.phone = ctx.message.contact.phone_number;
    session.chatId = ctx.chat.id;

    const db = await connectDB();
    await db.collection('botUsers').updateOne(
      { chatId: ctx.chat.id },
      { $set: { name: session.name, phone: session.phone } },
      { upsert: true }
    );

    await ctx.reply(`Ro'yxatdan o'tdingiz!\nAssalomu alaykum, ${session.name}`);
    session.step = 'menu';
    await showCategories(ctx);
  }
});

async function showCategories(ctx) {
  const session = getSession(ctx.chat.id);
  const buttons = [
    ['Ichimliklar', 'Fastfood'],
    ['Shirinliklar', 'Milliy taomlar'],
    ['Savatcha']
  ];
  await ctx.reply("Kategoriya tanlang:", Markup.keyboard(buttons).resize().oneTime());
  session.step = 'category';
}

clientBot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const session = getSession(ctx.chat.id);
  const db = await connectDB();

  if (data.startsWith('add_')) {
    const id = data.split('_')[1];
    const product = await db.collection('botProducts').findOne({ _id: new ObjectId(id) });
    session.cart.push(product);
    await ctx.answerCbQuery('Savatga qo\'shildi ✅');
  } else if (data === 'none') {
    await ctx.answerCbQuery('Mahsulot qolmagan ❌');
  }
});

// ------------------
// 2️⃣ Admin bot
// ------------------
adminBot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const db = await connectDB();

  if (text === 'Zakazlar') {
    const orders = await db.collection('botOrders').find({ status: 'pending' }).toArray();
    if (!orders.length) return ctx.reply("Hozir zakaz yo'q.");

    for (const order of orders) {
      await ctx.reply(`Zakaz ID: ${order._id}\nMijoz: ${order.clientName}\nTelefon: ${order.clientPhone}\nMahsulotlar: ${order.cart.map(p=>p.name).join(', ')}\nTo'lov: ${order.paymentType}`);
    }
  }
});

// ------------------
// 3️⃣ Dastafkachi bot
// ------------------
deliveryBot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const db = await connectDB();

  if (text.startsWith('Yetkazildi_')) {
    const orderId = text.split('_')[1];
    await db.collection('botOrders').updateOne({ _id: new ObjectId(orderId) }, { $set: { status: 'delivered' } });

    // Mijozga xabar
    const order = await db.collection('botOrders').findOne({ _id: new ObjectId(orderId) });
    clientBot.telegram.sendMessage(order.chatId, `Zakazingiz yetkazildi ✅`);

    await ctx.reply(`Zakaz #${orderId} yetkazildi.`);
  }
});

// ------------------
// Webhook handler
// ------------------
export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const body = req.body;
      await Promise.all([
        clientBot.handleUpdate(body),
        adminBot.handleUpdate(body),
        deliveryBot.handleUpdate(body)
      ]);
      return res.status(200).send('OK');
    } else {
      res.status(200).send('Telegram webhook bot ishlayapti ✅');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Server xatolik ❌');
  }
}
