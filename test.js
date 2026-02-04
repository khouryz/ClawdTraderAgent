#!/usr/bin/env node

/**
 * Test script to validate bot configuration
 */

require('dotenv').config();
const TradovateAuth = require('./src/api/auth');
const TradovateClient = require('./src/api/client');

async function test() {
  console.log('🧪 Testing Tradovate Bot Configuration...\n');

  // 1. Check environment variables
  console.log('1. Checking environment variables...');
  const required = ['TRADOVATE_USERNAME', 'TRADOVATE_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error(`   ❌ Missing: ${missing.join(', ')}`);
    console.error('   Please update your .env file');
    process.exit(1);
  }
  console.log('   ✓ Environment variables configured');

  // 2. Test authentication
  console.log('\n2. Testing authentication...');
  try {
    const auth = new TradovateAuth({
      env: process.env.TRADOVATE_ENV || 'demo',
      username: process.env.TRADOVATE_USERNAME,
      password: process.env.TRADOVATE_PASSWORD
    });

    const result = await auth.authenticate();
    console.log(`   ✓ Authentication successful`);
    console.log(`   User ID: ${result.userId}`);
    console.log(`   Token expires: ${result.expiry.toISOString()}`);

    // 3. Test API client
    console.log('\n3. Testing API client...');
    const client = new TradovateClient(auth);

    // Get accounts
    const accounts = await client.getAccounts();
    console.log(`   ✓ Found ${accounts.length} account(s)`);
    accounts.forEach(acc => {
      console.log(`      - ${acc.name} (ID: ${acc.id})`);
    });

    if (accounts.length === 0) {
      console.error('   ❌ No accounts found. Please check your Tradovate setup.');
      process.exit(1);
    }

    // Get contract
    console.log('\n4. Testing contract lookup...');
    const contractSymbol = process.env.CONTRACT_SYMBOL || 'MESM5';
    const contract = await client.findContract(contractSymbol);
    
    if (contract) {
      console.log(`   ✓ Contract found: ${contract.name}`);
      console.log(`      ID: ${contract.id}`);
      console.log(`      Symbol: ${contractSymbol}`);
    } else {
      console.error(`   ❌ Contract "${contractSymbol}" not found`);
      console.error('   Update CONTRACT_SYMBOL in .env to current month');
      process.exit(1);
    }

    // Get balance
    console.log('\n5. Testing account balance...');
    const balance = await client.getCashBalance(accounts[0].id);
    console.log(`   ✓ Account balance: $${balance.cashBalance.toFixed(2)}`);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ All tests passed!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\nYou can now run the bot with:');
    console.log('  npm start');
    console.log('');

  } catch (error) {
    console.error(`\n❌ Test failed: ${error.message}`);
    if (error.response?.data) {
      console.error('   API Error:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

test();
