/**
 * CLI Commands - Command handlers for Clawdbot integration
 * 
 * Provides JSON output for:
 * - Status checks
 * - Balance queries
 * - Position queries
 * - Performance reports
 * - Signal checks
 */

const SessionFilter = require('../filters/session_filter');
const LossLimitsManager = require('../risk/loss_limits');
const PerformanceTracker = require('../analytics/performance');
const OpeningRangeBreakoutStrategy = require('../strategies/opening_range_breakout');

/**
 * CLI Commands class - handles all command-line operations
 */
class CLICommands {
  /**
   * @param {Object} bot - TradovateBot instance with initialized core
   */
  constructor(bot) {
    this.bot = bot;
  }

  /**
   * Get current trading status
   * @returns {Object} Status object with account, positions, session info
   */
  async getStatus() {
    const [tradingState, sessionStatus] = await Promise.all([
      this.bot.client.getTradingState(this.bot.account.id),
      new SessionFilter(this.bot.config).getStatus()
    ]);

    const lossLimits = new LossLimitsManager(this.bot.config);
    
    return {
      timestamp: new Date().toISOString(),
      environment: this.bot.config.env,
      account: tradingState.account,
      balance: tradingState.balance,
      positions: tradingState.positions,
      orders: tradingState.orders,
      session: sessionStatus,
      lossLimits: lossLimits.getStatus(),
      contract: {
        symbol: this.bot.contract.name,
        id: this.bot.contract.id
      }
    };
  }

  /**
   * Get account balance
   * @returns {Object} Balance information
   */
  async getBalance() {
    const balance = await this.bot.client.getCashBalance(this.bot.account.id);
    return {
      timestamp: new Date().toISOString(),
      accountId: this.bot.account.id,
      accountName: this.bot.account.name,
      cashBalance: balance.cashBalance,
      realizedPnL: balance.realizedPnL || 0,
      openPnL: balance.openPnL || 0
    };
  }

  /**
   * Get open positions
   * @returns {Object} Positions information
   */
  async getPositions() {
    const positions = await this.bot.client.getOpenPositions(this.bot.account.id);
    return {
      timestamp: new Date().toISOString(),
      accountId: this.bot.account.id,
      positions: positions,
      count: positions.length
    };
  }

  /**
   * Get performance report
   * @returns {Object} Performance statistics
   */
  async getReport() {
    const performance = new PerformanceTracker();
    const balance = await this.bot.client.getCashBalance(this.bot.account.id);
    
    return {
      timestamp: new Date().toISOString(),
      accountBalance: balance.cashBalance,
      ...performance.generateReport()
    };
  }

  /**
   * Check for trade signal (one-shot check for cron jobs)
   * @returns {Object} Signal check result
   */
  async checkSignal() {
    // Initialize components needed for signal check
    const sessionFilter = new SessionFilter(this.bot.config);
    const lossLimits = new LossLimitsManager(this.bot.config);
    
    // Check if we can trade
    const sessionCheck = sessionFilter.canTrade();
    const lossCheck = lossLimits.canTrade();
    
    if (!sessionCheck.allowed) {
      return { canTrade: false, reason: sessionCheck.reason };
    }
    
    if (!lossCheck.allowed) {
      return { canTrade: false, reason: lossCheck.reason };
    }

    // Get current positions
    const positions = await this.bot.client.getOpenPositions(this.bot.account.id);
    if (positions.length > 0) {
      return { canTrade: false, reason: 'Already in position', positions };
    }

    // Get bars and check for signal
    const bars = await this.bot.client.getChartBars(this.bot.contract.id, 100);
    
    const strategy = new OpeningRangeBreakoutStrategy({
      orPeriodMinutes: parseInt(process.env.OR_PERIOD_MINUTES) || 15,
      orBuffer: parseFloat(process.env.OR_BUFFER) || 0.5,
      maxStopPoints: parseInt(process.env.MAX_STOP_POINTS) || 12,
      profitTargetR: parseFloat(process.env.PROFIT_TARGET_R) || 3,
      useTrailingStop: process.env.TRAILING_STOP_ENABLED === 'true',
      trailActivationR: parseFloat(process.env.TRAIL_ACTIVATION_R) || 2.0,
      trailDistancePoints: parseFloat(process.env.TRAIL_DISTANCE_POINTS) || 8,
      useTrendFilter: process.env.USE_TREND_FILTER === 'true',
      useVolumeFilter: process.env.USE_VOLUME_FILTER !== 'false',
      useRSIFilter: process.env.USE_RSI_FILTER !== 'false',
      useADXFilter: process.env.USE_ADX_FILTER !== 'false',
      allowShorts: process.env.ALLOW_SHORTS !== 'false',
      sessionFilter: sessionFilter,
      minBars: 1,
    });

    if (bars && bars.bars) {
      bars.bars.forEach(bar => strategy.onBar(bar));
    }

    return {
      canTrade: true,
      session: sessionCheck,
      strategyStatus: strategy.getStatus(),
      barsLoaded: bars?.bars?.length || 0
    };
  }
}

/**
 * Parse command line arguments and execute appropriate command
 * @param {TradovateBot} bot - Bot instance
 * @returns {Object|null} Command result or null if continuous mode
 */
async function executeCommand(bot) {
  const args = process.argv.slice(2);
  
  // Check for command flags
  const hasCommand = args.some(arg => 
    ['--status', '--balance', '--positions', '--report', '--check', '--help'].includes(arg)
  );

  if (args.includes('--help')) {
    printHelp();
    return { exit: true };
  }

  if (!hasCommand) {
    // No command flag - run in continuous mode
    return null;
  }

  // Initialize core for command execution
  await bot.initializeCore();
  const commands = new CLICommands(bot);

  if (args.includes('--status')) {
    return await commands.getStatus();
  } else if (args.includes('--balance')) {
    return await commands.getBalance();
  } else if (args.includes('--positions')) {
    return await commands.getPositions();
  } else if (args.includes('--report')) {
    return await commands.getReport();
  } else if (args.includes('--check')) {
    return await commands.checkSignal();
  }

  return null;
}

/**
 * Print help message
 */
function printHelp() {
  console.log(`
Tradovate Trading Bot - CLI Commands

Usage:
  node src/index.js [command]

Commands:
  (none)        Start continuous trading mode
  --status      Get current trading status (JSON)
  --balance     Get account balance (JSON)
  --positions   Get open positions (JSON)
  --report      Get performance report (JSON)
  --check       Check for trade signal once (JSON)
  --help        Show this help message

Examples:
  node src/index.js              # Start trading
  node src/index.js --status     # Get status
  node src/index.js --balance    # Get balance

Environment:
  Configure via .env file. See .env.example for options.
`);
}

module.exports = {
  CLICommands,
  executeCommand,
  printHelp
};
