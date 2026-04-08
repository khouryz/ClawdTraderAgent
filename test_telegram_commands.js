/**
 * Test script to verify Telegram command implementation
 * 
 * This script checks that all required files have been modified correctly
 * and the implementation follows the plan.
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 Verifying Telegram Command Implementation...\n');

// Check 1: TelegramCommandHandler exists
const handlerPath = path.join(__dirname, 'src/utils/TelegramCommandHandler.js');
if (fs.existsSync(handlerPath)) {
  console.log('✅ TelegramCommandHandler.js created');
  
  const handlerContent = fs.readFileSync(handlerPath, 'utf8');
  const requiredMethods = ['constructor', 'start', 'stop', '_poll', '_processUpdates', '_handleCommand'];
  let allMethodsPresent = true;
  
  for (const method of requiredMethods) {
    if (!handlerContent.includes(method)) {
      console.log(`❌ Missing method: ${method}`);
      allMethodsPresent = false;
    }
  }
  
  if (allMethodsPresent) {
    console.log('✅ All required methods present in TelegramCommandHandler');
  }
} else {
  console.log('❌ TelegramCommandHandler.js not found');
}

// Check 2: TradovateBot modifications
const tradovatePath = path.join(__dirname, 'src/bot/TradovateBot.js');
if (fs.existsSync(tradovatePath)) {
  const tradovateContent = fs.readFileSync(tradovatePath, 'utf8');
  
  const checks = [
    { pattern: "require('../utils/TelegramCommandHandler')", desc: 'TelegramCommandHandler import' },
    { pattern: 'this._pausedByUser = false', desc: 'Pause flag in constructor' },
    { pattern: 'this.telegramCommands = null', desc: 'telegramCommands property' },
    { pattern: '// User pause check', desc: 'Pause check in _onSignal' },
    { pattern: 'new TelegramCommandHandler(this, this.notifications)', desc: 'TelegramCommandHandler initialization' },
    { pattern: 'this.telegramCommands.start()', desc: 'TelegramCommandHandler start' },
    { pattern: 'this.telegramCommands.stop()', desc: 'TelegramCommandHandler shutdown' },
    { pattern: 'async getStatus()', desc: 'getStatus method' }
  ];
  
  console.log('\n📋 TradovateBot.js checks:');
  for (const check of checks) {
    if (tradovateContent.includes(check.pattern)) {
      console.log(`✅ ${check.desc}`);
    } else {
      console.log(`❌ ${check.desc}`);
    }
  }
}

// Check 3: MultiInstrumentBot modifications
const multiPath = path.join(__dirname, 'src/bot/MultiInstrumentBot.js');
if (fs.existsSync(multiPath)) {
  const multiContent = fs.readFileSync(multiPath, 'utf8');
  
  const checks = [
    { pattern: "require('../utils/TelegramCommandHandler')", desc: 'TelegramCommandHandler import' },
    { pattern: 'this._pausedByUser = false', desc: 'Pause flag in constructor' },
    { pattern: 'this.telegramCommands = null', desc: 'telegramCommands property' },
    { pattern: 'new TelegramCommandHandler(this, this.notifications)', desc: 'TelegramCommandHandler initialization' },
    { pattern: 'this.telegramCommands.start()', desc: 'TelegramCommandHandler start' },
    { pattern: 'this.telegramCommands.stop()', desc: 'TelegramCommandHandler shutdown' },
    { pattern: 'async getAggregatedStatus()', desc: 'getAggregatedStatus method' }
  ];
  
  console.log('\n📋 MultiInstrumentBot.js checks:');
  for (const check of checks) {
    if (multiContent.includes(check.pattern)) {
      console.log(`✅ ${check.desc}`);
    } else {
      console.log(`❌ ${check.desc}`);
    }
  }
}

// Check 4: InstrumentRunner modifications
const runnerPath = path.join(__dirname, 'src/bot/InstrumentRunner.js');
if (fs.existsSync(runnerPath)) {
  const runnerContent = fs.readFileSync(runnerPath, 'utf8');
  
  const checks = [
    { pattern: '// User pause check (via parent bot reference)', desc: 'Pause check in _onSignal' },
    { pattern: "this.shared.bot && this.shared.bot._pausedByUser", desc: 'Pause check logic' }
  ];
  
  console.log('\n📋 InstrumentRunner.js checks:');
  for (const check of checks) {
    if (runnerContent.includes(check.pattern)) {
      console.log(`✅ ${check.desc}`);
    } else {
      console.log(`❌ ${check.desc}`);
    }
  }
}

// Check 5: Environment variables
console.log('\n📋 Environment variables check:');
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  console.log('✅ TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set');
} else {
  console.log('⚠️ TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in current environment');
  console.log('   (These should be set in .env file for production)');
}

console.log('\n🎉 Verification complete!');
console.log('\n📝 Next steps:');
console.log('1. Ensure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set in .env');
console.log('2. Start the bot in test mode to verify commands work');
console.log('3. Test each command: /start, /pause, /resume, /status, /positions, /balance, /report, /halt, /stop');
console.log('\n⚠️  WARNING: /stop and /halt will stop the bot. Use with caution!');
