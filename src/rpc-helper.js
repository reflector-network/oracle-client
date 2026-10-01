const {rpc, TransactionBuilder, Memo, Operation, Account} = require('@stellar/stellar-sdk')

/**
 * @callback RequestFn
 * @param {rpc.Server} server - Soroban RPC server
 * @returns {Promise<any>}
 */

/**
 * @typedef {import('./client-base')} ClientBase
 * @typedef {import('@stellar/stellar-sdk').SorobanDataBuilder} SorobanDataBuilder
 * @typedef {import('@stellar/stellar-sdk').Transaction} Transaction
 */

//a Soroban RPC that accepts the connection and never answers must count as a failure, so the next url is tried
const rpcTimeout = 15000

//quantisation grid for simulated resources; every node simulates on its own, and the declared values are signed,
//so the grid must be coarse relative to simulation jitter and independent of the value's magnitude
const instructionsStep = 10000000
const bytesStep = 8192
const feeStep = 1000000
//protocol limits per transaction; declaring more is rejected outright
const maxInstructions = 100000000
const maxDiskReadBytes = 204800
const maxWriteBytes = 132096
//historical floor, kept so typical updates pay the same fee as before
const minResourceFee = 10000000n

/**
 * Quantise a simulated resource value upward onto a fixed grid with one full step of slack.
 * @param {number} value - simulated value
 * @param {number} step - grid step
 * @param {number} max - protocol limit for the resource
 * @returns {number}
 */
function quantize(value, step, max) {
    if (!Number.isFinite(value) || value < 0)
        throw new Error(`Invalid resource value: ${value}`)
    return Math.min((Math.ceil(value / step) + 1) * step, max)
}

/**
 * @param {string|number} rawFee - minResourceFee reported by the simulation
 * @returns {bigint}
 */
function normalizeResourceFee(rawFee) {
    const fee = Number(rawFee)
    if (!Number.isFinite(fee) || fee < 0)
        throw new Error('Failed to get resource fee from the simulation response.')
    const quantized = BigInt((Math.ceil(fee / feeStep) + 1) * feeStep)
    return quantized > minResourceFee ? quantized : minResourceFee
}

/**
 * Apply the cross-node normalisation to simulated Soroban data. The invoke path and the restore path both go through
 * here so their transactions cannot drift apart.
 * @param {SorobanDataBuilder} transactionData - simulated soroban data, mutated in place
 * @param {string|number} rawFee - minResourceFee reported by the simulation
 * @returns {{sorobanData: xdr.SorobanTransactionData, resourceFee: bigint}}
 */
function normalizeSorobanData(transactionData, rawFee) {
    const resourceFee = normalizeResourceFee(rawFee)
    const {instructions, diskReadBytes, writeBytes} = transactionData.build().resources
    transactionData.setResources(
        quantize(instructions, instructionsStep, maxInstructions),
        quantize(diskReadBytes, bytesStep, maxDiskReadBytes),
        quantize(writeBytes, bytesStep, maxWriteBytes)
    )
    transactionData.setResourceFee(resourceFee)
    return {sorobanData: transactionData.build(), resourceFee}
}

/**
 * Build the footprint-restore transaction the simulation asked for instead of the requested invocation. The result is
 * marked with a non-enumerable `isRestore` so callers can tell it apart from the transaction they asked for.
 * @param {rpc.Api.SimulateTransactionRestoreResponse} simulationResponse - simulation response
 * @param {Account} source - Account object
 * @param {any} txOptions - Transaction options; `fee` is the classic per-operation fee, as on the invoke path
 * @returns {Transaction}
 */
function getRestoreTransaction(simulationResponse, source, txOptions) {
    const {restorePreamble} = simulationResponse
    const {sorobanData} = normalizeSorobanData(restorePreamble.transactionData, restorePreamble.minResourceFee)
    const restoreTx = new TransactionBuilder(source, txOptions)
        .setSorobanData(sorobanData)
        .addOperation(Operation.restoreFootprint({}))
        .build()
    Object.defineProperty(restoreTx, 'isRestore', {value: true, enumerable: false})
    return restoreTx
}

/**
 * @param {ClientBase} client - Oracle client instance
 * @param {Account} source - Account object
 * @param {xdr.Operation} operation - Stellar operation
 * @param {TxOptions} options - Transaction options
 * @returns {Promise<Transaction>} the requested transaction, or, when the simulation demanded a footprint restore first, a restore transaction flagged with `isRestore`
 */
async function buildTransaction(client, source, operation, options) {
    if (!options)
        throw new Error('options are required')

    const txBuilderOptions = structuredClone(options)
    txBuilderOptions.memo = options.memo ? Memo.text(options.memo) : null
    txBuilderOptions.networkPassphrase = client.network
    txBuilderOptions.timebounds = options.timebounds

    //keep original source account for the restore transaction
    const transaction = new TransactionBuilder(new Account(source.accountId(), source.sequence.toString()), txBuilderOptions)
        .addOperation(operation)
        .build()

    const request = async (server) => await server.simulateTransaction(transaction)

    /**@type {rpc.Api.SimulateTransactionSuccessResponse} */
    const simulationResponse = await makeServerRequest(client.sorobanRpcUrl, request)
    if (simulationResponse.error)
        throw new Error(simulationResponse.error)
    if (options.simulationOnly)
        return simulationResponse
    if (rpc.Api.isSimulationRestore(simulationResponse)) {
        console.info(`Simulation response is restore preamble. Contract ${client.contractId}. Building restore transaction.`)
        return getRestoreTransaction(simulationResponse, new Account(source.accountId(), source.sequence.toString()), txBuilderOptions)
    }

    //normalise resources and fee so every node declares the same values
    const raw = simulationResponse.transactionData.build().resources
    const rawFee = simulationResponse.minResourceFee
    const {sorobanData, resourceFee} = normalizeSorobanData(simulationResponse.transactionData, rawFee)

    const tx = rpc.assembleTransaction(transaction, simulationResponse).build()
    console.debug(`Transaction ${Buffer.from(tx.hash()).toString('hex')} cost: {cpuInsns: ${raw.instructions}:${sorobanData.resources.instructions}, readBytes: ${raw.diskReadBytes}:${sorobanData.resources.diskReadBytes}, writeBytes: ${raw.writeBytes}:${sorobanData.resources.writeBytes}, fee: ${rawFee}:${resourceFee.toString()}}`)
    return tx
}

/**
 * @param {string[]} rpcUrls - Soroban RPC server URLs
 * @param {RequestFn} requestFn - Request function
 * @returns {Promise<any>}
 */
async function makeServerRequest(rpcUrls, requestFn) {
    const errors = []
    for (const rpcUrl of rpcUrls) {
        try {
            const server = new rpc.Server(rpcUrl, {allowHttp: true, timeout: rpcTimeout})
            //sdk 17.0.1 forwards only the headers from the constructor options; the deadline has to live on the http client
            server.httpClient.defaults.timeout = rpcTimeout
            return await requestFn(server)
        } catch (e) {
            //if soroban rpc url failed, try next one
            console.debug(`Failed to build update. Soroban RPC url: ${rpcUrl}, error: ${e.message}`)
            errors.push(e)
        }
    }
    for (const e of errors) {
        console.error(e)
    }
    throw new Error('Failed to make request.', {cause: errors})
}

module.exports = {
    buildTransaction,
    makeServerRequest,
    normalizeSorobanData
}