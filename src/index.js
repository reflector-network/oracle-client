const OracleClient = require('./oracle')
const SubscriptionsClient = require('./subscriptions')
const {parseAssetResult, parseAssetsResult, parsePricesResult, parseTwapResult, parseNumberResult, parseAdminResult, parseSubscriptionResult} = require('./xdr-values-helper')

module.exports.OracleClient = OracleClient
module.exports.SubscriptionsClient = SubscriptionsClient

module.exports.parseAssetResult = parseAssetResult
module.exports.parseAssetsResult = parseAssetsResult
module.exports.parsePricesResult = parsePricesResult
module.exports.parseTwapResult = parseTwapResult
module.exports.parseNumberResult = parseNumberResult
module.exports.parseAdminResult = parseAdminResult
module.exports.parseSubscriptionResult = parseSubscriptionResult