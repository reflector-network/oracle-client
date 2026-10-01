/*eslint-disable no-undef */
const {Keypair, Account, Operation, StrKey, Networks, SorobanDataBuilder, xdr} = require('@stellar/stellar-sdk')
const {buildTransaction, makeServerRequest, __resetUrlPreference} = require('../src/rpc-helper')

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
    //the preferred url is module state; without the reset a test that fails rpc-a reorders every later test
    __resetUrlPreference()
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

describe('resource normalisation', () => {
    const resources = {instructions: 25003000, readBytes: 1480, writeBytes: 1520, fee: 123456}

    test('resources and fee land on the fixed grid with one step of slack', async () => {
        mockSimulate = () => simulation(resources)
        const tx = await buildTransaction(client(), account(), invocation(), txOptions())
        const data = sorobanData(tx)
        expect(data.resources.instructions).toBe(40000000)
        expect(data.resources.diskReadBytes).toBe(16384)
        expect(data.resources.writeBytes).toBe(16384)
        expect(data.resourceFee).toBe(10000000n)
        expect(tx.fee).toBe('10001000')
        expect(tx.operations).toHaveLength(1)
        expect(tx.operations[0].type).toBe('invokeHostFunction')
    })

    test('simulations that differ by realistic jitter produce the same transaction', async () => {
        const build = async values => {
            mockSimulate = () => simulation(values)
            return (await buildTransaction(client(), account(), invocation(), txOptions())).toXDR()
        }
        const base = await build(resources)
        const jittered = await build({instructions: 25006000, readBytes: 1520, writeBytes: 1560, fee: 123956})
        expect(jittered).toBe(base)
    })

    test('the fee grid applies above the floor', async () => {
        mockSimulate = () => simulation({...resources, fee: 12345678})
        const tx = await buildTransaction(client(), account(), invocation(), txOptions())
        expect(sorobanData(tx).resourceFee).toBe(14000000n)
        expect(tx.fee).toBe('14001000')
    })

    test('resources are capped at the protocol limits', async () => {
        mockSimulate = () => simulation({instructions: 99000000, readBytes: 204000, writeBytes: 130000, fee: 1})
        const data = sorobanData(await buildTransaction(client(), account(), invocation(), txOptions()))
        expect(data.resources.instructions).toBe(100000000)
        expect(data.resources.diskReadBytes).toBe(204800)
        expect(data.resources.writeBytes).toBe(132096)
    })

    test('a simulation without a numeric fee is rejected', async () => {
        mockSimulate = () => simulation({...resources, minResourceFee: 'abc'})
        await expect(buildTransaction(client(), account(), invocation(), txOptions()))
            .rejects.toThrow('Failed to get resource fee from the simulation response.')
    })

    test('normalizeSorobanData rejects negative and non-finite resources', () => {
        //the sdk validates ranges at construction, so a builder-shaped stub carries the bad value
        const {normalizeSorobanData} = require('../src/rpc-helper')
        const broken = {
            build: () => ({resources: {instructions: -1, diskReadBytes: 0, writeBytes: 0}}),
            setResources: () => broken,
            setResourceFee: () => broken
        }
        expect(() => normalizeSorobanData(broken, '1')).toThrow('Invalid resource value: -1')
    })
})

describe('restore transactions', () => {
    const resources = {instructions: 25003000, readBytes: 1480, writeBytes: 1520, fee: 123456}

    test('a restore preamble yields a flagged, normalised restore transaction', async () => {
        mockSimulate = () => restoreSimulation(resources)
        const tx = await buildTransaction(client(), account(), invocation(), txOptions())
        expect(tx.isRestore).toBe(true)
        expect(Object.keys(tx)).not.toContain('isRestore')
        expect(tx.operations).toHaveLength(1)
        expect(tx.operations[0].type).toBe('restoreFootprint')
        const data = sorobanData(tx)
        expect(data.resources.instructions).toBe(40000000)
        expect(data.resources.diskReadBytes).toBe(16384)
        expect(data.resources.writeBytes).toBe(16384)
        expect(data.resourceFee).toBe(10000000n)
        expect(tx.fee).toBe('10001000')
    })

    test('restore simulations that differ by jitter produce the same transaction', async () => {
        const build = async values => {
            mockSimulate = () => restoreSimulation(values)
            return (await buildTransaction(client(), account(), invocation(), txOptions())).toXDR()
        }
        const base = await build(resources)
        const jittered = await build({instructions: 25006000, readBytes: 1520, writeBytes: 1560, fee: 123956})
        expect(jittered).toBe(base)
    })

    test('the requested transaction carries no restore flag', async () => {
        mockSimulate = () => simulation(resources)
        const tx = await buildTransaction(client(), account(), invocation(), txOptions())
        expect(tx.isRestore).toBeUndefined()
    })
})

describe('the rpc url that answered last is tried first', () => {
    /**
     * @param {Set<string>} failing - urls that throw
     * @returns {function} request function recording nothing itself; mockServers records the order
     */
    const requestThrough = failing => server => {
        if (failing.has(server.url))
            throw new Error(`down: ${server.url}`)
        return server.url
    }

    test('a failing first url costs one request, not one per request', async () => {
        const failing = new Set(['http://rpc-a'])
        await makeServerRequest(['http://rpc-a', 'http://rpc-b'], requestThrough(failing))
        await makeServerRequest(['http://rpc-a', 'http://rpc-b'], requestThrough(failing))
        expect(mockServers.map(s => s.url)).toEqual(['http://rpc-a', 'http://rpc-b', 'http://rpc-b'])
    })

    test('when the remembered url fails, the others are tried in configured order', async () => {
        const urls = ['http://rpc-a', 'http://rpc-b', 'http://rpc-c']
        await makeServerRequest(urls, requestThrough(new Set(['http://rpc-a'])))
        mockServers.length = 0

        const answered = await makeServerRequest(urls, requestThrough(new Set(['http://rpc-b'])))

        expect(answered).toBe('http://rpc-a')
        expect(mockServers.map(s => s.url)).toEqual(['http://rpc-b', 'http://rpc-a'])
    })

    test('a build simulates on the remembered url first', async () => {
        await makeServerRequest(['http://rpc-a', 'http://rpc-b'], requestThrough(new Set(['http://rpc-a'])))
        mockServers.length = 0
        mockSimulate = () => simulation({instructions: 1, readBytes: 2, writeBytes: 3, fee: 4})

        await buildTransaction(client(), account(), invocation(), {...txOptions(), simulationOnly: true})

        expect(mockServers.map(s => s.url)).toEqual(['http://rpc-b'])
    })

    test('a preference is dropped ten minutes after it was set, so the first url is tried again', async () => {
        const urls = ['http://rpc-a', 'http://rpc-b']
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
        try {
            await makeServerRequest(urls, requestThrough(new Set(['http://rpc-a'])))
            now.mockReturnValue(1_000_000 + 10 * 60 * 1000 - 1)
            await makeServerRequest(urls, requestThrough(new Set()))
            now.mockReturnValue(1_000_000 + 10 * 60 * 1000)
            await makeServerRequest(urls, requestThrough(new Set()))
        } finally {
            now.mockRestore()
        }
        expect(mockServers.map(s => s.url)).toEqual(['http://rpc-a', 'http://rpc-b', 'http://rpc-b', 'http://rpc-a'])
    })

    test('once a preference expires, a first url that still fails costs one more request, not one per request', async () => {
        const urls = ['http://rpc-a', 'http://rpc-b']
        const failing = new Set(['http://rpc-a'])
        const now = jest.spyOn(Date, 'now').mockReturnValue(2_000_000)
        try {
            await makeServerRequest(urls, requestThrough(failing))
            now.mockReturnValue(2_000_000 + 10 * 60 * 1000)
            await makeServerRequest(urls, requestThrough(failing))
            now.mockReturnValue(2_000_000 + 10 * 60 * 1000 + 1)
            await makeServerRequest(urls, requestThrough(failing))
        } finally {
            now.mockRestore()
        }
        expect(mockServers.map(s => s.url)).toEqual([
            'http://rpc-a', 'http://rpc-b', //the preference is set
            'http://rpc-a', 'http://rpc-b', //it has expired: configured order, a fresh preference
            'http://rpc-b' //the fresh preference holds
        ])
    })

    test('a preference is not extended while the same url keeps answering', async () => {
        const urls = ['http://rpc-a', 'http://rpc-b']
        const now = jest.spyOn(Date, 'now').mockReturnValue(3_000_000)
        try {
            await makeServerRequest(urls, requestThrough(new Set(['http://rpc-a'])))
            for (const offset of [1, 5 * 60 * 1000, 10 * 60 * 1000 - 1]) {
                now.mockReturnValue(3_000_000 + offset)
                await makeServerRequest(urls, requestThrough(new Set()))
            }
            now.mockReturnValue(3_000_000 + 10 * 60 * 1000)
            await makeServerRequest(urls, requestThrough(new Set()))
        } finally {
            now.mockRestore()
        }
        expect(mockServers.map(s => s.url)).toEqual([
            'http://rpc-a', 'http://rpc-b',
            'http://rpc-b', 'http://rpc-b', 'http://rpc-b',
            'http://rpc-a'
        ])
    })

    test('each configured url list keeps its own preference', async () => {
        const listX = ['http://x1', 'http://x2']
        const listY = ['http://y1', 'http://y2']
        const failing = new Set(['http://x1'])

        await makeServerRequest(listX, requestThrough(failing))
        await makeServerRequest(listY, requestThrough(failing))
        await makeServerRequest(listX, requestThrough(failing))

        expect(mockServers.map(s => s.url)).toEqual(['http://x1', 'http://x2', 'http://y1', 'http://x2'])
    })

    test('the answer is returned as the request function produced it', async () => {
        await makeServerRequest(['http://rpc-a', 'http://rpc-b'], requestThrough(new Set(['http://rpc-a'])))
        const answer = {id: 'answer'}

        await expect(makeServerRequest(['http://rpc-a', 'http://rpc-b'], () => answer)).resolves.toBe(answer)
    })
})

describe('a url list given as a Set or a string is accepted', () => {
    /**
     * @param {Set<string>} failing - urls that throw
     * @returns {function} request function recording nothing itself; mockServers records the order
     */
    const requestThrough = failing => server => {
        if (failing.has(server.url))
            throw new Error(`down: ${server.url}`)
        return server.url
    }

    test('a Set of urls fails over like an array', async () => {
        const urls = new Set(['http://set-a', 'http://set-b'])
        await makeServerRequest(urls, requestThrough(new Set(['http://set-a'])))
        mockServers.length = 0

        await makeServerRequest(urls, requestThrough(new Set()))

        expect(mockServers.map(s => s.url)).toEqual(['http://set-b'])
    })

    test('a single url given as a string is treated as a one-element list', async () => {
        const result = await makeServerRequest('http://string-only', server => server.url)

        expect(result).toBe('http://string-only')
        expect(mockServers.map(s => s.url)).toEqual(['http://string-only'])
    })
})

describe('a failed request fails as it did before the preference', () => {
    /**
     * @param {Set<string>} failing - urls that throw
     * @returns {function} request function answering with the url of every server not in `failing`
     */
    const requestThrough = failing => server => {
        if (failing.has(server.url))
            throw new Error(`down: ${server.url}`)
        return server.url
    }

    test('with a preference in place every url is still tried once and every error is kept', async () => {
        const urls = ['http://rpc-a', 'http://rpc-b', 'http://rpc-c']
        await makeServerRequest(urls, requestThrough(new Set(['http://rpc-a'])))
        mockServers.length = 0
        console.error.mockClear()

        const error = await makeServerRequest(urls, requestThrough(new Set(urls))).catch(e => e)

        expect(error).toBeInstanceOf(Error)
        expect(error.message).toBe('Failed to make request.')
        expect(mockServers.map(s => s.url)).toEqual(['http://rpc-b', 'http://rpc-a', 'http://rpc-c'])
        expect(error.cause.map(e => e.message)).toEqual(['down: http://rpc-b', 'down: http://rpc-a', 'down: http://rpc-c'])
        expect(console.error).toHaveBeenCalledTimes(3)
    })

    test('a url listed twice is still asked twice when it is the preferred one', async () => {
        const urls = ['http://rpc-a', 'http://rpc-b', 'http://rpc-a']
        await makeServerRequest(urls, requestThrough(new Set()))
        mockServers.length = 0

        const error = await makeServerRequest(urls, requestThrough(new Set(urls))).catch(e => e)

        expect(error.message).toBe('Failed to make request.')
        expect(mockServers.map(s => s.url)).toEqual(urls)
        expect(error.cause).toHaveLength(3)
    })

    test('only the first occurrence of a preferred url listed twice moves to the front', async () => {
        const urls = ['http://rpc-a', 'http://rpc-b', 'http://rpc-c', 'http://rpc-b']
        await makeServerRequest(urls, requestThrough(new Set(['http://rpc-a'])))
        mockServers.length = 0

        const error = await makeServerRequest(urls, requestThrough(new Set(urls))).catch(e => e)

        expect(error.message).toBe('Failed to make request.')
        expect(mockServers.map(s => s.url)).toEqual(['http://rpc-b', 'http://rpc-a', 'http://rpc-c', 'http://rpc-b'])
        expect(error.cause).toHaveLength(4)
    })

    test('a failed request leaves the preference as it was', async () => {
        const urls = ['http://rpc-a', 'http://rpc-b']
        await makeServerRequest(urls, requestThrough(new Set(['http://rpc-a'])))
        await expect(makeServerRequest(urls, requestThrough(new Set(urls)))).rejects.toThrow('Failed to make request.')
        mockServers.length = 0

        await makeServerRequest(urls, requestThrough(new Set()))

        expect(mockServers.map(s => s.url)).toEqual(['http://rpc-b'])
    })

    test('an empty url list still fails without a request', async () => {
        const error = await makeServerRequest([], requestThrough(new Set())).catch(e => e)

        expect(error.message).toBe('Failed to make request.')
        expect(error.cause).toEqual([])
        expect(mockServers).toHaveLength(0)
    })
})

describe('remembered url lists stay bounded', () => {
    /**
     * Sets a preference for the second url of a fresh list
     * @param {string} name - list name
     * @returns {Promise<string[]>} the list
     */
    async function preferSecond(name) {
        const urls = [`http://${name}-1`, `http://${name}-2`]
        await makeServerRequest(urls, server => {
            if (server.url === urls[0])
                throw new Error(`down: ${server.url}`)
            return server.url
        })
        return urls
    }

    test('the seventeenth list evicts the list that answered longest ago', async () => {
        const oldest = await preferSecond('lru-old')
        const second = await preferSecond('lru-second')
        for (let i = 0; i < 15; i++)
            await preferSecond(`lru-fill-${i}`)
        mockServers.length = 0

        //the second list first: the oldest one answering would be remembered again and push the second one out
        await makeServerRequest(second, server => server.url)
        await makeServerRequest(oldest, server => server.url)

        //the second list kept its preference; the oldest one lost it and starts again at its first url
        expect(mockServers.map(s => s.url)).toEqual(['http://lru-second-2', 'http://lru-old-1'])
    })

    test('a list that answers again becomes the most recent one', async () => {
        const kept = await preferSecond('mru-kept')
        const evicted = await preferSecond('mru-evicted')
        for (let i = 0; i < 14; i++)
            await preferSecond(`mru-fill-${i}`)
        await makeServerRequest(kept, server => server.url)
        await preferSecond('mru-last')
        mockServers.length = 0

        await makeServerRequest(evicted, server => server.url)
        await makeServerRequest(kept, server => server.url)

        expect(mockServers.map(s => s.url)).toEqual(['http://mru-evicted-1', 'http://mru-kept-2'])
    })

    test('a preferred url that is not in the list asked for is never requested', async () => {
        //the key joins the urls with a line break, so these two lists share one key
        await preferSecond('collide')
        const joined = ['http://collide-1\nhttp://collide-2']
        mockServers.length = 0

        await makeServerRequest(joined, server => server.url)

        expect(mockServers.map(s => s.url)).toEqual(joined)
    })

    test('an expired preference is dropped even when its preferred url is already first, so eviction targets the right list', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
        try {
            //M: first url fails, second succeeds - the preference this test protects
            const mUrls = ['http://t16-m-1', 'http://t16-m-2']
            await makeServerRequest(mUrls, server => {
                if (server.url === mUrls[0])
                    throw new Error('down')
                return server.url
            })

            //L: its first url succeeds outright, so the preferred url is already first (index 0), timestamped
            //long before the ttl so it reads as expired against the "now" used below
            now.mockReturnValue(0)
            const lUrls = ['http://t16-l-1', 'http://t16-l-2']
            await makeServerRequest(lUrls, server => server.url)
            now.mockReturnValue(1_000_000)

            //14 more lists bring the map to its 16-list capacity without touching M or L again
            for (let i = 0; i < 14; i++)
                await makeServerRequest([`http://t16-fill-${i}`], server => server.url)

            //L's preference has expired. The original deletes it even though its preferred url is already
            //first; a mutant that only deletes when index > 0 keeps a dead entry instead
            const error = await makeServerRequest(lUrls, server => {
                throw new Error(`down: ${server.url}`)
            }).catch(e => e)
            expect(error.message).toBe('Failed to make request.')

            //a new, 17th list: with L's dead entry gone the map is back at 16, so nothing is evicted; with
            //it still there, this overflows the map and evicts the oldest live entry - M's
            await makeServerRequest(['http://t16-n'], server => server.url)

            mockServers.length = 0
            await makeServerRequest(mUrls, server => server.url)
        } finally {
            now.mockRestore()
        }
        //M's preference survives and is tried first; a mutant that kept L's dead entry evicts M instead,
        //so this list falls back to configured order and asks m-1 first
        expect(mockServers.map(s => s.url)).toEqual(['http://t16-m-2'])
    })
})

describe('__resetUrlPreference', () => {
    test('forgets every remembered url', async () => {
        const urls = ['http://rpc-a', 'http://rpc-b']
        await makeServerRequest(urls, server => {
            if (server.url === 'http://rpc-a')
                throw new Error('down')
            return server.url
        })
        __resetUrlPreference()
        mockServers.length = 0

        await makeServerRequest(urls, server => server.url)

        expect(mockServers.map(s => s.url)).toEqual(['http://rpc-a'])
    })
})
