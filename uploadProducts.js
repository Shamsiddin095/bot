import 'dotenv/config';
import { MongoClient } from 'mongodb';
import fs from 'fs';

const MONGO_URI = process.env.MONGO_URI;

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();

  const data = JSON.parse(fs.readFileSync('./products.json', 'utf-8'));
  const collection = db.collection('botProducts');

  // Eski ma'lumotlarni tozalash
  await collection.deleteMany({});

  // Endi faqat fayl nomini saqlaymiz
  const productsWithImages = data.map(p => ({
    ...p,
    image: p.image,         // faqat fayl nomi (masalan: cola.jfif)
    image_hira: p.image_hira
  }));

  const result = await collection.insertMany(productsWithImages);
  console.log(`✅ ${result.insertedCount} ta mahsulot qo'shildi!`);

  await client.close();
}

main().catch(console.error);
