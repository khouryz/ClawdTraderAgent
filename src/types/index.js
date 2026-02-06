/**
 * Type Definitions for Tradovate Trading Bot
 * 
 * This file contains JSDoc type definitions for better IDE support
 * and code documentation. Import types using:
 * 
 * @typedef {import('./types').Signal} Signal
 */

/**
 * @typedef {Object} TradovateConfig
 * @property {'demo'|'live'} env - Trading environment
 * @property {string} username - Tradovate username
 * @property {string} password - Tradovate password
 * @property {number|null} cid - API Client ID
 * @property {string|null} secret - API Secret
 * @property {string} contractSymbol - Contract symbol (e.g., 'MESH6')
 * @property {boolean} autoRollover - Auto-rollover to front month
 * @property {RiskConfig} riskPerTrade - Risk per trade settings
 * @property {number} profitTargetR - Profit target in R-multiples
 * @property {number} dailyLossLimit - Daily loss limit in dollars
 * @property {number} weeklyLossLimit - Weekly loss limit in dollars
 * @property {number} maxConsecutiveLosses - Max consecutive losses before halt
 * @property {number} maxDrawdownPercent - Max drawdown percentage
 * @property {string} strategy - Strategy name
 * @property {number} lookbackPeriod - Lookback period for breakout
 * @property {number} atrMultiplier - ATR multiplier for stop loss
 * @property {number} trendEMAPeriod - EMA period for trend filter
 * @property {boolean} useTrendFilter - Enable trend filter
 * @property {boolean} useVolumeFilter - Enable volume filter
 * @property {boolean} useRSIFilter - Enable RSI filter
 * @property {number} tradingStartHour - Trading start hour
 * @property {number} tradingStartMinute - Trading start minute
 * @property {number} tradingEndHour - Trading end hour
 * @property {number} tradingEndMinute - Trading end minute
 * @property {boolean} avoidLunch - Avoid lunch hour trading
 * @property {string} timezone - Timezone for trading hours
 * @property {boolean} trailingStopEnabled - Enable trailing stop
 * @property {number} trailingStopATRMultiplier - Trailing stop ATR multiplier
 * @property {boolean} partialProfitEnabled - Enable partial profit taking
 * @property {number} partialProfitPercent - Partial profit percentage
 * @property {number} partialProfitR - Partial profit R-multiple trigger
 */

/**
 * @typedef {Object} RiskConfig
 * @property {number} min - Minimum risk per trade in dollars
 * @property {number} max - Maximum risk per trade in dollars
 */

/**
 * @typedef {Object} Signal
 * @property {'buy'|'sell'} type - Signal type
 * @property {number} price - Entry price
 * @property {number} stopLoss - Stop loss price
 * @property {Date} timestamp - Signal timestamp
 * @property {FilterResults} [filterResults] - Filter results for learning
 */

/**
 * @typedef {Object} FilterResults
 * @property {boolean} trendFilter - Trend filter passed
 * @property {boolean} volumeFilter - Volume filter passed
 * @property {boolean} rsiFilter - RSI filter passed
 * @property {number} [rsi] - RSI value at signal
 * @property {number} [volumeRatio] - Volume ratio at signal
 * @property {number} [emaDistance] - Distance from EMA
 */

/**
 * @typedef {Object} Position
 * @property {'Buy'|'Sell'} side - Position side
 * @property {number} quantity - Number of contracts
 * @property {number} entryPrice - Entry price
 * @property {number} stopLoss - Stop loss price
 * @property {number} target - Take profit price
 * @property {number} risk - Total risk in dollars
 * @property {string|number} orderId - Order ID
 * @property {Date} entryTime - Entry timestamp
 */

/**
 * @typedef {Object} PositionCalc
 * @property {number} contracts - Number of contracts
 * @property {number} totalRisk - Total risk in dollars
 * @property {number} targetPrice - Take profit price
 * @property {number} stopPrice - Stop loss price
 * @property {number} riskPerContract - Risk per contract
 */

/**
 * @typedef {Object} TradeRecord
 * @property {string} id - Unique trade ID
 * @property {string} symbol - Contract symbol
 * @property {'Buy'|'Sell'} side - Trade side
 * @property {number} contracts - Number of contracts
 * @property {number} entryPrice - Entry price
 * @property {number} [exitPrice] - Exit price
 * @property {number} stopLoss - Stop loss price
 * @property {number} takeProfit - Take profit price
 * @property {number} riskAmount - Risk amount in dollars
 * @property {MarketStructure} marketStructure - Market structure at entry
 * @property {FilterResults} filterResults - Filter results
 * @property {string} explanation - AI explanation
 * @property {Date} entryTime - Entry timestamp
 * @property {Date} [exitTime] - Exit timestamp
 * @property {string} [exitReason] - Exit reason
 * @property {number} [pnl] - Profit/loss in dollars
 * @property {number} [rMultiple] - R-multiple
 */

/**
 * @typedef {Object} MarketStructure
 * @property {number} price - Current price
 * @property {number} atr - ATR value
 * @property {number} rsi - RSI value
 * @property {number} ema - EMA value
 * @property {number} volumeRatio - Volume ratio
 * @property {string} trend - Trend direction
 * @property {string} session - Trading session
 * @property {number} breakoutHigh - Breakout high level
 * @property {number} breakoutLow - Breakout low level
 */

/**
 * @typedef {Object} Bar
 * @property {string|Date} timestamp - Bar timestamp
 * @property {number} open - Open price
 * @property {number} high - High price
 * @property {number} low - Low price
 * @property {number} close - Close price
 * @property {number} volume - Total volume
 * @property {number} [upVolume] - Up volume
 * @property {number} [downVolume] - Down volume
 */

/**
 * @typedef {Object} Quote
 * @property {number} contractId - Contract ID
 * @property {string|Date} timestamp - Quote timestamp
 * @property {number} bid - Bid price
 * @property {number} ask - Ask price
 * @property {number} last - Last price
 * @property {number} [bidSize] - Bid size
 * @property {number} [askSize] - Ask size
 * @property {number} [volume] - Total volume
 */

/**
 * @typedef {Object} Fill
 * @property {number} id - Fill ID
 * @property {number} orderId - Order ID
 * @property {number} contractId - Contract ID
 * @property {string} action - 'Buy' or 'Sell'
 * @property {number} qty - Quantity filled
 * @property {number} price - Fill price
 * @property {string|Date} timestamp - Fill timestamp
 * @property {string} [reason] - Fill reason
 */

/**
 * @typedef {Object} Order
 * @property {number} id - Order ID
 * @property {number} accountId - Account ID
 * @property {number} contractId - Contract ID
 * @property {string} action - 'Buy' or 'Sell'
 * @property {number} orderQty - Order quantity
 * @property {string} orderType - Order type
 * @property {number} [price] - Limit price
 * @property {number} [stopPrice] - Stop price
 * @property {string} ordStatus - Order status
 * @property {string|Date} timestamp - Order timestamp
 */

/**
 * @typedef {Object} Account
 * @property {number} id - Account ID
 * @property {string} name - Account name
 * @property {boolean} active - Is account active
 * @property {number} userId - User ID
 */

/**
 * @typedef {Object} Contract
 * @property {number} id - Contract ID
 * @property {string} name - Contract name (e.g., 'MESH6')
 * @property {number} productId - Product ID
 * @property {string} expirationDate - Expiration date
 */

/**
 * @typedef {Object} CashBalance
 * @property {number} accountId - Account ID
 * @property {number} cashBalance - Cash balance
 * @property {number} realizedPnL - Realized P&L
 * @property {number} openPnL - Open P&L
 * @property {string} tradeDate - Trade date
 */

/**
 * @typedef {Object} BacktestResult
 * @property {BacktestSummary} summary - Performance summary
 * @property {TradeStats} trades - Trade statistics
 * @property {Object} period - Backtest period info
 * @property {Object} config - Backtest configuration
 * @property {Array<BacktestTrade>} tradeList - List of trades
 */

/**
 * @typedef {Object} BacktestSummary
 * @property {number} startingBalance - Starting balance
 * @property {number} endingBalance - Ending balance
 * @property {number} totalPnL - Total P&L
 * @property {number} returnPercent - Return percentage
 * @property {number} maxDrawdown - Maximum drawdown percentage
 * @property {number} peakBalance - Peak balance
 */

/**
 * @typedef {Object} TradeStats
 * @property {number} total - Total trades
 * @property {number} wins - Winning trades
 * @property {number} losses - Losing trades
 * @property {number} winRate - Win rate percentage
 * @property {number} avgWin - Average win in dollars
 * @property {number} avgLoss - Average loss in dollars
 * @property {number} avgRMultiple - Average R-multiple
 * @property {number} profitFactor - Profit factor
 */

/**
 * @typedef {Object} BacktestTrade
 * @property {number} id - Trade ID
 * @property {'Buy'|'Sell'} side - Trade side
 * @property {number} entryPrice - Entry price
 * @property {number} exitPrice - Exit price
 * @property {string} exitReason - Exit reason
 * @property {number} contracts - Number of contracts
 * @property {number} pnl - P&L in dollars
 * @property {number} rMultiple - R-multiple
 * @property {number} balanceAfter - Balance after trade
 */

/**
 * @typedef {Object} FeedbackSummary
 * @property {number} totalTrades - Total trades analyzed
 * @property {number} winRate - Overall win rate
 * @property {Object} byTimeOfDay - Performance by time of day
 * @property {Object} byRSI - Performance by RSI range
 * @property {Object} byVolume - Performance by volume
 * @property {Array<string>} recommendations - Improvement recommendations
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Is valid
 * @property {string} [reason] - Reason if invalid
 * @property {Array<string>} [errors] - List of errors
 * @property {Array<string>} [warnings] - List of warnings
 */

/**
 * @typedef {Object} SessionStatus
 * @property {boolean} allowed - Can trade
 * @property {string} reason - Reason
 * @property {string} session - Current session name
 * @property {string} nextSession - Next session name
 * @property {Date} [nextSessionStart] - Next session start time
 */

// Export empty object to make this a module
module.exports = {};
