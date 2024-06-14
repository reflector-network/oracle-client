const {xdr, Address, scValToBigInt, Keypair} = require('@stellar/stellar-sdk')
const AssetType = require('./asset-type')

/**
 * @param {Asset} asset - Asset object
 * @returns {xdr.ScVal}
 */
function buildAssetScVal(asset) {
    switch (asset.type) {
        case AssetType.Stellar:
            return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stellar'), new Address(asset.code).toScVal()])
        case AssetType.Other:
            return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Other'), xdr.ScVal.scvSymbol(asset.code)])
        default:
            throw new Error('Invalid asset type')
    }
}

/**
 * @param {any} result - XDR result meta
 * @returns {*}
 */
function getSorobanResultValue(result) {
    const value = result.value().sorobanMeta().returnValue()
    if (value.value() === false) //if footprint's data is different from the contract execution data, the result is false
        return undefined
    return value
}

/**
 * @param {any} xdrAssetResult - XDR asset result
 * @returns {Asset}
 */
function parseAssetResultInternal(xdrAssetResult) {
    const xdrAsset = xdrAssetResult.value()
    const assetType = xdrAsset[0].value().toString()
    switch (AssetType[assetType]) {
        case AssetType.Other:
            return {type: AssetType.Other, code: xdrAsset[1].value().toString()}
        case AssetType.Stellar:
            return {type: AssetType.Stellar, code: Address.contract(xdrAsset[1].value().value()).toString()}
        default:
            throw new Error(`Unknown asset type: ${assetType}`)
    }
}

/**
 * @param {any} xdrPriceResult - XDR price result
 * @returns {Price | null}
 */
function parseXdrPriceResult(xdrPriceResult) {
    const xdrPrice = xdrPriceResult.value()
    if (!xdrPrice)
        return null
    return {
        price: scValToBigInt(xdrPrice[0].val()),
        timestamp: scValToBigInt(xdrPrice[1].val())
    }
}

/**
 * @param {string} result - Trasanction meta XDR
 * @returns {Asset} - Asset object
 */
function parseAssetResult(result) {
    const val = getSorobanResultValue(result)
    if (val === undefined)
        return null
    return parseAssetResultInternal(val)
}

/**
 * @param {string} result - Trasanction meta XDR
 * @returns {Asset[]} - Array of asset objects
 */
function parseAssetsResult(result) {
    const val = getSorobanResultValue(result)?.value()
    if (val === undefined)
        return null
    const assets = []
    for (const assetResult of val)
        assets.push(parseAssetResultInternal(assetResult))
    return assets
}

/**
 * @param {string} result - Trasanction meta XDR
 * @returns {Price} - Price object
 */
function parsePriceResult(result) {
    const val = getSorobanResultValue(result)
    if (val === undefined)
        return null
    return parseXdrPriceResult(val)
}

/**
 * @param {string} result - Trasanction meta XDR
 * @returns {Price[]} - Array of price objects
 */
function parsePricesResult(result) {
    const val = getSorobanResultValue(result)?.value()
    if (val === undefined)
        return null
    const prices = []
    for (const priceResult of val)
        prices.push(parseXdrPriceResult(priceResult))
    return prices
}

/**
 * @param {string} result - Trasanction meta XDR
 * @returns {BigInt} - twap value
 */
function parseTwapResult(result) {
    const val = getSorobanResultValue(result)
    if (val === undefined)
        return null
    return scValToBigInt(val)
}

function buildTickerAssetScVal(tickerAsset) {
    return xdr.ScVal.scvMap([
        new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('asset'), val: buildAssetScVal(tickerAsset.asset)}),
        new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('source'), val: xdr.ScVal.scvString(tickerAsset.source)})
    ])
}

/**
 * @param {string} result - Trasanction meta XDR
 * @returns {number} - Number value
 */
function parseNumberResult(result) {
    const val = getSorobanResultValue(result)?.value()
    if (val === undefined)
        return null
    return Number(val)
}

/**
 * @param {string} result - Trasanction meta XDR
 * @returns {string} - Keypair public key
 */
function parseAdminResult(result) {
    const adminBuffer = getSorobanResultValue(result)?.value()?.value()?.value()
    if (adminBuffer === undefined)
        return null
    const adminPublicKey = new Keypair({type: 'ed25519', publicKey: adminBuffer})
    return adminPublicKey.publicKey()
}

function parseSubscriptionResult(result) {
    const val = getSorobanResultValue(result)?.value()
    if (val === undefined)
        return null
    return {
        id: Number(val[0].val()),
        asset1: parseAssetResultInternal(val[1].val()),
        asset2: parseAssetResultInternal(val[2].val()),
        heartbeat: Number(val[3].val()),
        owner: new Keypair({type: 'ed25519', publicKey: val[4].val().value()}).publicKey(),
        threshold: Number(val[5].val()),
        webhook: val[6].val(),
        last_notification: Number(val[7].val())
    }
}

module.exports = {
    buildAssetScVal,
    getSorobanResultValue,
    parseAssetResult,
    parseAssetsResult,
    parsePriceResult,
    parsePricesResult,
    parseTwapResult,
    buildTickerAssetScVal,
    parseNumberResult,
    parseAdminResult,
    parseSubscriptionResult
}