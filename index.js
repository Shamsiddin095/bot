import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { Telegraf, Markup } from 'telegraf';
import { MongoClient, ObjectId } from 'mongodb';
import path from 'path';
import { fileURLToPath } from 'url';

// --- ESM __dirname --- 
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Env variables ---
const BOT_TOKEN_CLIENT = process.env.BOT_TOKEN_CLIENT;
const BOT_TOKEN_ADMIN = process.env.BOT_TOKEN_ADMIN;
const BOT_TOKEN_DELIVERY = process.env.BOT_TOKEN_DELIVERY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;
const APP_URL = process.env.APP_URL; // Render domeningiz, mas: https://my-bot.onrender.com

// --- MongoDB ---
let db;
async function connectDB() {
    if (db) return db;
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db();
    return db;
}

// --- Bots ---
const clientBot = new Telegraf(BOT_TOKEN_CLIENT);
const adminBot = new Telegraf(BOT_TOKEN_ADMIN);
const deliveryBot = new Telegraf(BOT_TOKEN_DELIVERY);

// --- Session ---
const sessions = {};
function getSession(chatId) {
    if (!sessions[chatId]) sessions[chatId] = { cart: [] };
    return sessions[chatId];
}

// --- Client bot handlers ---
clientBot.start(async (ctx) => {
    const session = getSession(ctx.chat.id);
    session.cart = [];
    await ctx.reply("Salom! Bot ishlayapti ✅\nIsmingizni kiriting:");
    session.step = 'get_name';
});

clientBot.on('text', async (ctx) => {
    const session = getSession(ctx.chat.id);
    const db = await connectDB();

    if (session.step === 'get_name') {
        session.name = ctx.message.text;
        await ctx.reply("Telefon raqamingizni yuboring:", Markup.keyboard([
            [Markup.button.contactRequest('Telefonni yuborish')]
        ]).oneTime().resize());
        session.step = 'get_phone';
    } else if (session.step === 'category') {
        const category = ctx.message.text;
        const products = await db.collection('botProducts').find({
            category: { $regex: `^${category}$`, $options: 'i' }
        }).toArray();

        if (!products.length) return ctx.reply("Ushbu kategoriyada mahsulot yo'q.");
        session.step = 'product';
        session.currentCategory = category;

        for (const p of products) {
            const available = p.stock > 0;
            const imgPath = path.join(__dirname, "img", available ? p.image : p.image_hira);
            await ctx.replyWithPhoto(
                { source: imgPath },
                {
                    caption: `${p.name}\nNarxi: ${p.price} so'm`,
                    reply_markup: Markup.inlineKeyboard([
                        available
                            ? Markup.button.callback("Savatga qo'shish", `add_${p._id}`)
                            : Markup.button.callback("Sotuvda yo'q", "none")
                    ])
                }
            );
        }
    }
});

// --- Contact handler ---
clientBot.on('contact', async (ctx) => {
    const session = getSession(ctx.chat.id);
    if (session.step !== 'get_phone') return;

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
});

// --- Callback query ---
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

// --- Show categories ---
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

// --- Send order to admin ---
async function sendOrderToAdmin(session) {
    const db = await connectDB();
    const order = {
        clientName: session.name,
        clientPhone: session.phone,
        chatId: session.chatId,
        cart: session.cart,
        paymentType: session.paymentType || 'Naqd',
        checkFileId: session.checkFileId || null,
        status: 'pending',
        createdAt: new Date()
    };
    const result = await db.collection('botOrders').insertOne(order);
    const message = `✅ Yangi zakaz!\nID: ${result.insertedId}\nMijoz: ${session.name}\nTelefon: ${session.phone}\nMahsulotlar: ${session.cart.map(p=>p.name).join(', ')}\nTo‘lov: ${session.paymentType || 'Naqd'}`;

    if(session.checkFileId){
        await adminBot.telegram.sendPhoto(ADMIN_CHAT_ID, session.checkFileId, { caption: message });
    } else {
        await adminBot.telegram.sendMessage(ADMIN_CHAT_ID, message);
    }
}

// --- Express server for webhook ---
const app = express();
app.use(bodyParser.json());

// Client webhook
app.post('/client', async (req, res) => {
    await clientBot.handleUpdate(req.body);
    res.send('OK');
});

// Admin webhook
app.post('/admin', async (req, res) => {
    await adminBot.handleUpdate(req.body);
    res.send('OK');
});

// Delivery webhook
app.post('/delivery', async (req, res) => {
    await deliveryBot.handleUpdate(req.body);
    res.send('OK');
});

app.get('/', (req, res) => res.send('Bot ishlayapti ✅'));

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server ${PORT} portda ishlayapti`);

    // --- Set webhooks ---
    await clientBot.telegram.setWebhook(`${APP_URL}/client`);
    await adminBot.telegram.setWebhook(`${APP_URL}/admin`);
    await deliveryBot.telegram.setWebhook(`${APP_URL}/delivery`);

    console.log('Webhooks o\'rnatildi ✅');
});
