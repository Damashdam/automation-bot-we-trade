import 'dotenv/config';
import axios from 'axios';

const BASE_URL = 'https://www.wetrade-il.com';

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error('Usage: npx ts-node scripts/generate-api-key.ts <email> <password>');
    process.exit(1);
  }

  // 1. Login
  console.log('Logging in...');
  const loginRes = await axios.post(`${BASE_URL}/api/auth/login`, { email, password });
  const token: string = loginRes.data.token;
  if (!token) {
    console.error('Login failed — no token returned:', loginRes.data);
    process.exit(1);
  }
  console.log('Login successful.');

  // 2. Generate API key
  console.log('Generating API key...');
  const keyRes = await axios.post(
    `${BASE_URL}/api/users/api-key`,
    {},
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const apiKey: string = keyRes.data.apiKey;
  if (!apiKey) {
    console.error('Failed to generate API key:', keyRes.data);
    process.exit(1);
  }

  console.log('\n✅ API key generated successfully!\n');
  console.log('Add this to your .env file:\n');
  console.log(`WETRADE_API_KEY=${apiKey}`);
  console.log('\n⚠️  Save it now — it will not be shown again.');
}

main().catch((err) => {
  console.error('Error:', err?.response?.data || err.message);
  process.exit(1);
});
