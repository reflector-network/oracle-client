//live-network suites: they deploy contracts with the stellar cli against the rpc named in each example.contract.config.json
module.exports = {
    testMatch: ['<rootDir>/test/@(oracle|dao|subscriptions)/**/*.test.js'],
    testPathIgnorePatterns: ['/node_modules/']
}
