const BigNumber = require('bignumber.js')
const { deployProxy } = require('@openzeppelin/truffle-upgrades')
const {
  expectRevert,
  expectEvent,
  time,
} = require('@openzeppelin/test-helpers')
const CDL = artifacts.require('CDL')
const WETH9 = artifacts.require('WETH9')
const TestToken = artifacts.require('TestToken')
const TestCDLOracle = artifacts.require('TestCDLOracle')
const LiquidityProviders = artifacts.require('LiquidityProviders')
const empty = '0x0000000000000000000000000000000000000000'
let weth
let ethPrice = BigNumber(150000e16)
let token
let tokenPrice = BigNumber(1e18)
let developmentTreasury // It's just a contract that holds tokens
let cdl
let cdlOracle
let liquidityProviders
let collateralRatio = BigNumber(140)
let liqudityLockDuration = 365 * 86400
let liquidityProvidersETH

contract('CDL', (accs) => {
  const getGas = async (receipt) => {
    const gasUsed = BigNumber(receipt.receipt.gasUsed)
    const tx = await web3.eth.getTransaction(receipt.tx)
    const gasPrice = BigNumber(tx.gasPrice)
    return gasUsed.times(gasPrice)
  }
  beforeEach(async () => {
    developmentTreasury = accs[1]
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
    cdlOracle = await deployProxy(TestCDLOracle)
    cdl = await deployProxy(
      CDL,
      [developmentTreasury, cdlOracle.address, weth.address],
      {
        unsafeAllowCustomTypes: true,
      },
    )
    await cdlOracle.setFakePrice(token.address, tokenPrice)
    await cdlOracle.setFakePrice(weth.address, ethPrice)
    await liquidityProviders.setCdlContract(cdl.address)
    await liquidityProvidersETH.setCdlContract(cdl.address)
    await cdl.registerCollateralToken(token.address, liquidityProviders.address)
    await cdl.registerCollateralToken(
      weth.address,
      liquidityProvidersETH.address,
    )
  })

  it('should not generate a 0 amount loan', async () => {
    const liquidityToAdd = BigNumber(5000e18)

    await token.approve(liquidityProviders.address, liquidityToAdd)
    await liquidityProviders.lockLiquidity(liquidityToAdd)

    await expectRevert(
      cdl.generateLoan(token.address, 0, 3),
      'CDL: The loan must be larger than zero tokens',
    )
  })

  it('should not generate a 0 days loan', async () => {
    const liquidityToAdd = BigNumber(5000e18)
    const amount = BigNumber(1000e18)

    await token.approve(liquidityProviders.address, liquidityToAdd)
    await liquidityProviders.lockLiquidity(liquidityToAdd)

    await expectRevert(
      cdl.generateLoan(token.address, amount, 0),
      'CDL: The days to repay the loan must be larger than zero',
    )
  })

  it('should not generate a 31 day loan', async () => {
    const liquidityToAdd = BigNumber(5000e18)
    const amount = BigNumber(1000e18)

    await token.approve(liquidityProviders.address, liquidityToAdd)
    await liquidityProviders.lockLiquidity(liquidityToAdd)

    await expectRevert(
      cdl.generateLoan(token.address, amount, 31),
      "CDL: The time to repay the loan can't exceed the max time limit",
    )
  })

  it('should not generate loan with bigger amount than liquidity', async () => {
    const liquidityToAdd = BigNumber(3000e18)
    const amount = BigNumber(4000e18)

    await token.approve(liquidityProviders.address, liquidityToAdd)
    await liquidityProviders.lockLiquidity(liquidityToAdd)
    await expectRevert(
      cdl.generateLoan(token.address, amount, 3),
      'CDL: Not enough liquidity to generate this loan',
    )
  })

  it('should not generate loan when collateral is less than 140% of loan amount', async () => {
    const liquidityToAdd = BigNumber(5000e18)
    const amount = BigNumber(4000e18)

    await token.approve(liquidityProviders.address, liquidityToAdd)
    await liquidityProviders.lockLiquidity(liquidityToAdd)

    await expectRevert(
      cdl.generateLoan(token.address, amount, 3),
      "CDL: Your combined collateral and Crypto Score isn't enough to get this loan",
    )
  })

  it('should generate a 3 day loan successfully', async () => {
    const liquidityToAdd = BigNumber(5000e18)
    const amount = BigNumber(100e18)

    await token.approve(liquidityProviders.address, liquidityToAdd)
    await liquidityProviders.lockLiquidity(liquidityToAdd)

    const userBalanceBeforeLoan = BigNumber(await token.balanceOf(accs[0]))
    const liquidityBeforeLoan = BigNumber(
      await token.balanceOf(liquidityProviders.address),
    )
    await cdl.generateLoan(token.address, amount, 3)
    const lastLoanId = await cdl.lastLoanId()
    const loan = await cdl.loansById(lastLoanId)
    const userBalanceAfterLoan = BigNumber(await token.balanceOf(accs[0]))
    const liquidityAfterLoan = BigNumber(
      await token.balanceOf(liquidityProviders.address),
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
    assert.ok(loan.owner == accs[0], 'The loan owner is incorrect')
    assert.ok(
      loan.id.toString() == lastLoanId.toString(),
      'The loan id is incorrect',
    )
    assert.ok(
      loan.token == token.address,
      'The loan token has not stored correctly',
    )
    assert.ok(
      loan.amount.toString() == amount.toString(),
      'The loan amount is incorrect',
    )
    assert.ok(loan.state == 1, 'The loan state is invalid')
    const totalFundsLent = BigNumber(await cdl.totalFundsLent(token.address))
    const activeFundsLent = BigNumber(await cdl.activeFundsLent(token.address))
    const userActiveFundsLent = BigNumber(
      await cdl.userActiveFundsLent(token.address, accs[0]),
    )
    assert.ok(totalFundsLent.eq(amount), 'Total funds lent is incorrect')
    assert.ok(activeFundsLent.eq(amount), 'Active funds lent is incorrect')
    assert.ok(
      userActiveFundsLent.eq(amount),
      'User active funds lent is incorrect',
    )
    const lockedCollateral = BigNumber(
      await cdl.lockedCollateral(token.address, accs[0]),
    )
    assert.ok(
      lockedCollateral.eq(amount.times(collateralRatio).div(100)),
      'Locked collateral is incorrect',
    )

    const userActiveFundsLentInUSD = BigNumber(
      await cdl.userActiveFundsLentInUSD(accs[0]),
    )
    assert.ok(
      userActiveFundsLentInUSD.eq(
        amount.times(tokenPrice).div(BigNumber(1e18)),
      ),
      'User active funds lent in USD is incorrect',
    )
    const userLockedCollateralInUSD = BigNumber(
      await cdl.userLockedCollateralInUSD(accs[0]),
    )
    assert.ok(
      userLockedCollateralInUSD.eq(
        amount
          .times(tokenPrice)
          .div(BigNumber(1e18))
          .times(collateralRatio)
          .div(100),
      ),
      'User locked collateral in USD is incorrect',
    )
    const activeFundsLentInUSD = BigNumber(await cdl.activeFundsLentInUSD())
    assert.ok(
      activeFundsLentInUSD.eq(amount.times(tokenPrice).div(BigNumber(1e18))),
      'Active funds lent in USD is incorrect',
    )
    const totalLockedCollateralInUSD = BigNumber(
      await cdl.totalLockedCollateralInUSD(),
    )
    assert.ok(
      totalLockedCollateralInUSD.eq(
        amount
          .times(tokenPrice)
          .div(BigNumber(1e18))
          .times(collateralRatio)
          .div(100),
      ),
      'Total locked collateral in USD is incorrect',
    )
    // expectEvent(receipt, 'LoanCreated', { sender: accs[0], token: token.address, amount: amount.toString() });
  })

  it('should generate a 3 day ETH loan successfully', async () => {
    const liquidityToAdd = BigNumber(20e18)
    const amount = BigNumber(5e18)

    await liquidityProvidersETH.lockLiquidityETH({ value: liquidityToAdd })

    const userBalanceBeforeLoan = BigNumber(await web3.eth.getBalance(accs[0]))
    const liquidityBeforeLoan = BigNumber(
      await weth.balanceOf(liquidityProvidersETH.address),
    )
    const receipt = await cdl.generateLoanETH(amount, 3)
    let gasUsed = await getGas(receipt)
    const lastLoanId = await cdl.lastLoanId()
    const loan = await cdl.loansById(lastLoanId)
    const userBalanceAfterLoan = BigNumber(await web3.eth.getBalance(accs[0]))
    const liquidityAfterLoan = BigNumber(
      await weth.balanceOf(liquidityProvidersETH.address),
    )
    const lastLoanIdInArray = await cdl.loanIds(lastLoanId - 1)
    assert.ok(
      lastLoanId.toString() === lastLoanIdInArray.toString(),
      'Last loanId is incorrect',
    )
    assert.ok(
      userBalanceBeforeLoan
        .plus(amount)
        .minus(gasUsed)
        .eq(userBalanceAfterLoan),
      'User balance after the loan has not increased',
    )
    assert.ok(
      liquidityAfterLoan.plus(amount).eq(liquidityBeforeLoan),
      'Liquidity after the loan has not decreased',
    )
    assert.ok(loan.owner == accs[0], 'The loan owner is incorrect')
    assert.ok(
      loan.id.toString() == lastLoanId.toString(),
      'The loan id is incorrect',
    )
    assert.ok(
      loan.token == weth.address,
      'The loan token has not stored correctly',
    )
    assert.ok(
      loan.amount.toString() == amount.toString(),
      'The loan amount is incorrect',
    )
    assert.ok(loan.state == 1, 'The loan state is invalid')
    const totalFundsLent = BigNumber(await cdl.totalFundsLent(weth.address))
    const activeFundsLent = BigNumber(await cdl.activeFundsLent(weth.address))
    const userActiveFundsLent = BigNumber(
      await cdl.userActiveFundsLent(weth.address, accs[0]),
    )
    assert.ok(totalFundsLent.eq(amount), 'Total funds lent is incorrect')
    assert.ok(activeFundsLent.eq(amount), 'Active funds lent is incorrect')
    assert.ok(
      userActiveFundsLent.eq(amount),
      'User active funds lent is incorrect',
    )
    const lockedCollateral = BigNumber(
      await cdl.lockedCollateral(weth.address, accs[0]),
    )
    assert.ok(
      lockedCollateral.eq(amount.times(collateralRatio).div(100)),
      'Locked collateral is incorrect',
    )

    const userActiveFundsLentInUSD = BigNumber(
      await cdl.userActiveFundsLentInUSD(accs[0]),
    )
    assert.ok(
      userActiveFundsLentInUSD.eq(amount.times(ethPrice).div(BigNumber(1e18))),
      'User active funds lent in USD is incorrect',
    )
    const userLockedCollateralInUSD = BigNumber(
      await cdl.userLockedCollateralInUSD(accs[0]),
    )
    assert.ok(
      userLockedCollateralInUSD.eq(
        amount
          .times(ethPrice)
          .div(BigNumber(1e18))
          .times(collateralRatio)
          .div(100),
      ),
      'User locked collateral in USD is incorrect',
    )
    const activeFundsLentInUSD = BigNumber(await cdl.activeFundsLentInUSD())
    assert.ok(
      activeFundsLentInUSD.eq(amount.times(ethPrice).div(BigNumber(1e18))),
      'Active funds lent in USD is incorrect',
    )
    const totalLockedCollateralInUSD = BigNumber(
      await cdl.totalLockedCollateralInUSD(),
    )
    assert.ok(
      totalLockedCollateralInUSD.eq(
        amount
          .times(ethPrice)
          .div(BigNumber(1e18))
          .times(collateralRatio)
          .div(100),
      ),
      'Total locked collateral in USD is incorrect',
    )
    // expectEvent(receipt, 'LoanCreated', { sender: accs[0], token: token.address, amount: amount.toString() });
  })

  it('should repay a 3 day loan successfully before the time has passed', async () => {
    const liquidityToAdd = BigNumber(5000e18)
    const amount = BigNumber(100e18)

    await token.approve(liquidityProviders.address, liquidityToAdd)
    await liquidityProviders.lockLiquidity(liquidityToAdd)

    const repayTime = 86400 // 1 day
    const days = 3
    const interestRatePerDay = String(
      web3.utils.fromWei(await cdl.interestRatePerDay()),
    )
    const interest = interestRatePerDay * days // interest rate for 3 days, 1.2%
    const amountToRepay = amount.times(1 + interest)
    const lpRewardPercentageLoanRepaid = BigNumber(
      await cdl.lpRewardPercentageLoanRepaid(),
    ).div(1e18)
    const devRewardPercentageLoanRepaid = BigNumber(
      await cdl.devRewardPercentageLoanRepaid(),
    ).div(1e18)
    const profit = BigNumber(amountToRepay).minus(amount) // Profit is 1.2e18
    const expectedLpReward = profit.div(2).times(lpRewardPercentageLoanRepaid)
    const expectedDevReward = profit.div(2).times(devRewardPercentageLoanRepaid)

    await cdl.generateLoan(token.address, amount, days)
    const lastLoanId = await cdl.lastLoanId()

    await time.increase(repayTime)
    await token.approve(cdl.address, amountToRepay)

    const lpContractBalance = await token.balanceOf(liquidityProviders.address)
    const devTreasuryBalance = await token.balanceOf(
      await cdl.developmentTreasury(),
    )
    const cdlBalance = await token.balanceOf(cdl.address)
    const cryptoScoreFinal = BigNumber(
      await cdl.cryptoScore(token.address, accs[0]),
    )
    await cdl.repayLoan()

    const lpContractBalance2 = await token.balanceOf(liquidityProviders.address)
    const devTreasuryBalance2 = await token.balanceOf(
      await cdl.developmentTreasury(),
    )
    const cdlBalance2 = await token.balanceOf(cdl.address)
    const cryptoScoreFinal2 = BigNumber(
      await cdl.cryptoScore(token.address, accs[0]),
    )

    // Check oan closed and cryptoscore increased
    const finalLoan = await cdl.loansById(lastLoanId)
    assert.ok(
      BigNumber(finalLoan.state).eq(2),
      'The loan should be marked as state PAID',
    )
    assert.ok(
      cryptoScoreFinal2.eq(cryptoScoreFinal.plus(profit.div(2))),
      'The crypto score has not been updated correctly',
    )

    const userCollateral = BigNumber(
      await cdl.userCollateral(token.address, accs[0]),
    )
    assert.ok(
      userCollateral.eq(liquidityToAdd.plus(profit.div(2))),
      'The crypto score has not been updated correctly',
    )
    // Check dev treasury, lp rewards and amount locked in the cdl contract as crypto score
    assert.ok(
      BigNumber(cdlBalance2).eq(BigNumber(cdlBalance).plus(profit.div(2))),
      'The CDL contract balance is not correct',
    )
    assert.ok(
      BigNumber(devTreasuryBalance2).eq(
        BigNumber(devTreasuryBalance).plus(expectedDevReward),
      ),
      'The dev treasury balance is not correct',
    )
    assert.ok(
      BigNumber(lpContractBalance2).eq(
        BigNumber(lpContractBalance).plus(amount).plus(expectedLpReward),
      ),
      'The LP balance is not correct',
    )
    const totalFundsLent = BigNumber(await cdl.totalFundsLent(token.address))
    const activeFundsLent = BigNumber(await cdl.activeFundsLent(token.address))
    const userActiveFundsLent = BigNumber(
      await cdl.userActiveFundsLent(token.address, accs[0]),
    )
    assert.ok(totalFundsLent.eq(amount), 'Total funds lent is incorrect')
    assert.ok(activeFundsLent.isZero(), 'Active funds lent is incorrect')
    assert.ok(
      userActiveFundsLent.isZero(),
      'User active funds lent is incorrect',
    )
    const lockedCollateral = BigNumber(
      await cdl.lockedCollateral(token.address, accs[0]),
    )
    assert.ok(lockedCollateral.isZero(), 'Locked collateral is incorrect')

    const userActiveFundsLentInUSD = BigNumber(
      await cdl.userActiveFundsLentInUSD(accs[0]),
    )
    assert.ok(
      userActiveFundsLentInUSD.isZero(),
      'User active funds lent in USD is incorrect',
    )
    const userLockedCollateralInUSD = BigNumber(
      await cdl.userLockedCollateralInUSD(accs[0]),
    )
    assert.ok(
      userLockedCollateralInUSD.isZero(),
      'User locked collateral in USD is incorrect',
    )
    const activeFundsLentInUSD = BigNumber(await cdl.activeFundsLentInUSD())
    assert.ok(
      activeFundsLentInUSD.isZero(),
      'Active funds lent in USD is incorrect',
    )
    const totalLockedCollateralInUSD = BigNumber(
      await cdl.totalLockedCollateralInUSD(),
    )
    assert.ok(
      totalLockedCollateralInUSD.isZero(),
      'Total locked collateral in USD is incorrect',
    )
  })

  it('should repay a 3 day ETH loan successfully before the time has passed', async () => {
    const liquidityToAdd = BigNumber(20e18)
    const amount = BigNumber(5e18)

    await liquidityProvidersETH.lockLiquidityETH({ value: liquidityToAdd })

    const repayTime = 86400 // 1 day
    const days = 3
    const interestRatePerDay = String(
      web3.utils.fromWei(await cdl.interestRatePerDay()),
    )
    const interest = interestRatePerDay * days // interest rate for 3 days, 1.2%
    const amountToRepay = amount.times(1 + interest)
    const lpRewardPercentageLoanRepaid = BigNumber(
      await cdl.lpRewardPercentageLoanRepaid(),
    ).div(1e18)
    const devRewardPercentageLoanRepaid = BigNumber(
      await cdl.devRewardPercentageLoanRepaid(),
    ).div(1e18)
    const profit = BigNumber(amountToRepay).minus(amount) // Profit is 1.2e18
    const expectedLpReward = profit.div(2).times(lpRewardPercentageLoanRepaid)
    const expectedDevReward = profit.div(2).times(devRewardPercentageLoanRepaid)

    await cdl.generateLoanETH(amount, 3)
    const lastLoanId = await cdl.lastLoanId()
    const loan = await cdl.loansById(lastLoanId)
    assert.ok(loan.owner == accs[0], 'The loan must be created successfully')

    await time.increase(repayTime)

    const lpContractBalance = await weth.balanceOf(
      liquidityProvidersETH.address,
    )
    const devTreasuryBalance = await weth.balanceOf(
      await cdl.developmentTreasury(),
    )
    const cdlBalance = await weth.balanceOf(cdl.address)
    const cryptoScoreFinal = BigNumber(
      await cdl.cryptoScore(weth.address, accs[0]),
    )
    await cdl.repayLoanETH({ value: amountToRepay })

    const lpContractBalance2 = await weth.balanceOf(
      liquidityProvidersETH.address,
    )
    const devTreasuryBalance2 = await weth.balanceOf(
      await cdl.developmentTreasury(),
    )
    const cdlBalance2 = await weth.balanceOf(cdl.address)
    const cryptoScoreFinal2 = BigNumber(
      await cdl.cryptoScore(weth.address, accs[0]),
    )

    const userCollateral = BigNumber(
      await cdl.userCollateral(weth.address, accs[0]),
    )
    assert.ok(
      userCollateral.eq(liquidityToAdd.plus(profit.div(2))),
      'The crypto score has not been updated correctly',
    )
    // Check oan closed and cryptoscore increased
    const finalLoan = await cdl.loansById(lastLoanId)
    assert.ok(
      BigNumber(finalLoan.state).eq(2),
      'The loan should be marked as state PAID',
    )
    assert.ok(
      cryptoScoreFinal2.eq(cryptoScoreFinal.plus(profit.div(2))),
      'The crypto score has not been updated correctly',
    )

    // Check dev treasury, lp rewards and amount locked in the cdl contract as crypto score
    assert.ok(
      BigNumber(cdlBalance2).eq(BigNumber(cdlBalance).plus(profit.div(2))),
      'The CDL contract balance is not correct',
    )
    assert.ok(
      BigNumber(devTreasuryBalance2).eq(
        BigNumber(devTreasuryBalance).plus(expectedDevReward),
      ),
      'The dev treasury balance is not correct',
    )
    assert.ok(
      BigNumber(lpContractBalance2).eq(
        BigNumber(lpContractBalance).plus(amount).plus(expectedLpReward),
      ),
      'The LP balance is not correct',
    )

    const totalFundsLent = BigNumber(await cdl.totalFundsLent(weth.address))
    const activeFundsLent = BigNumber(await cdl.activeFundsLent(weth.address))
    const userActiveFundsLent = BigNumber(
      await cdl.userActiveFundsLent(weth.address, accs[0]),
    )
    assert.ok(totalFundsLent.eq(amount), 'Total funds lent is incorrect')
    assert.ok(activeFundsLent.isZero(), 'Active funds lent is incorrect')
    assert.ok(
      userActiveFundsLent.isZero(),
      'User active funds lent is incorrect',
    )
    const lockedCollateral = BigNumber(
      await cdl.lockedCollateral(weth.address, accs[0]),
    )
    assert.ok(lockedCollateral.isZero(), 'Locked collateral is incorrect')

    const userActiveFundsLentInUSD = BigNumber(
      await cdl.userActiveFundsLentInUSD(accs[0]),
    )
    assert.ok(
      userActiveFundsLentInUSD.isZero(),
      'User active funds lent in USD is incorrect',
    )
    const userLockedCollateralInUSD = BigNumber(
      await cdl.userLockedCollateralInUSD(accs[0]),
    )
    assert.ok(
      userLockedCollateralInUSD.isZero(),
      'User locked collateral in USD is incorrect',
    )
    const activeFundsLentInUSD = BigNumber(await cdl.activeFundsLentInUSD())
    assert.ok(
      activeFundsLentInUSD.isZero(),
      'Active funds lent in USD is incorrect',
    )
    const totalLockedCollateralInUSD = BigNumber(
      await cdl.totalLockedCollateralInUSD(),
    )
    assert.ok(
      totalLockedCollateralInUSD.isZero(),
      'Total locked collateral in USD is incorrect',
    )
  })

  it('should get a loan just with crypto score and repay it successfully', async () => {
    const liquidityToAdd = BigNumber(5000e18)

    await token.approve(liquidityProviders.address, liquidityToAdd)
    await liquidityProviders.lockLiquidity(liquidityToAdd)

    await token.transfer(accs[3], liquidityToAdd)
    await token.approve(liquidityProviders.address, liquidityToAdd, {
      from: accs[3],
    })
    await liquidityProviders.lockLiquidity(liquidityToAdd, { from: accs[3] })

    const repayTime = 2.506e6 // 29 days
    const amount = BigNumber(1000e18) // This generates a profit of 120 DAI, 60 goes to the crypto score which is then used as collateral allowing the user to make 140% -> 60 100% -> ~42 DAI
    const amount2 = BigNumber(24e18)
    const days = 30
    const interestRatePerDay = String(
      web3.utils.fromWei(await cdl.interestRatePerDay()),
    )
    const interest = interestRatePerDay * days // interest rate for 30 days, 12%
    const amountToRepay = amount.times(1 + interest)
    const amountToRepay2 = amount2.times(1 + interest)
    const lpRewardPercentageLoanRepaid = BigNumber(
      await cdl.lpRewardPercentageLoanRepaid(),
    ).div(1e18)
    const devRewardPercentageLoanRepaid = BigNumber(
      await cdl.devRewardPercentageLoanRepaid(),
    ).div(1e18)
    const profit = BigNumber(amountToRepay2).minus(amount2) // Profit is 1.2e18
    const expectedLpReward = profit.div(2).times(lpRewardPercentageLoanRepaid)
    const expectedDevReward = profit.div(2).times(devRewardPercentageLoanRepaid)

    // Get a big ass loan to build the Crypto Score and then get a loan just with that by removing all the collateral
    await cdl.generateLoan(token.address, amount, days)
    await time.increase(repayTime)
    await token.approve(cdl.address, amountToRepay)
    await cdl.repayLoan()

    await time.increase(liqudityLockDuration)
    // 1. Remove liquidity
    await liquidityProviders.extractLiquidity()
    // 2. Generate loan with CS being the collateral
    await cdl.generateLoan(token.address, amount2, days)
    await time.increase(repayTime)
    await token.approve(cdl.address, amountToRepay2)

    const lpContractBalance = BigNumber(
      await token.balanceOf(liquidityProviders.address),
    )
    const devTreasuryBalance = BigNumber(
      await token.balanceOf(await cdl.developmentTreasury()),
    )
    const cdlBalance = BigNumber(await token.balanceOf(cdl.address))
    const cryptoScoreFinal = BigNumber(
      await cdl.cryptoScore(token.address, accs[0]),
    )
    await cdl.repayLoan()

    const lpContractBalance2 = BigNumber(
      await token.balanceOf(liquidityProviders.address),
    )
    const devTreasuryBalance2 = BigNumber(
      await token.balanceOf(await cdl.developmentTreasury()),
    )
    const cdlBalance2 = BigNumber(await token.balanceOf(cdl.address))
    const cryptoScoreFinal2 = BigNumber(
      await cdl.cryptoScore(token.address, accs[0]),
    )

    // Check loan closed and cryptoscore increased
    const lastLoanId = await cdl.lastLoanId()
    const finalLoan = await cdl.loansById(lastLoanId)
    assert.ok(
      BigNumber(finalLoan.state).eq(2),
      'The loan should be marked as state PAID',
    )
    assert.ok(
      cryptoScoreFinal2.eq(cryptoScoreFinal.plus(profit.div(2))),
      'The crypto score has not been updated correctly',
    )

    // Check dev treasury, lp rewards and amount locked in the cdl contract as crypto score
    assert.ok(
      cdlBalance2.eq(cdlBalance.plus(profit.div(2))),
      'The CDL contract balance is not correct',
    )
    assert.ok(
      devTreasuryBalance2.eq(devTreasuryBalance.plus(expectedDevReward)),
      'The dev treasury balance is not correct',
    )
    assert.ok(
      lpContractBalance2.eq(
        lpContractBalance.plus(amount2).plus(expectedLpReward),
      ),
      'The dev treasury balance is not correct',
    )
  })

  it('should get a loan with crypto score + collateral and repay it successfully', async () => {
    const liquidityToAdd = BigNumber(5000e18)

    await token.approve(liquidityProviders.address, liquidityToAdd)
    await liquidityProviders.lockLiquidity(liquidityToAdd)

    await token.transfer(accs[3], liquidityToAdd)
    await token.approve(liquidityProviders.address, liquidityToAdd, {
      from: accs[3],
    })
    await liquidityProviders.lockLiquidity(liquidityToAdd, { from: accs[3] })

    const repayTime = 2.506e6 // 29 days
    const amount = BigNumber(1000e18) // This generates a profit of 120 DAI, 60 goes to the crypto score which is then used as collateral allowing the user to make 140% -> 60 100% -> ~42 DAI
    const amount2 = BigNumber(70e18)
    const days = 30
    const interestRatePerDay = String(
      web3.utils.fromWei(await cdl.interestRatePerDay()),
    )
    const interest = interestRatePerDay * days // interest rate for 30 days, 12%
    const amountToRepay = amount.times(1 + interest)
    const amountToRepay2 = amount2.times(1 + interest)
    const lpRewardPercentageLoanRepaid = BigNumber(
      await cdl.lpRewardPercentageLoanRepaid(),
    ).div(1e18)
    const devRewardPercentageLoanRepaid = BigNumber(
      await cdl.devRewardPercentageLoanRepaid(),
    ).div(1e18)
    const profit = BigNumber(amountToRepay2).minus(amount2) // Profit is 1.2e18
    const expectedLpReward = profit.div(2).times(lpRewardPercentageLoanRepaid)
    const expectedDevReward = profit.div(2).times(devRewardPercentageLoanRepaid)

    // Get a big ass loan to build the Crypto Score and then get a loan just with that by removing all the collateral
    await cdl.generateLoan(token.address, amount, days)
    await time.increase(repayTime)
    await token.approve(cdl.address, amountToRepay)
    await cdl.repayLoan()

    await time.increase(liqudityLockDuration)
    // 1. Remove liquidity and add few liquidity
    await liquidityProviders.extractLiquidity()
    const liquidityToAdd2 = BigNumber(110e18)

    await token.approve(liquidityProviders.address, liquidityToAdd2)
    await liquidityProviders.lockLiquidity(liquidityToAdd2)

    // 2. Generate loan with CS being the collateral
    await cdl.generateLoan(token.address, amount2, days)
    await time.increase(repayTime)
    await token.approve(cdl.address, amountToRepay2)

    const lpContractBalance = BigNumber(
      await token.balanceOf(liquidityProviders.address),
    )
    const devTreasuryBalance = BigNumber(
      await token.balanceOf(await cdl.developmentTreasury()),
    )
    const cdlBalance = BigNumber(await token.balanceOf(cdl.address))
    const cryptoScoreFinal = BigNumber(
      await cdl.cryptoScore(token.address, accs[0]),
    )
    await cdl.repayLoan()

    const lpContractBalance2 = BigNumber(
      await token.balanceOf(liquidityProviders.address),
    )
    const devTreasuryBalance2 = BigNumber(
      await token.balanceOf(await cdl.developmentTreasury()),
    )
    const cdlBalance2 = BigNumber(await token.balanceOf(cdl.address))
    const cryptoScoreFinal2 = BigNumber(
      await cdl.cryptoScore(token.address, accs[0]),
    )

    // Check loan closed and cryptoscore increased
    const lastLoanId = await cdl.lastLoanId()
    const finalLoan = await cdl.loansById(lastLoanId)
    assert.ok(
      BigNumber(finalLoan.state).eq(2),
      'The loan should be marked as state PAID',
    )
    assert.ok(
      cryptoScoreFinal2.eq(cryptoScoreFinal.plus(profit.div(2))),
      'The crypto score has not been updated correctly',
    )

    // Check dev treasury, lp rewards and amount locked in the cdl contract as crypto score
    assert.ok(
      cdlBalance2.eq(cdlBalance.plus(profit.div(2))),
      'The CDL contract balance is not correct',
    )
    assert.ok(
      devTreasuryBalance2.eq(devTreasuryBalance.plus(expectedDevReward)),
      'The dev treasury balance is not correct',
    )
    assert.ok(
      lpContractBalance2.eq(
        lpContractBalance.plus(amount2).plus(expectedLpReward),
      ),
      'The dev treasury balance is not correct',
    )
  })

  it('should recall a late loan successfully after it expired and receive the corresponding reward', async () => {
    const liquidityToAdd = BigNumber(5000e18)

    await token.approve(liquidityProviders.address, liquidityToAdd)
    await liquidityProviders.lockLiquidity(liquidityToAdd)

    const repayTime = 2.506e6 // 29 days
    const amount = BigNumber(100e18)
    const days = 20
    const repaymentAmount = amount.times(collateralRatio).div(100)
    const lpRewardPercentageLoanCalled = BigNumber(
      await cdl.lpRewardPercentageLoanCalled(),
    ).div(1e18)
    const devRewardPercentageLoanCalled = BigNumber(
      await cdl.devRewardPercentageLoanCalled(),
    ).div(1e18)
    const lateRecallerRewardPercentage = BigNumber(
      await cdl.lateRecallerRewardPercentage(),
    ).div(1e18)
    const expectedLpReward = repaymentAmount.times(lpRewardPercentageLoanCalled)
    const expectedDevReward = repaymentAmount.times(
      devRewardPercentageLoanCalled,
    )
    const expectedRecallerReward = repaymentAmount.times(
      lateRecallerRewardPercentage,
    )

    await cdl.generateLoan(token.address, amount, days)
    const lastLoanId = await cdl.lastLoanId()

    const lpContractBalance = BigNumber(
      await token.balanceOf(liquidityProviders.address),
    )
    const devTreasuryBalance = BigNumber(
      await token.balanceOf(await cdl.developmentTreasury()),
    )

    time.increase(repayTime)
    const callerBalance = BigNumber(await token.balanceOf(accs[3]))
    await cdl.callLatePayment(lastLoanId, {
      from: accs[3],
    })

    const lpContractBalance2 = BigNumber(
      await token.balanceOf(liquidityProviders.address),
    )
    const devTreasuryBalance2 = BigNumber(
      await token.balanceOf(await cdl.developmentTreasury()),
    )
    const callerBalance2 = BigNumber(await token.balanceOf(accs[3]))
    const cryptoScoreFinal2 = BigNumber(
      await cdl.cryptoScore(token.address, accs[0]),
    )

    const finalLoan = await cdl.loansById(lastLoanId)
    assert.ok(
      BigNumber(finalLoan.state).eq(3),
      'The loan should be marked as state RECALLED',
    )
    assert.ok(
      cryptoScoreFinal2.eq(0),
      'The crypto score has not been updated correctly',
    )

    // Check dev treasury, lp rewards and caller reward
    assert.ok(
      devTreasuryBalance2.eq(devTreasuryBalance.plus(expectedDevReward)),
      'The dev treasury balance is not correct',
    )
    assert.ok(
      lpContractBalance2.eq(
        lpContractBalance.minus(repaymentAmount).plus(expectedLpReward),
      ),
      'The LP treasury balance is not correct',
    )
    assert.ok(
      callerBalance2.eq(callerBalance.plus(expectedRecallerReward)),
      'The loan recaller balance is not correct',
    )
  })

  it('should recall a late ETH loan successfully after it expired and receive the corresponding reward', async () => {
    const liquidityToAdd = BigNumber(40e18)

    await liquidityProvidersETH.lockLiquidityETH({ value: liquidityToAdd })

    const repayTime = 2.506e6 // 29 days
    const amount = BigNumber(10e18)
    const days = 20
    const repaymentAmount = amount.times(collateralRatio).div(100)
    const lpRewardPercentageLoanCalled = BigNumber(
      await cdl.lpRewardPercentageLoanCalled(),
    ).div(1e18)
    const devRewardPercentageLoanCalled = BigNumber(
      await cdl.devRewardPercentageLoanCalled(),
    ).div(1e18)
    const lateRecallerRewardPercentage = BigNumber(
      await cdl.lateRecallerRewardPercentage(),
    ).div(1e18)
    const expectedLpReward = repaymentAmount.times(lpRewardPercentageLoanCalled)
    const expectedDevReward = repaymentAmount.times(
      devRewardPercentageLoanCalled,
    )
    const expectedRecallerReward = repaymentAmount.times(
      lateRecallerRewardPercentage,
    )

    await cdl.generateLoanETH(amount, days)
    const lastLoanId = await cdl.lastLoanId()

    const lpContractBalance = BigNumber(
      await weth.balanceOf(liquidityProvidersETH.address),
    )
    const devTreasuryBalance = BigNumber(
      await weth.balanceOf(await cdl.developmentTreasury()),
    )
    await time.increase(repayTime)
    const callerBalance = BigNumber(await web3.eth.getBalance(accs[3]))
    let receipt = await cdl.callLatePayment(lastLoanId, {
      from: accs[3],
    })
    let gasUsed = await getGas(receipt)

    const lpContractBalance2 = BigNumber(
      await weth.balanceOf(liquidityProvidersETH.address),
    )
    const devTreasuryBalance2 = BigNumber(
      await weth.balanceOf(await cdl.developmentTreasury()),
    )
    const callerBalance2 = BigNumber(await web3.eth.getBalance(accs[3]))
    const cryptoScoreFinal2 = BigNumber(
      await cdl.cryptoScore(weth.address, accs[0]),
    )

    const finalLoan = await cdl.loansById(lastLoanId)
    assert.ok(
      BigNumber(finalLoan.state).eq(3),
      'The loan should be marked as state RECALLED',
    )
    assert.ok(
      cryptoScoreFinal2.eq(0),
      'The crypto score has not been updated correctly',
    )

    // Check dev treasury, lp rewards and caller reward
    assert.ok(
      devTreasuryBalance2.eq(devTreasuryBalance.plus(expectedDevReward)),
      'The dev treasury balance is not correct',
    )
    assert.ok(
      lpContractBalance2.eq(
        lpContractBalance.minus(repaymentAmount).plus(expectedLpReward),
      ),
      'The LP treasury balance is not correct',
    )
    assert.ok(
      callerBalance2.eq(
        callerBalance.plus(expectedRecallerReward).minus(gasUsed),
      ),
      'The loan recaller balance is not correct',
    )
  })

  it('should get panalized and pay a new loan with increased interest successfully', async () => {
    const liquidityToAdd = BigNumber(5000e18)

    await token.approve(liquidityProviders.address, liquidityToAdd)
    await liquidityProviders.lockLiquidity(liquidityToAdd)

    const repayTime = 3.024e6 // 35 days to repay a loan late
    const repayTime2 = 2.506e6 // 29 days to repay on time
    const amount = BigNumber(1000e18) // This generates a profit of 120 DAI, 60 goes to the crypto score which is then used as collateral allowing the user to make 140% -> 60 100% -> ~42 DAI
    const amount2 = BigNumber(1000e18)
    const days = 30
    const interestRatePerDay = Number(
      web3.utils.fromWei(await cdl.interestRatePerDay()),
    )
    const penalizationRate = Number(
      web3.utils.fromWei(await cdl.penalizationRate()),
    )
    const interest = interestRatePerDay * days // interest rate for 30 days, 12%
    const interest2 = (interestRatePerDay + penalizationRate) * days // interest rate for 30 days with penalization, 15%
    const amountToRepay = amount.times(1 + interest)
    const amountToRepay2 = amount2.times(1 + interest2)
    const lpRewardPercentageLoanRepaid = BigNumber(
      await cdl.lpRewardPercentageLoanRepaid(),
    ).div(1e18)
    const devRewardPercentageLoanRepaid = BigNumber(
      await cdl.devRewardPercentageLoanRepaid(),
    ).div(1e18)
    const profit = BigNumber(amountToRepay2).minus(amount2) // Profit is 1.2e18
    const expectedLpReward = profit.div(2).times(lpRewardPercentageLoanRepaid)
    const expectedDevReward = profit.div(2).times(devRewardPercentageLoanRepaid)

    await cdl.generateLoan(token.address, amount, days)
    await time.increase(repayTime)
    await token.approve(cdl.address, amountToRepay)
    const lastLoanId = await cdl.lastLoanId()
    // 1. Call a late loan payment
    await cdl.callLatePayment(lastLoanId, {
      from: accs[3],
    })
    // 2. Re-add the collateral since it was consumed in the recall and it's required for a new loan

    // 3. Get a new loan
    await cdl.generateLoan(token.address, amount2, days)
    await time.increase(repayTime2)
    await token.approve(cdl.address, amountToRepay2)

    const lpContractBalance = BigNumber(
      await token.balanceOf(liquidityProviders.address),
    )
    const devTreasuryBalance = BigNumber(
      await token.balanceOf(await cdl.developmentTreasury()),
    )
    const cdlBalance = BigNumber(await token.balanceOf(cdl.address))
    const cryptoScoreFinal = BigNumber(
      await cdl.cryptoScore(token.address, accs[0]),
    )
    await cdl.repayLoan()

    const lpContractBalance2 = BigNumber(
      await token.balanceOf(liquidityProviders.address),
    )
    const devTreasuryBalance2 = BigNumber(
      await token.balanceOf(await cdl.developmentTreasury()),
    )
    const cdlBalance2 = BigNumber(await token.balanceOf(cdl.address))
    const cryptoScoreFinal2 = BigNumber(
      await cdl.cryptoScore(token.address, accs[0]),
    )

    // Check loan closed and cryptoscore increased
    const lastLoanId2 = await cdl.lastLoanId()
    const finalLoan = await cdl.loansById(lastLoanId2)
    assert.ok(
      BigNumber(finalLoan.state).eq(2),
      'The loan should be marked as state PAID',
    )
    assert.ok(
      cryptoScoreFinal2.eq(cryptoScoreFinal.plus(profit.div(2))),
      'The crypto score has not been updated correctly',
    )

    // Check dev treasury, lp rewards and amount locked in the cdl contract as crypto score
    assert.ok(
      cdlBalance2.eq(cdlBalance.plus(profit.div(2))),
      'The CDL contract balance is not correct',
    )
    assert.ok(
      devTreasuryBalance2.eq(devTreasuryBalance.plus(expectedDevReward)),
      'The dev treasury balance is not correct',
    )
    assert.ok(
      lpContractBalance2.eq(
        lpContractBalance.plus(amount2).plus(expectedLpReward),
      ),
      'The dev treasury balance is not correct',
    )
  })
})
