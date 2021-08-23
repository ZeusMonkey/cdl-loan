const BigNumber = require('bignumber.js')
const { deployProxy } = require('@openzeppelin/truffle-upgrades')
const { expectRevert, time } = require('@openzeppelin/test-helpers')
const CDL = artifacts.require('CDL')
const WETH9 = artifacts.require('WETH9')
const TestToken = artifacts.require('TestToken')
const TestCDLOracle = artifacts.require('TestCDLOracle')
const LiquidityProviders = artifacts.require('LiquidityProviders')
const empty = '0x0000000000000000000000000000000000000000'
let weth
let token
let developmentTreasury // It's just a contract that holds tokens
let cdl
let cdlOracle
let liquidityProviders
let liquidityProvidersETH

contract('LiquidityProviders', (accs) => {
  before(async () => {
    weth = await WETH9.new()
    liquidityProvidersETH = await deployProxy(LiquidityProviders, [
      empty,
      weth.address,
      weth.address,
    ])
    token = await deployProxy(TestToken, [18])
    liquidityProviders = await deployProxy(LiquidityProviders, [
      empty,
      token.address,
      weth.address,
    ])
    developmentTreasury = accs[1]
    cdlOracle = await deployProxy(TestCDLOracle)
    cdl = await deployProxy(
      CDL,
      [developmentTreasury, cdlOracle.address, weth.address],
      {
        unsafeAllowCustomTypes: true,
      },
    )
    await liquidityProviders.setCdlContract(cdl.address)
    await cdl.registerCollateralToken(token.address, liquidityProviders.address)
    await cdl.registerCollateralToken(
      weth.address,
      liquidityProvidersETH.address,
    )
  })

  it('should add and lock liquidity successfully', async () => {
    const amount = BigNumber(100e18)
    await expectRevert(
      liquidityProviders.lockLiquidity(0),
      'LiquidityProviders: Amount must be larger than zero',
    )
    await expectRevert(
      liquidityProviders.lockLiquidity(amount),
      'LiquidityProviders: You must approve the desired amount of liquidity tokens to this contract first',
    )
    await token.approve(liquidityProviders.address, amount)
    const latestTime = await time.latest()
    await liquidityProviders.lockLiquidity(amount)
    const amountLocked = await liquidityProviders.amountLocked(accs[0])
    const lockingTime = await liquidityProviders.lockingTime(accs[0])
    assert.ok(
      amount.eq(amountLocked),
      'The amount locked is not set up correctly',
    )
    assert.ok(
      lockingTime.gt(BigNumber(latestTime)),
      'The lockingTime must be greater than zero',
    )
  })

  it('should not lock ETH liquidity for non-eth liquidity providers', async () => {
    const amount = BigNumber(50e18)
    await expectRevert(
      liquidityProviders.lockLiquidityETH({ value: amount }),
      'LiquidityProviders: Not ETH LP',
    )
  })

  it('should add and lock ETH liquidity successfully', async () => {
    const amount = BigNumber(50e18)
    await expectRevert(
      liquidityProvidersETH.lockLiquidityETH({ value: 0 }),
      'LiquidityProviders: Amount must be larger than zero',
    )
    const latestTime = await time.latest()
    const oldLPBalance = BigNumber(
      await weth.balanceOf(liquidityProvidersETH.address),
    )
    await liquidityProvidersETH.lockLiquidityETH({ value: amount })
    const LPBalance = BigNumber(
      await weth.balanceOf(liquidityProvidersETH.address),
    )
    const amountLocked = await liquidityProvidersETH.amountLocked(accs[0])
    const lockingTime = await liquidityProvidersETH.lockingTime(accs[0])
    assert.ok(
      LPBalance.eq(oldLPBalance.plus(amount)),
      'Locked balance is incorrect',
    )
    assert.ok(
      amount.eq(amountLocked),
      'The amount locked is not set up correctly',
    )
    assert.ok(
      lockingTime.gt(BigNumber(latestTime)),
      'The lockingTime must be greater than zero',
    )
  })

  it('should drain repayment amount', async () => {
    await liquidityProviders.setCdlContract(accs[2])

    const amount = BigNumber(20e18)
    const oldCDLBalance = BigNumber(await token.balanceOf(accs[2]))
    const oldLPBalance = BigNumber(
      await token.balanceOf(liquidityProviders.address),
    )
    const oldAmountLocked = BigNumber(
      await liquidityProviders.amountLocked(accs[0]),
    )
    const oldTotalLocked = BigNumber(
      await liquidityProviders.totalLiquidityLocked(),
    )

    await liquidityProviders.takeRepayment(amount, accs[0], { from: accs[2] })

    const CDLBalance = BigNumber(await token.balanceOf(accs[2]))
    const LPBalance = BigNumber(
      await token.balanceOf(liquidityProviders.address),
    )

    assert.ok(
      amount.eq(CDLBalance.minus(oldCDLBalance)),
      'Taking repayment has been done incorrectly',
    )
    assert.ok(
      amount.eq(oldLPBalance.minus(LPBalance)),
      'Taking repayment has been done incorrectly',
    )

    const amountLocked = BigNumber(
      await liquidityProviders.amountLocked(accs[0]),
    )
    const totalLocked = BigNumber(
      await liquidityProviders.totalLiquidityLocked(),
    )
    assert.ok(
      amount.eq(oldAmountLocked.minus(amountLocked)),
      'Locked amount is incorrect',
    )
    assert.ok(
      amount.eq(oldTotalLocked.minus(totalLocked)),
      'Total amount is incorrect',
    )
  })
})
