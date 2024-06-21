const {xdr, Address, scValToNative} = require('@stellar/stellar-sdk')
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

function buildTickerAssetScVal(tickerAsset) {
    return xdr.ScVal.scvMap([
        new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('asset'), val: buildAssetScVal(tickerAsset.asset)}),
        new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('source'), val: xdr.ScVal.scvString(tickerAsset.source)})
    ])
}

/**
 * @param {xdr.TransactionMeta} result - XDR result meta
 * @returns {any}
 */
function parseSorobanResult(result) {
    const value = result.value().sorobanMeta().returnValue()
    if (value.value() === false) //if footprint's data is different from the contract execution data, the result is false
        return undefined
    return scValToNative(value)
}

module.exports = {
    buildAssetScVal,
    parseSorobanResult,
    buildTickerAssetScVal
}