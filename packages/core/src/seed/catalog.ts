import type { Rng } from './random.js';

export interface SeedCategory { key: string; name: string; priceMin: number; priceMax: number; replenishDays?: number; complement?: string }
export const CATEGORIES: SeedCategory[] = [
  { key: 'skincare', name: 'Skincare', priceMin: 299, priceMax: 3499, replenishDays: 45, complement: 'makeup' },
  { key: 'haircare', name: 'Haircare', priceMin: 199, priceMax: 2499, replenishDays: 40, complement: 'skincare' },
  { key: 'makeup', name: 'Makeup', priceMin: 249, priceMax: 4999, complement: 'skincare' },
  { key: 'fragrance', name: 'Fragrance', priceMin: 799, priceMax: 8999 },
  { key: 'supplements', name: 'Health Supplements', priceMin: 399, priceMax: 3999, replenishDays: 30, complement: 'fitness-gear' },
  { key: 'running-shoes', name: 'Running Shoes', priceMin: 1999, priceMax: 14999, complement: 'sports-socks' },
  { key: 'sports-socks', name: 'Sports Socks', priceMin: 199, priceMax: 999, replenishDays: 120 },
  { key: 'sneakers', name: 'Sneakers', priceMin: 1499, priceMax: 12999, complement: 'accessories' },
  { key: 'mens-apparel', name: "Men's Apparel", priceMin: 499, priceMax: 5999, complement: 'accessories' },
  { key: 'womens-apparel', name: "Women's Apparel", priceMin: 499, priceMax: 7999, complement: 'bags' },
  { key: 'ethnic-wear', name: 'Ethnic Wear', priceMin: 999, priceMax: 14999, complement: 'accessories' },
  { key: 'kids', name: 'Kids', priceMin: 299, priceMax: 2999 },
  { key: 'accessories', name: 'Accessories', priceMin: 199, priceMax: 3999 },
  { key: 'bags', name: 'Bags & Luggage', priceMin: 799, priceMax: 12999 },
  { key: 'watches', name: 'Watches', priceMin: 1499, priceMax: 29999 },
  { key: 'phone-accessories', name: 'Smartphone Accessories', priceMin: 199, priceMax: 3999, complement: 'audio' },
  { key: 'audio', name: 'Audio', priceMin: 999, priceMax: 24999, complement: 'phone-accessories' },
  { key: 'home-decor', name: 'Home Decor', priceMin: 399, priceMax: 9999, complement: 'bedding' },
  { key: 'kitchen', name: 'Kitchen', priceMin: 299, priceMax: 14999 },
  { key: 'bedding', name: 'Bedding', priceMin: 799, priceMax: 9999 },
  { key: 'grocery', name: 'Grocery Staples', priceMin: 99, priceMax: 1499, replenishDays: 21, complement: 'snacks' },
  { key: 'snacks', name: 'Snacks', priceMin: 49, priceMax: 799, replenishDays: 14, complement: 'beverages' },
  { key: 'beverages', name: 'Beverages', priceMin: 99, priceMax: 1299, replenishDays: 21 },
  { key: 'pet-supplies', name: 'Pet Supplies', priceMin: 199, priceMax: 4999, replenishDays: 30 },
  { key: 'fitness-gear', name: 'Fitness Gear', priceMin: 499, priceMax: 19999, complement: 'supplements' },
];
const BRANDS = ['Aarav', 'Nykaa-ish', 'Boldfit', 'Zudio', 'Urbano', 'Mivi', 'Plum', 'Mamaearth-like', 'Campus', 'Puma-ish', 'Tata-ish', 'Wow', 'Ustraa', 'Bewakoof', 'Lenskart-ish', 'Noise', 'Pilgrim', 'Sleepy Owl', 'Yoga Bar', 'Drools'];
const ADJ = ['Classic', 'Pro', 'Ultra', 'Daily', 'Glow', 'Active', 'Essential', 'Premium', 'Lite', 'Max', 'Natural', 'Sport', 'Comfort', 'Urban', 'Heritage'];
const NOUN: Record<string, string[]> = {
  skincare: ['Vitamin C Serum', 'Sunscreen SPF50', 'Night Cream', 'Face Wash', 'Moisturiser'], haircare: ['Shampoo', 'Hair Oil', 'Conditioner', 'Hair Mask', 'Serum'], makeup: ['Lipstick', 'Kajal', 'Foundation', 'Compact', 'Mascara'],
  fragrance: ['Eau de Parfum', 'Body Mist', 'Deodorant'], supplements: ['Whey Protein', 'Multivitamin', 'Omega-3', 'Creatine', 'Collagen'], 'running-shoes': ['Runner', 'Trail Runner', 'Road Racer', 'Daily Trainer'], 'sports-socks': ['Ankle Socks 3-pack', 'Crew Socks', 'Cushioned Socks'],
  sneakers: ['Low-top Sneaker', 'High-top Sneaker', 'Canvas Sneaker'], 'mens-apparel': ['Polo T-shirt', 'Chinos', 'Oxford Shirt', 'Hoodie', 'Joggers'], 'womens-apparel': ['Kurti', 'Palazzo', 'Dress', 'Co-ord Set', 'Top'], 'ethnic-wear': ['Saree', 'Kurta Set', 'Lehenga', 'Sherwani'],
  kids: ['Romper', 'T-shirt Pack', 'School Bag', 'Sneakers'], accessories: ['Belt', 'Wallet', 'Sunglasses', 'Cap', 'Scarf'], bags: ['Backpack', 'Tote', 'Trolley 55cm', 'Sling Bag'], watches: ['Analog Watch', 'Smartwatch', 'Chronograph'],
  'phone-accessories': ['Fast Charger', 'Case', 'Screen Guard', 'Power Bank', 'Cable'], audio: ['TWS Earbuds', 'Headphones', 'Soundbar', 'Bluetooth Speaker'], 'home-decor': ['Wall Clock', 'Planter', 'Table Lamp', 'Cushion Set'], kitchen: ['Non-stick Pan', 'Mixer Grinder', 'Storage Set', 'Water Bottle'],
  bedding: ['Bedsheet Set', 'Comforter', 'Pillow Pair'], grocery: ['Basmati Rice 5kg', 'Atta 10kg', 'Toor Dal 1kg', 'Sunflower Oil 1L', 'Sugar 1kg'], snacks: ['Makhana', 'Trail Mix', 'Protein Bar 6-pack', 'Namkeen'], beverages: ['Green Tea', 'Cold Brew Coffee', 'Protein Shake'], 'pet-supplies': ['Dog Food 3kg', 'Cat Litter', 'Chew Toy'], 'fitness-gear': ['Yoga Mat', 'Dumbbell Set', 'Resistance Bands', 'Skipping Rope'],
};
export interface SeedProduct { externalId: string; name: string; sku: string; brand: string; price: number; categoryKey: string }
export function buildProducts(rng: Rng, count: number): SeedProduct[] {
  const out: SeedProduct[] = [];
  for (let i = 0; i < count; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length]!;
    const price = Math.round(cat.priceMin + rng.next() ** 1.5 * (cat.priceMax - cat.priceMin));
    out.push({ externalId: `sku_${String(i + 1).padStart(4, '0')}`, name: `${rng.pick(BRANDS)} ${rng.pick(ADJ)} ${rng.pick(NOUN[cat.key]!)}`, sku: `SKU-${cat.key.toUpperCase().slice(0, 4)}-${i + 1}`, brand: rng.pick(BRANDS), price, categoryKey: cat.key });
  }
  return out;
}
export const FIRST_NAMES = ['aarav', 'vivaan', 'aditya', 'vihaan', 'arjun', 'sai', 'reyansh', 'ayaan', 'krishna', 'ishaan', 'ananya', 'diya', 'aadhya', 'saanvi', 'pari', 'anika', 'navya', 'myra', 'riya', 'kiara', 'rohan', 'priya', 'neha', 'rahul', 'sneha', 'amit', 'pooja', 'karan', 'meera', 'nikhil', 'john', 'emma', 'liam', 'olivia', 'noah', 'ava', 'mohammed', 'fatima', 'ali', 'sara'];
export const LAST_NAMES = ['sharma', 'verma', 'gupta', 'singh', 'kumar', 'patel', 'reddy', 'nair', 'iyer', 'mehta', 'jain', 'shah', 'khan', 'das', 'bose', 'rao', 'pillai', 'menon', 'chopra', 'malhotra', 'smith', 'johnson', 'brown', 'williams', 'ahmed', 'hussain'];
export const EMAIL_DOMAINS: ReadonlyArray<readonly [string, number]> = [['gmail.com', 52], ['yahoo.com', 9], ['outlook.com', 8], ['hotmail.com', 6], ['rediffmail.com', 5], ['icloud.com', 4], ['yahoo.co.in', 4], ['protonmail.com', 2], ['example-corp.com', 5], ['fastmail.com', 2], ['googlemail.com', 3]];
export const COUNTRIES: ReadonlyArray<readonly [string, number]> = [['IN', 88], ['US', 4], ['AE', 3], ['GB', 2], ['SG', 1], ['AU', 1], ['DE', 1]];
export const IN_STATES = ['Maharashtra', 'Karnataka', 'Delhi', 'Tamil Nadu', 'Telangana', 'Gujarat', 'Uttar Pradesh', 'West Bengal', 'Rajasthan', 'Kerala', 'Haryana', 'Punjab', 'Madhya Pradesh'];
export const IN_CITIES: Record<string, string[]> = { Maharashtra: ['Mumbai', 'Pune', 'Nagpur'], Karnataka: ['Bengaluru', 'Mysuru'], Delhi: ['New Delhi'], 'Tamil Nadu': ['Chennai', 'Coimbatore'], Telangana: ['Hyderabad'], Gujarat: ['Ahmedabad', 'Surat'], 'Uttar Pradesh': ['Lucknow', 'Noida'], 'West Bengal': ['Kolkata'], Rajasthan: ['Jaipur'], Kerala: ['Kochi'], Haryana: ['Gurugram'], Punjab: ['Chandigarh'], 'Madhya Pradesh': ['Indore'] };
