/*eslint-disable no-undef */
const {Keypair, Account, Operation, StrKey, Networks, SorobanDataBuilder, xdr} = require('@stellar/stellar-sdk')
const {buildTransaction, makeServerRequest} = require('../src/rpc-helper')

const mockServers = []
let mockSimulate = () => {
    throw new Error('mockSimulate is not configured')
}
jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk')
    class Server {
        constructor(url, options) {
            this.url = url
            this.options = options
            this.httpClient = {defaults: {}}
            mockServers.push(this)
        }

        simulateTransaction(transaction) {
            return mockSimulate(this.url, transaction)
        }
    }
    return {...actual, rpc: {...actual.rpc, Server}}
})

const network = Networks.TESTNET
const contractId = StrKey.encodeContract(Buffer.alloc(32, 1))
const admin = Keypair.random().publicKey()
const sourceId = Keypair.random().publicKey()

/**
 * @param {string[]} [urls] - rpc urls
 * @returns {{network: string, sorobanRpcUrl: string[], contractId: string}}
 */
function client(urls = ['http://rpc-a', 'http://rpc-b']) {
    return {network, sorobanRpcUrl: urls, contractId}
}

/**
 * @returns {Account} a fresh account so every build starts from the same sequence number
 */
function account() {
    return new Account(sourceId, '1')
}

/**
 * @returns {xdr.Operation}
 */
function invocation() {
    return Operation.invokeContractFunction({source: admin, contract: contractId, function: 'set_price', args: [xdr.ScVal.scvU32(1)]})
}

/**
 * @returns {{fee: number, networkPassphrase: string, timebounds: {minTime: number, maxTime: number}}}
 */
function txOptions() {
    return {fee: 1000, networkPassphrase: network, timebounds: {minTime: 0, maxTime: 1000}}
}

/**
 * @param {{instructions: number, readBytes: number, writeBytes: number, fee: number, minResourceFee: string}} resources - simulated values; `minResourceFee` overrides the string the RPC reports
 * @returns {object} an already parsed SimulateTransactionSuccessResponse
 */
function simulation(resources) {
    const transactionData = new SorobanDataBuilder()
        .setResources(resources.instructions, resources.readBytes, resources.writeBytes)
        .setResourceFee(resources.fee)
    return {
        _parsed: true,
        id: '1',
        latestLedger: 1,
        events: [],
        transactionData,
        minResourceFee: resources.minResourceFee ?? resources.fee.toString(),
        result: {auth: [], retval: xdr.ScVal.scvVoid()}
    }
}

/**
 * @param {{instructions: number, readBytes: number, writeBytes: number, fee: number}} resources - simulated values of the restore preamble
 * @returns {object} an already parsed SimulateTransactionRestoreResponse
 */
function restoreSimulation(resources) {
    const transactionData = new SorobanDataBuilder()
        .setResources(resources.instructions, resources.readBytes, resources.writeBytes)
        .setResourceFee(resources.fee)
    return {...simulation(resources), restorePreamble: {minResourceFee: resources.fee.toString(), transactionData}}
}

/**
 * @param {Transaction} tx - built soroban transaction
 * @returns {xdr.SorobanTransactionData}
 */
function sorobanData(tx) {
    return tx.toEnvelope().value.tx.ext.value
}

beforeAll(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => {})
    jest.spyOn(console, 'info').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
})

beforeEach(() => {
    mockServers.length = 0
})

describe('makeServerRequest', () => {
    test('every rpc server gets allowHttp and a 15 s deadline', async () => {
        await makeServerRequest(['http://rpc-a'], () => 'ok')
        expect(mockServers).toHaveLength(1)
        expect(mockServers[0].url).toBe('http://rpc-a')
        expect(mockServers[0].options).toEqual({allowHttp: true, timeout: 15000})
        expect(mockServers[0].httpClient.defaults.timeout).toBe(15000)
    })

    test('a failing url is skipped and the next one answers', async () => {
        const result = await makeServerRequest(['http://rpc-a', 'http://rpc-b'], server => {
            if (server.url === 'http://rpc-a')
                throw new Error('boom')
            return 'from-b'
        })
        expect(result).toBe('from-b')
        expect(mockServers.map(s => s.url)).toEqual(['http://rpc-a', 'http://rpc-b'])
    })

    test('when every url fails the error keeps the underlying errors as cause', async () => {
        const attempt = makeServerRequest(['http://rpc-a', 'http://rpc-b'], server => {
            throw new Error(`down: ${server.url}`)
        })
        await expect(attempt).rejects.toThrow('Failed to make request.')
        const error = await attempt.catch(e => e)
        expect(error.cause.map(e => e.message)).toEqual(['down: http://rpc-a', 'down: http://rpc-b'])
    })

    test('simulationOnly returns the simulation response untouched', async () => {
        mockSimulate = () => simulation({instructions: 1, readBytes: 2, writeBytes: 3, fee: 4})
        const response = await buildTransaction(client(), account(), invocation(), {...txOptions(), simulationOnly: true})
        expect(response.minResourceFee).toBe('4')
        expect(mockServers[0].httpClient.defaults.timeout).toBe(15000)
    })
})
