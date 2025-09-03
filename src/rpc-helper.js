const {rpc, TransactionBuilder, Memo, BASE_FEE, Operation, Account} = require('@stellar/stellar-sdk')

/**
 * @callback RequestFn
 * @param {rpc.Server} server - Soroban RPC server
 * @returns {Promise<any>}
 */

/**
 * @typedef {import('./client-base')} ClientBase
 */

function getFactorOfValue(n) {
    const exponent = Math.floor(Math.log10(n))
    return Math.pow(10, exponent)
}

function roundValue(value) {
    if (value === 0)
        return value
    const factor = getFactorOfValue(value)
    return Math.floor(((value * 2) / factor)) * factor
}

/**
 * @param {rpc.Api.SimulateTransactionRestoreResponse} simulationResponse - simulation response
 * @param {Account} source - Account object
 * @param {any} txOptions - Transaction options
 * @returns {Transaction}
 */
function getRestoreTransaction(simulationResponse, source, txOptions) {
    //normalize fee
    let fee = parseInt(BASE_FEE, 10)
    fee += parseInt(simulationResponse.restorePreamble.minResourceFee, 10)
    txOptions.fee = roundValue(fee).toString()

    //build restore transaction
    const restoreTx = new TransactionBuilder(source, txOptions)
        .setSorobanData(simulationResponse.restorePreamble.transactionData.build())
        .addOperation(Operation.restoreFootprint({}))
        .build()
    return restoreTx
}

/**
 * @param {ClientBase} client - Oracle client instance
 * @param {Account} source - Account object
 * @param {xdr.Operation} operation - Stellar operation
 * @param {TxOptions} options - Transaction options
 * @returns {Promise<Transaction>}
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
    if (rpc.Api.isSimulationRestore(simulationResponse)) {
        console.info(`Simulation response is restore preamble. Contract ${client.contractId}. Building restore transaction.`)
        return getRestoreTransaction(simulationResponse, new Account(source.accountId(), source.sequence.toString()), txBuilderOptions)
    }

    //Round fee up to the nearest 1000 stroops to avoid differences between the nodes
    const rawFee = Number(simulationResponse.minResourceFee)
    if (isNaN(rawFee))
        throw new Error('Failed to get resource fee from the simulation response.')
    let resourceFee = BigInt(roundValue(rawFee))
    if (resourceFee < 10000000n)
        resourceFee = 10000000n

    const resources = simulationResponse.transactionData._data.resources()
    const [rawInstructions, rawReadBytes, rawWriteBytes] = [
        resources.instructions(),
        resources.diskReadBytes(),
        resources.writeBytes()
    ]
    const [instructions, readBytes, writeBytes] = [
        roundValue(rawInstructions),
        roundValue(rawReadBytes),
        roundValue(rawWriteBytes)
    ]

    simulationResponse.transactionData.setResourceFee(resourceFee)
    simulationResponse.minResourceFee = resourceFee.toString()
    simulationResponse.transactionData.setResources(instructions, readBytes, writeBytes)

    const tx = rpc.assembleTransaction(transaction, simulationResponse, client.network).build()
    console.debug(`Transaction ${tx.hash().toString('hex')} cost: {cpuInsns: ${rawInstructions}:${instructions}, readBytes: ${rawReadBytes}:${readBytes}, writeBytes: ${rawWriteBytes}:${writeBytes}, fee: ${rawFee}:${resourceFee.toString()}`)
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
            const server = new rpc.Server(rpcUrl, {allowHttp: true})
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
    throw new Error('Failed to make request.')
}

module.exports = {
    buildTransaction,
    makeServerRequest
}