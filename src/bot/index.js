/**
 * Bot Module Exports
 */

const TradovateBot = require('./TradovateBot');
const MultiInstrumentBot = require('./MultiInstrumentBot');
const InstrumentRunner = require('./InstrumentRunner');
const SignalHandler = require('./SignalHandler');
const PositionHandler = require('./PositionHandler');

module.exports = {
  TradovateBot,
  MultiInstrumentBot,
  InstrumentRunner,
  SignalHandler,
  PositionHandler
};
