const LiquidityProviders = artifacts.require('LiquidityProviders')
const CDL = artifacts.require('CDL')
const CDLOracle = artifacts.require('CDLOracle')
const { deployProxy } = require('@openzeppelin/truffle-upgrades')
const rinkebyDAI = '0x5592ec0cfb4dbc12d3ab100b257153436a1f0fea'
const empty = '0x0000000000000000000000000000000000000000'

// Deployed Rinkeby
// Liq -> 0x9E3f6EdF8872501ceab37C7A213351715681FcD4
// CDL -> 0xC165A566F76ab3815d96132159866DDb9135D330
// WETH -> 0xc778417e063141139fce010982780140aa0cd5ab
// ETH / USD price feed -> 0x8A753747A1Fa494EC906cE90E9f37563A8AF630e

module.exports = async (deployer, networks, accounts) => {
  const weth = '0xc778417e063141139fce010982780140aa0cd5ab'
  const liq = await deployProxy(LiquidityProviders, [empty, rinkebyDAI, weth], {
    deployer,
    initializer: 'initialize',
    unsafeAllowCustomTypes: true,
  })
  console.log('Liq provider', liq.address)

  const cdlOracle = await deployProxy(
    CDLOracle,
    [weth, '0x8A753747A1Fa494EC906cE90E9f37563A8AF630e'],
    {
      deployer,
      initializer: 'initialize',
      unsafeAllowCustomTypes: true,
    },
  )
  const cdlContract = await deployProxy(
    CDL,
    [accounts[0], cdlOracle.address, weth],
    {
      deployer,
      initializer: 'initialize',
      unsafeAllowCustomTypes: true,
    },
  )
  await cdlContract.registerCollateralToken(rinkebyDAI, liq.address)

  console.log('CDL', cdlContract.address)
  await liq.setCdlContract(cdlContract.address)
}
