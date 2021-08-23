const BigNumber = require('bignumber.js')
const { deployProxy } = require('@openzeppelin/truffle-upgrades')
const { time } = require('@openzeppelin/test-helpers')
const CDL = artifacts.require('CDL')
const WETH9 = artifacts.require('WETH9')
const TestToken = artifacts.require('TestToken')
const TestCDLOracle = artifacts.require('TestCDLOracle')
const LiquidityProviders = artifacts.require('LiquidityProviders')
const empty = '0x0000000000000000000000000000000000000000'
let weth
let tokens = []
let prices = [BigNumber(99e16), BigNumber(110e16)]
let ethPrice = BigNumber(150000e16)
let decimals = [18, 6] // decimals for dai and usdt
let developmentTreasury // It's just a contract that holds tokens
let cdl
let cdlOracle
let liquidityProviders = []
let collateralRatio = BigNumber(140)
let liquidityProvidersETH

const decimalBigNumber = (decimal) => {
  return BigNumber('10').pow(BigNumber(decimal))
}
contract('CDL with oracle', (accs) => {
  beforeEach(async () => {
    weth = await WETH9.new()
    liquidityProvidersETH = await deployProxy(LiquidityProviders, [
      empty,
      weth.address,
      weth.address,
    ])
    tokens = []
    tokens.push(await deployProxy(TestToken, [decimals[0]]))
    tokens.push(await deployProxy(TestToken, [decimals[1]]))
    developmentTreasury = accs[5]
    cdlOracle = await deployProxy(TestCDLOracle)
    cdl = await deployProxy(
      CDL,
      [developmentTreasury, cdlOracle.address, weth.address],
      {
        unsafeAllowCustomTypes: true,
      },
    )
    liquidityProviders = []
    await cdlOracle.setFakePrice(weth.address, ethPrice)
    for (let i = 0; i < tokens.length; i += 1) {
      await cdlOracle.setFakePrice(tokens[i].address, prices[i].toString())
      const liquidityProvider = await deployProxy(LiquidityProviders, [
        empty,
        tokens[i].address,
        weth.address,
      ])
      await liquidityProvider.setCdlContract(cdl.address)
      liquidityProviders.push(liquidityProvider)
      await cdl.registerCollateralToken(
        tokens[i].address,
        liquidityProvider.address,
      )
      await cdl.registerCollateralToken(
        weth.address,
        liquidityProvidersETH.address,
      )
    }

    let liquidityToAddForToken1 = BigNumber('5000').times(
      decimalBigNumber(decimals[1]),
    )
    await tokens[1].transfer(accs[3], liquidityToAddForToken1)
    await tokens[1].approve(
      liquidityProviders[1].address,
      liquidityToAddForToken1,
      {
        from: accs[3],
      },
    )
    await liquidityProviders[1].lockLiquidity(liquidityToAddForToken1, {
      from: accs[3],
    })
  })

  it('check total collaterals in USD', async () => {
    let amounts = [BigNumber('1000'), BigNumber('500')]
    let totalUSD = BigNumber(0)
    for (let i = 0; i < tokens.length; i += 1) {
      let amount = amounts[i].times(decimalBigNumber(decimals[i]))
      await tokens[i].approve(liquidityProviders[i].address, amount)
      await liquidityProviders[i].lockLiquidity(amount)
      const usdAmount = BigNumber(
        await cdl.usdAmountForToken(tokens[i].address, amount),
      )
      assert.ok(
        usdAmount.eq(
          amount.times(prices[i]).div(decimalBigNumber(decimals[i])),
        ),
        'USD amount is incorrect',
      )
      totalUSD = totalUSD.plus(
        amount.times(prices[i]).div(decimalBigNumber(decimals[i])),
      )
    }
    const totalUsdAmount = BigNumber(await cdl.totalCollateralInUSD(accs[0]))
    assert.ok(
      totalUsdAmount.eq(totalUSD),
      'Total USD collateral amount is incorrect',
    )
    const priceDecimals = BigNumber(await cdl.priceDecimals())
    assert.ok(priceDecimals.eq(BigNumber(18)), 'Price decimals is incorrect')
  })

  it('should generate loan when USD collateral is enough', async () => {
    let liquiditiesToAdd = [BigNumber('1500'), BigNumber('500')]
    let amount = BigNumber(700).times(decimalBigNumber(decimals[1]))
    for (let i = 0; i < tokens.length; i += 1) {
      let liqudityAmount = liquiditiesToAdd[i].times(
        decimalBigNumber(decimals[i]),
      )
      await tokens[i].approve(liquidityProviders[i].address, liqudityAmount)
      await liquidityProviders[i].lockLiquidity(liqudityAmount)
    }
    const userBalanceBeforeLoan = BigNumber(await tokens[1].balanceOf(accs[0]))
    const liquidityBeforeLoan = BigNumber(
      await tokens[1].balanceOf(liquidityProviders[1].address),
    )
    await cdl.generateLoan(tokens[1].address, amount, 3)
    const lastLoanId = await cdl.lastLoanId()
    await cdl.loansById(lastLoanId)
    const userBalanceAfterLoan = BigNumber(await tokens[1].balanceOf(accs[0]))
    const liquidityAfterLoan = BigNumber(
      await tokens[1].balanceOf(liquidityProviders[1].address),
    )
    const lastLoanIdInArray = await cdl.loanIds(lastLoanId - 1)
    assert.ok(
      lastLoanId.toString() === lastLoanIdInArray.toString(),
      'Last loanId is incorrect',
    )
    assert.ok(
      userBalanceBeforeLoan.plus(amount).eq(userBalanceAfterLoan),
      'User balance after the loan has not increased',
    )
    assert.ok(
      liquidityAfterLoan.plus(amount).eq(liquidityBeforeLoan),
      'Liquidity after the loan has not decreased',
    )
  })

  it('should call loan when USD collateral become lower due to price changes', async () => {
    let liquiditiesToAdd = [BigNumber('1500'), BigNumber('500')]
    let amount = BigNumber(700).times(decimalBigNumber(decimals[1]))
    const days = 20
    const lpRewardPercentageLoanCalled = BigNumber(
      await cdl.lpRewardPercentageLoanCalled(),
    )
    const devRewardPercentageLoanCalled = BigNumber(
      await cdl.devRewardPercentageLoanCalled(),
    )
    const lateRecallerRewardPercentage = BigNumber(
      await cdl.lateRecallerRewardPercentage(),
    )
    for (let i = 0; i < tokens.length; i += 1) {
      let liqudityAmount = liquiditiesToAdd[i].times(
        decimalBigNumber(decimals[i]),
      )
      await tokens[i].approve(liquidityProviders[i].address, liqudityAmount)
      await liquidityProviders[i].lockLiquidity(liqudityAmount)
    }
    await cdl.generateLoan(tokens[1].address, amount, days)
    const lastLoanId = await cdl.lastLoanId()
    const newPrice = BigNumber(99e15)
    await cdlOracle.setFakePrice(tokens[0].address, newPrice)

    let repayAmounts = [0, BigNumber(0)]
    let expectedLpReward = [0, 0]
    let expectedDevReward = [0, 0]
    let expectedRecallerReward = [0, 0]
    let lpContractBalance = [0, 0]
    let devTreasuryBalance = [0, 0]
    let callerBalance = [0, 0]

    repayAmounts[0] = liquiditiesToAdd[0].times(decimalBigNumber(decimals[0]))
    console.log(repayAmounts[0].toString())
    for (let i = 0; i < tokens.length; i += 1) {
      expectedLpReward[i] = repayAmounts[i]
        .times(lpRewardPercentageLoanCalled)
        .dividedToIntegerBy(1e18)
      expectedDevReward[i] = repayAmounts[i]
        .times(devRewardPercentageLoanCalled)
        .dividedToIntegerBy(1e18)
      expectedRecallerReward[i] = repayAmounts[i]
        .times(lateRecallerRewardPercentage)
        .dividedToIntegerBy(1e18)
      lpContractBalance[i] = BigNumber(
        await tokens[i].balanceOf(liquidityProviders[i].address),
      )
      devTreasuryBalance[i] = BigNumber(
        await tokens[i].balanceOf(await cdl.developmentTreasury()),
      )
      callerBalance[i] = BigNumber(await tokens[i].balanceOf(accs[3]))
    }
    await cdl.callLatePayment(lastLoanId, {
      from: accs[3],
    })

    const Token1CDLBalance = BigNumber(await tokens[1].balanceOf(cdl.address))
    assert.ok(Token1CDLBalance.isZero(), 'Token not distributed correctly')
    for (let i = 0; i < tokens.length; i += 1) {
      const lpContractBalance2 = BigNumber(
        await tokens[i].balanceOf(liquidityProviders[i].address),
      )
      const devTreasuryBalance2 = BigNumber(
        await tokens[i].balanceOf(await cdl.developmentTreasury()),
      )
      const callerBalance2 = BigNumber(await tokens[i].balanceOf(accs[3]))
      if (
        !devTreasuryBalance2.eq(
          devTreasuryBalance[i].plus(expectedDevReward[i]),
        )
      ) {
        console.log('----', i)
        console.log(devTreasuryBalance2.toString())
        console.log(devTreasuryBalance[i].toString())
        console.log(expectedDevReward[i].toString())
      }
      assert.ok(
        devTreasuryBalance2.eq(
          devTreasuryBalance[i].plus(expectedDevReward[i]),
        ),
        'The dev treasury balance is not correct',
      )
      assert.ok(
        lpContractBalance2.eq(
          lpContractBalance[i].plus(expectedLpReward[i]).minus(repayAmounts[i]),
        ),
        'The LP treasury balance is not correct',
      )
      assert.ok(
        callerBalance2.eq(callerBalance[i].plus(expectedRecallerReward[i])),
        'The loan recaller balance is not correct',
      )
    }
  })

  it('should call late loan', async () => {
    const repayTime = 2.506e6 // 29 days
    let liquiditiesToAdd = [BigNumber('1500'), BigNumber('500')]
    let amount = BigNumber(700).times(decimalBigNumber(decimals[1]))
    const days = 20
    const amountToRepay = amount.times(collateralRatio).div(100)

    const lpRewardPercentageLoanCalled = BigNumber(
      await cdl.lpRewardPercentageLoanCalled(),
    )
    const devRewardPercentageLoanCalled = BigNumber(
      await cdl.devRewardPercentageLoanCalled(),
    )
    const lateRecallerRewardPercentage = BigNumber(
      await cdl.lateRecallerRewardPercentage(),
    )
    for (let i = 0; i < tokens.length; i += 1) {
      let liqudityAmount = liquiditiesToAdd[i].times(
        decimalBigNumber(decimals[i]),
      )
      await tokens[i].approve(liquidityProviders[i].address, liqudityAmount)
      await liquidityProviders[i].lockLiquidity(liqudityAmount)
    }
    await cdl.generateLoan(tokens[1].address, amount, days)
    const lastLoanId = await cdl.lastLoanId()

    let repayAmounts = [0, BigNumber(0)]
    let expectedLpReward = [0, 0]
    let expectedDevReward = [0, 0]
    let expectedRecallerReward = [0, 0]
    let lpContractBalance = [0, 0]
    let devTreasuryBalance = [0, 0]
    let callerBalance = [0, 0]

    const repayUSDAmountForToken0 = amountToRepay
      .minus(repayAmounts[1])
      .times(prices[1])
      .dividedToIntegerBy(decimalBigNumber(decimals[1]))
    repayAmounts[0] = repayUSDAmountForToken0
      .times(decimalBigNumber(decimals[0]))
      .dividedToIntegerBy(prices[0])
    await time.increase(repayTime)
    for (let i = 0; i < tokens.length; i += 1) {
      expectedLpReward[i] = repayAmounts[i]
        .times(lpRewardPercentageLoanCalled)
        .dividedToIntegerBy(1e18)
      expectedDevReward[i] = repayAmounts[i]
        .times(devRewardPercentageLoanCalled)
        .dividedToIntegerBy(1e18)
      expectedRecallerReward[i] = repayAmounts[i]
        .times(lateRecallerRewardPercentage)
        .dividedToIntegerBy(1e18)
      lpContractBalance[i] = BigNumber(
        await tokens[i].balanceOf(liquidityProviders[i].address),
      )
      devTreasuryBalance[i] = BigNumber(
        await tokens[i].balanceOf(await cdl.developmentTreasury()),
      )
      callerBalance[i] = BigNumber(await tokens[i].balanceOf(accs[3]))
    }
    await cdl.callLatePayment(lastLoanId, {
      from: accs[3],
    })

    const Token1CDLBalance = BigNumber(await tokens[1].balanceOf(cdl.address))
    assert.ok(Token1CDLBalance.isZero(), 'Token not distributed correctly')
    for (let i = 0; i < tokens.length; i += 1) {
      const lpContractBalance2 = BigNumber(
        await tokens[i].balanceOf(liquidityProviders[i].address),
      )
      const devTreasuryBalance2 = BigNumber(
        await tokens[i].balanceOf(await cdl.developmentTreasury()),
      )
      const callerBalance2 = BigNumber(await tokens[i].balanceOf(accs[3]))
      assert.ok(
        devTreasuryBalance2.eq(
          devTreasuryBalance[i].plus(expectedDevReward[i]),
        ),
        'The dev treasury balance is not correct',
      )
      assert.ok(
        lpContractBalance2.eq(
          lpContractBalance[i].plus(expectedLpReward[i]).minus(repayAmounts[i]),
        ),
        'The LP treasury balance is not correct',
      )
      assert.ok(
        callerBalance2.eq(callerBalance[i].plus(expectedRecallerReward[i])),
        'The loan recaller balance is not correct',
      )
    }
  })
})
