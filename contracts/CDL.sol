pragma solidity =0.6.2;

import "@openzeppelin/contracts-ethereum-package/contracts/access/Ownable.sol";
import "@openzeppelin/contracts-ethereum-package/contracts/Initializable.sol";
import "@openzeppelin/contracts-ethereum-package/contracts/math/SafeMath.sol";
import "./interfaces/ILiquidityProviders.sol";
import "./interfaces/ICDLOracle.sol";
import "./interfaces/IERC20Detailed.sol";
import "./interfaces/IWETH.sol";

/// @notice CDL stands for Collateral Decreasing Loan this contract manages all the Loan provisions and repayments including collateral and Crypto Score management
/// Before upgrading the contract check the variables are still valid, specially the struct
contract CDL is Initializable, OwnableUpgradeSafe {
    using SafeMath for uint256;

    // Recalled means the loan was not paid on time and had to be called by an external user
    enum LoanStatus {NOT_STARTED, STARTED, PAID, RECALLED}

    struct Loan {
        address owner;
        uint256 id;
        address token;
        uint256 amount;
        uint256 started; // Timestamp
        uint256 ends; // Timestamp when it ends
        LoanStatus state;
    }

    struct CollateralToken {
        uint256 index;
        address token;
        address liquidityProvider;
        bool enabled;
    }

    mapping(address => mapping(address => uint256)) public cryptoScore;
    // When a user doesn't pay a loan, his crypto score becomes negative, having to pay a larger interest rate
    mapping(address => bool) public isPenalized;
    // The last loan created by the user no matter its state
    mapping(address => uint256) public latestLoanId;
    // The main Loan source of truth where all the loans are never deleted and updated
    mapping(uint256 => Loan) public loansById;
    mapping(uint256 => CollateralToken) public collateralTokens;
    mapping(address => uint256) public collateralTokensIndexes;
    uint256 public collateralTokensLength;
    // A treasury dedicated to continue the development of this dapp
    address public developmentTreasury;
    // How much collateral is required per loan. A 100 collateralRatio means you must add the same amount of collaterals to get the loan. Must be divided by 100 to make calculations with this variable
    uint256 public collateralRatio;
    uint256 public interestRatePerDay;
    uint256 public interestRatePadding;
    uint256 public maxDaysToRepayLoan;
    // How many funds have been used in loan no matter if they have been closed or not
    mapping(address => uint256) public totalFundsLent;
    // How many funds are in active loans
    mapping(address => uint256) public activeFundsLent;
    // How many funds are in active loans for user
    mapping(address => mapping(address => uint256)) public userActiveFundsLent;
    uint256 public penalizationRate;
    uint256 public lastLoanId;
    // A list of created loan ids not considering their current state
    uint256[] public loanIds;
    // A backlog of closed loan ids that can be checked with `loansById`
    uint256[] public closedLoanIds;
    uint256 public lpRewardPercentageLoanRepaid;
    uint256 public lpRewardPercentageLoanCalled;
    uint256 public devRewardPercentageLoanRepaid;
    uint256 public devRewardPercentageLoanCalled;
    uint256 public lateRecallerRewardPercentage;

    ICDLOracle public priceOracle;
    address public weth;

    event LoanCreated(
        uint256 indexed loanId,
        address indexed sender,
        address indexed token,
        uint256 amount,
        uint256 repaymentTimestamp
    );
    event LoanRepaid(
        uint256 indexed loanId,
        address indexed sender,
        address indexed token,
        uint256 amount,
        uint256 when
    );
    event CollateralAdded(
        address indexed sender,
        address indexed token,
        uint256 amount
    );
    event CollateralExtracted(
        address indexed sender,
        address indexed token,
        uint256 amount
    );

    modifier isCollateralToken(address _token) {
        require(
            collateralTokensIndexes[_token] > 0 &&
                collateralTokens[collateralTokensIndexes[_token]].enabled,
            "CDL: not collateral token or disabled"
        );
        _;
    }

    function initialize(
        address _developmentTreasury,
        ICDLOracle _oracle,
        address _weth
    ) public initializer {
        __Ownable_init();
        priceOracle = _oracle;
        weth = _weth;
        developmentTreasury = _developmentTreasury;
        collateralRatio = 140;
        penalizationRate = 1e15; // How much extra interest rate is required in case a user doesn't pay his loan back on time for security purposes
        interestRatePerDay = 4e15; // It's actually 0.4% (which is 0.004 when making calculations) per day padded with 18 zeroes that must be removed when calculating using the interestRatePadding variable
        interestRatePadding = 1e18;
        maxDaysToRepayLoan = 30; // Up to 30 days to repay a loan longer loans are not allowed. Close and reopen loans for more time
        lateRecallerRewardPercentage = 15e16; // Reward executor with a 15% from the 140% collateral required
        devRewardPercentageLoanCalled = 5e16; // Reward LPs with a 5% from the 140% collateral required
        lpRewardPercentageLoanCalled = 8e17; // Reward LPs with a 80% from the 140% collateral required
        lpRewardPercentageLoanRepaid = 9e17; // 90% of half the profit generated by the loan
        devRewardPercentageLoanRepaid = 1e17; // 10% of half the profit generated by the loan
    }

    /// @notice Set price oracle
    /// @param _oracle New oracle contract address
    function setPriceOracle(ICDLOracle _oracle) external onlyOwner {
        priceOracle = _oracle;
    }

    /// @notice Set reward percentages
    function setRewardPercentages(
        uint256 _lpRewardPercentageLoanRepaid,
        uint256 _lpRewardPercentageLoanCalled,
        uint256 _devRewardPercentageLoanRepaid,
        uint256 _devRewardPercentageLoanCalled,
        uint256 _lateRecallerRewardPercentage
    ) public onlyOwner {
        lpRewardPercentageLoanRepaid = _lpRewardPercentageLoanRepaid;
        lpRewardPercentageLoanCalled = _lpRewardPercentageLoanCalled;
        devRewardPercentageLoanRepaid = _devRewardPercentageLoanRepaid;
        devRewardPercentageLoanCalled = _devRewardPercentageLoanCalled;
        lateRecallerRewardPercentage = _lateRecallerRewardPercentage;
    }

    /// @notice Set development treasury
    /// @param _developmentTreasury New development treasury address
    function setDevelopmentTreasury(address _developmentTreasury)
        public
        onlyOwner
    {
        developmentTreasury = _developmentTreasury;
    }

    /// @notice Register new collateral token
    /// @param _token Collateral token address
    /// @param _liquidityProvider Liquidity provider contract address
    function registerCollateralToken(address _token, address _liquidityProvider)
        external
        onlyOwner
    {
        collateralTokensLength = collateralTokensLength.add(1);
        CollateralToken memory tokenInfo =
            CollateralToken({
                index: collateralTokensLength,
                token: _token,
                liquidityProvider: _liquidityProvider,
                enabled: true
            });
        collateralTokens[collateralTokensLength] = tokenInfo;
        collateralTokensIndexes[_token] = collateralTokensLength;
    }

    /// @notice Enable / Disable collateral token
    /// @param _token Collateral token address
    /// @param _enabled Enable or disable
    function setCollateralTokenEnabled(address _token, bool _enabled)
        external
        onlyOwner
    {
        require(
            collateralTokensIndexes[_token] > 0,
            "CDL: not collateral token"
        );
        collateralTokens[collateralTokensIndexes[_token]].enabled = _enabled;
    }

    /// @notice Set liquidity provider
    /// @param _token Collateral token address
    /// @param _liquidityProviderContract Liquidity provider contract address
    function setLiquidityProviderContract(
        address _token,
        address _liquidityProviderContract
    ) public onlyOwner isCollateralToken(_token) {
        collateralTokens[collateralTokensIndexes[_token]]
            .liquidityProvider = _liquidityProviderContract;
    }

    /// @notice Get liquidity provider of token
    /// @param _token Token address
    /// @return Returns address of liquidity provider
    function liquidityProvider(address _token)
        public
        view
        isCollateralToken(_token)
        returns (address)
    {
        return
            collateralTokens[collateralTokensIndexes[_token]].liquidityProvider;
    }

    /// @notice To generate a new loan
    /// @param _token Address of token to loan
    /// @param _amount How many tokens to get for this loan
    /// @param _daysToRepay Number indicating how many days until the loan has to be repaid (interest rates are derived from there)
    function generateLoan(
        address _token,
        uint256 _amount,
        uint256 _daysToRepay
    ) public {
        _generateLoanFor(msg.sender, _token, _amount, _daysToRepay);
    }

    /// @notice To generate a new loan
    /// @param _amount How many tokens to get for this loan
    /// @param _daysToRepay Number indicating how many days until the loan has to be repaid (interest rates are derived from there)
    function generateLoanETH(uint256 _amount, uint256 _daysToRepay) public {
        _generateLoanFor(msg.sender, weth, _amount, _daysToRepay);
    }

    /// @notice To generate a new loan
    /// @param _user User address
    /// @param _amount How many tokens to get for this loan
    /// @param _daysToRepay Number indicating how many days until the loan has to be repaid (interest rates are derived from there)
    function _generateLoanFor(
        address _user,
        address _token,
        uint256 _amount,
        uint256 _daysToRepay
    ) public isCollateralToken(_token) {
        // Must not be able to generate a new loan until paying the previous one
        uint256 myLatestLoanId = latestLoanId[_user];
        address token = _token;
        address user = _user;
        uint256 amount = _amount;
        Loan memory active = loansById[myLatestLoanId];
        require(
            active.state != LoanStatus.STARTED,
            "CDL: You can't create a new loan while there's one in progress"
        );
        require(_amount > 0, "CDL: The loan must be larger than zero tokens");
        require(
            _daysToRepay > 0,
            "CDL: The days to repay the loan must be larger than zero"
        );
        require(
            _daysToRepay <= maxDaysToRepayLoan,
            "CDL: The time to repay the loan can't exceed the max time limit"
        );
        // 1. Check the liquidity available in the LiquidityProviders contract to see if the loan is doable
        ILiquidityProviders liquidityProviderContract =
            ILiquidityProviders(liquidityProvider(token));
        uint256 liquidityAvailable =
            liquidityProviderContract.totalLiquidityLocked();
        require(
            liquidityAvailable >= _amount,
            "CDL: Not enough liquidity to generate this loan"
        );
        // 2. Check total collateral available amount in USD
        uint256 totalCollateral =
            totalCollateralInUSD(user).sub(userLockedCollateralInUSD(user));
        uint256 collateralRequired =
            usdAmountForToken(
                token,
                amount.mul(collateralRatio.add(100)).div(100)
            );
        require(
            totalCollateral >= collateralRequired,
            "CDL: Your combined collateral and Crypto Score isn't enough to get this loan"
        );
        // 3. Store the loan with the time to repay it so collectors can watch it for repayment calls
        uint256 repaymentTimestamp = now.add(_daysToRepay.mul(86400)); // Convert the days to seconds and add them to now to get the final payment date
        lastLoanId = lastLoanId.add(1);
        Loan memory loan =
            Loan(
                user,
                lastLoanId,
                token,
                amount,
                now,
                repaymentTimestamp,
                LoanStatus.STARTED
            );
        loansById[lastLoanId] = loan;
        latestLoanId[user] = lastLoanId;
        totalFundsLent[token] = totalFundsLent[token].add(amount);
        activeFundsLent[token] = activeFundsLent[token].add(amount);
        userActiveFundsLent[token][user] = userActiveFundsLent[token][user].add(
            amount
        );
        loanIds.push(lastLoanId);
        liquidityProviderContract.giveLoan(user, amount);
        emit LoanCreated(lastLoanId, user, token, amount, repaymentTimestamp);
        // 4. IF a loan is not repaid, move this user's cryptoscore to the liquidity providers contract for LPs whenever they want to extract their profits
    }

    /// @notice To repay and close a loan. When a loan is repaid, part of the interest generated is sent to to LiquidityProviders while the other part is added to this user cryptoScore. The loan is detected based on the user address
    function repayLoan() public {
        uint256 myLatestLoanId = latestLoanId[msg.sender];
        Loan storage active = loansById[myLatestLoanId];
        // Make sure the loan is not expired
        require(
            active.state == LoanStatus.STARTED,
            "CDL: Your loan has expired or has been paid already"
        );
        // How much profit has been generated from this loan without the cryptoScore
        uint256 daysToRepay = active.ends.sub(active.started).div(86400);
        uint256 repayment =
            calculateRepaymentAmount(
                active.amount,
                daysToRepay,
                isPenalized[msg.sender]
            );
        IERC20Detailed token = IERC20Detailed(active.token);
        uint256 allowance = token.allowance(msg.sender, address(this));
        require(
            allowance >= repayment,
            "CDL: You must approve the right token amount to repay the loan to this contract first"
        );
        token.transferFrom(msg.sender, address(this), repayment);
        _repayLoan(msg.sender, myLatestLoanId, repayment);
    }

    /// @notice To repay and close a loan. When a loan is repaid, part of the interest generated is sent to to LiquidityProviders while the other part is added to this user cryptoScore. The loan is detected based on the user address
    function repayLoanETH() public payable {
        uint256 myLatestLoanId = latestLoanId[msg.sender];
        Loan storage active = loansById[myLatestLoanId];
        // Make sure the loan is not expired
        require(
            active.state == LoanStatus.STARTED,
            "CDL: Your loan has expired or has been paid already"
        );
        // How much profit has been generated from this loan without the cryptoScore
        uint256 daysToRepay = active.ends.sub(active.started).div(86400);
        uint256 repayment =
            calculateRepaymentAmount(
                active.amount,
                daysToRepay,
                isPenalized[msg.sender]
            );
        require(
            msg.value >= repayment,
            "CDL: You must send right token amount to repay the loan to this contract"
        );
        if (msg.value.sub(repayment) > 0) {
            msg.sender.transfer(msg.value.sub(repayment));
        }
        IWETH(weth).deposit.value(repayment)();
        _repayLoan(msg.sender, myLatestLoanId, repayment);
    }

    /// @notice To repay and close a loan. When a loan is repaid, part of the interest generated is sent to to LiquidityProviders while the other part is added to this user cryptoScore. The loan is detected based on the user address
    /// @param _user User address
    /// @param _loanId User's last loan id
    /// @param _repayment Required repayment amount
    function _repayLoan(
        address _user,
        uint256 _loanId,
        uint256 _repayment
    ) internal {
        Loan storage active = loansById[_loanId];
        uint256 halfProfit = _repayment.sub(active.amount).div(2);
        uint256 lpsReward =
            halfProfit.mul(lpRewardPercentageLoanRepaid).div(1e18);
        uint256 devReward =
            halfProfit.mul(devRewardPercentageLoanRepaid).div(1e18);
        address token = active.token;
        closedLoanIds.push(active.id);
        active.state = LoanStatus.PAID;
        // Transfer half the funds inside here for crypto score and collateral management
        address liquidityProviderContract = liquidityProvider(token);
        IERC20Detailed(token).transfer(
            liquidityProviderContract,
            active.amount.add(lpsReward)
        );
        IERC20Detailed(token).transfer(developmentTreasury, devReward);
        // a 90% of half the profit is sent to LPs
        ILiquidityProviders(liquidityProviderContract).addFeeAndUpdatePrice(
            lpsReward
        );
        // The other half is kept on this contract as the crypto score
        cryptoScore[token][_user] = cryptoScore[token][_user].add(halfProfit);
        // Reset the penalized state so the user can make loans as before
        isPenalized[_user] = false;

        activeFundsLent[token] = activeFundsLent[token].sub(active.amount);
        userActiveFundsLent[token][_user] = userActiveFundsLent[token][_user]
            .sub(active.amount);
        emit LoanRepaid(active.id, _user, token, _repayment, now);
        // 1. Calculate how much profit has been generated
        // 2. Send half of it to LPs while locking the other half inside this contract as Crypto Score risk protection
        // - This is how you add profit to LPs -> ILiquidityProviders(liquidityProviderContract).addFeeAndUpdatePrice(interestCollected);
        // 3. Close the loan
    }

    /// @notice If a loan has expired the time to return it or collateral becomes not to be enough due to price changes, users can execute this function to close the loan while use the collateral and crypto score to pay for it, earning a profit since we consume the whole collateral, 140% of the amount lent
    function callLatePayment(uint256 _loanId) public {
        Loan storage active = loansById[_loanId];
        require(
            active.state == LoanStatus.STARTED,
            "CDL: The loan must be started to be able to recall the late payment"
        );
        // 1. Check the loan time is expired or collateral available
        if (now <= active.ends) {
            require(
                totalCollateralInUSD(active.owner) <
                    userLockedCollateralInUSD(active.owner),
                "CDL: The collateral must be less than loan repayment"
            );
        }
        // 2. Updated the loan state to recalled
        active.state = LoanStatus.RECALLED;
        // 3. Penalize the user
        isPenalized[active.owner] = true;

        address token = active.token;
        // How many tokens must be recalled, consume the entire collateral used for this loan
        uint256 repayment = active.amount.mul(collateralRatio).div(100);
        // 4. distribte recall reward
        _distributeRecallReward(token, repayment, active.owner, msg.sender);
        activeFundsLent[token] = activeFundsLent[token].sub(active.amount);
        userActiveFundsLent[token][active.owner] = userActiveFundsLent[token][
            active.owner
        ]
            .sub(active.amount);
    }

    /// @notice Indicates what interest rate % the user will have to pay for a specific time loan
    /// @param _daysToRepay How many days until the loan finished
    /// @param _penalizedUser If the user is penalized because he didn't pay a loan on time, he will have to pay a larger interest rate
    /// @return Returns the interest rate % padded to e18 zeroes that must be removed in the frontend
    function calculateInterestRate(uint256 _daysToRepay, bool _penalizedUser)
        public
        view
        returns (uint256)
    {
        require(
            _daysToRepay <= maxDaysToRepayLoan,
            "CDL: The time to repay the loan can't exceed the max time limit"
        );
        if (_penalizedUser) {
            return _daysToRepay.mul(interestRatePerDay.add(penalizationRate));
        }
        return _daysToRepay.mul(interestRatePerDay);
    }

    /// @notice How many tokens the user must repay back for a loan
    /// @param _amount How many tokens received from the loan
    /// @param _daysToRepay How many days until the loan finished
    /// @param _penalizedUser If the user is penalized because he didn't pay a loan on time, he will have to pay a larger interest rate
    /// @return Returns the total amount with the interest rate applied
    function calculateRepaymentAmount(
        uint256 _amount,
        uint256 _daysToRepay,
        bool _penalizedUser
    ) public view returns (uint256) {
        require(
            _daysToRepay <= maxDaysToRepayLoan,
            "CDL: The time to repay the loan can't exceed the max time limit"
        );
        uint256 paddedInterestRate =
            calculateInterestRate(_daysToRepay, _penalizedUser);
        uint256 result =
            _amount.add(
                _amount.mul(paddedInterestRate).div(interestRatePadding)
            );
        return result;
    }

    /// @notice Distribute recall reward to LP, dev, and recaller
    /// @param _loanToken Loan token address
    /// @param _repayment Repayment amount
    /// @param _loanOwner Recalled loan's owner
    /// @param _caller Recaller
    function _distributeRecallReward(
        address _loanToken,
        uint256 _repayment,
        address _loanOwner,
        address _caller
    ) internal {
        uint256 userCollateralAmount = userCollateral(_loanToken, _loanOwner);
        // 1. Check user collateral amount for token is enough for repayment
        if (userCollateralAmount >= _repayment) {
            // Pay loan token collateral
            _distributeRecallTokenReward(
                _loanToken,
                _repayment,
                _loanOwner,
                _caller
            );
        } else {
            // Pay loan token collateral
            if (userCollateralAmount > 0) {
                _distributeRecallTokenReward(
                    _loanToken,
                    userCollateralAmount,
                    _loanOwner,
                    _caller
                );
            }
            // 2. Pay other collaterals for rest repayment amounts.
            uint256 remainingInUSD =
                usdAmountForToken(
                    _loanToken,
                    _repayment.sub(userCollateralAmount)
                );
            for (uint256 i = 1; i <= collateralTokensLength; i += 1) {
                CollateralToken storage collateralToken = collateralTokens[i];
                if (
                    collateralToken.enabled &&
                    collateralToken.token != _loanToken
                ) {
                    address _token = collateralToken.token;
                    uint256 tokenAmount = userCollateral(_token, _loanOwner);
                    uint256 usdAmountToPay =
                        usdAmountForToken(_token, tokenAmount);
                    if (remainingInUSD <= usdAmountToPay) {
                        usdAmountToPay = remainingInUSD;
                        remainingInUSD = 0;
                        tokenAmount = tokenAmountForUSD(_token, usdAmountToPay);
                    } else {
                        remainingInUSD = remainingInUSD.sub(usdAmountToPay);
                    }
                    if (tokenAmount > 0) {
                        _distributeRecallTokenReward(
                            _token,
                            tokenAmount,
                            _loanOwner,
                            _caller
                        );
                    }
                    if (remainingInUSD == 0) {
                        break;
                    }
                }
            }
        }
    }

    /// @notice Distribute token recall reward to LP, dev, and recaller
    /// @param _token Token address
    /// @param _amount Token amount
    /// @param _loanOwner Recalled loan's owner
    /// @param _caller Recaller
    function _distributeRecallTokenReward(
        address _token,
        uint256 _amount,
        address _loanOwner,
        address _caller
    ) internal {
        uint256 lpsReward = _amount.mul(lpRewardPercentageLoanCalled).div(1e18);
        uint256 devReward =
            _amount.mul(devRewardPercentageLoanCalled).div(1e18);
        // 4. Reward executor with a 15% from the 140% collateral required
        uint256 callerReward =
            _amount.mul(lateRecallerRewardPercentage).div(1e18);

        ILiquidityProviders lpProvider =
            ILiquidityProviders(liquidityProvider(_token));
        uint256 userLiquidity = lpProvider.amountLocked(_loanOwner);
        uint256 drainFromLP;
        if (cryptoScore[_token][_loanOwner] >= _amount) {
            cryptoScore[_token][_loanOwner] = cryptoScore[_token][_loanOwner]
                .sub(_amount);
        } else if (userLiquidity >= _amount) {
            drainFromLP = _amount;
        } else {
            // If only the combined CS + Coll is enough for the token, use both
            if (userLiquidity > cryptoScore[_token][_loanOwner]) {
                drainFromLP = _amount.sub(cryptoScore[_token][_loanOwner]);
                cryptoScore[_token][_loanOwner] = 0;
            } else if (userLiquidity < cryptoScore[_token][_loanOwner]) {
                drainFromLP = userLiquidity;
                uint256 remaining = _amount.sub(userLiquidity);
                cryptoScore[_token][_loanOwner] = cryptoScore[_token][
                    _loanOwner
                ]
                    .sub(remaining);
            } else {
                // If there's the exact same amount in CS and Collateral
                drainFromLP = _amount.div(2);
                cryptoScore[_token][_loanOwner] = cryptoScore[_token][
                    _loanOwner
                ]
                    .sub(_amount.div(2));
            }
        }
        lpProvider.takeRepayment(drainFromLP, _loanOwner);
        IERC20Detailed(_token).transfer(liquidityProvider(_token), lpsReward);
        IERC20Detailed(_token).transfer(developmentTreasury, devReward);
        if (callerReward > 0) {
            if (_token == weth) {
                IWETH(weth).withdraw(callerReward);
                payable(_caller).transfer(callerReward);
            } else {
                IERC20Detailed(_token).transfer(_caller, callerReward);
            }
        }
    }

    /// @notice Get available collateral amount (deposited collateral + crypto score)
    /// @param _token Token address
    /// @param _user User address
    /// @return Returns the available collateral of user
    function userCollateral(address _token, address _user)
        public
        view
        returns (uint256)
    {
        uint256 liquidity =
            ILiquidityProviders(liquidityProvider(_token))
                .amountLocked(_user)
                .add(cryptoScore[_token][_user]);
        return
            liquidity > userActiveFundsLent[_token][_user]
                ? liquidity.sub(userActiveFundsLent[_token][_user])
                : 0;
    }

    /// @notice Get total collaterals in USD of user
    /// @param _user User address
    /// @return Returns the USD amounts of total collaterals
    function totalCollateralInUSD(address _user) public view returns (uint256) {
        uint256 totalUSDCollateral = 0;
        for (uint256 i = 1; i <= collateralTokensLength; i += 1) {
            CollateralToken storage collateralToken = collateralTokens[i];
            if (collateralToken.enabled) {
                address _token = collateralToken.token;
                totalUSDCollateral = totalUSDCollateral.add(
                    usdAmountForToken(_token, userCollateral(_token, _user))
                );
            }
        }
        return totalUSDCollateral;
    }

    /// @notice Get price decimals of price oracle
    /// @return Returns the price decimals of price oracle
    function priceDecimals() public view returns (uint8) {
        return priceOracle.priceDecimals();
    }

    /// @notice Convert token amount to USD amount
    /// @param _token Token address
    /// @param _amount Token amount to convert
    /// @return Returns the USD amount for token amount
    function usdAmountForToken(address _token, uint256 _amount)
        public
        view
        isCollateralToken(_token)
        returns (uint256)
    {
        uint256 price = priceOracle.getTokenPrice(_token);
        uint256 usdAmount =
            price.mul(_amount).div(
                10**uint256(IERC20Detailed(_token).decimals())
            );
        return usdAmount;
    }

    /// @notice Convert USD amount to token amount
    /// @param _token Token address
    /// @param _usdAmount USD amount to convert
    /// @return Returns the token amount for USD amount
    function tokenAmountForUSD(address _token, uint256 _usdAmount)
        public
        view
        isCollateralToken(_token)
        returns (uint256)
    {
        uint256 price = priceOracle.getTokenPrice(_token);
        uint256 tokenAmount =
            _usdAmount.mul(10**uint256(IERC20Detailed(_token).decimals())).div(
                price
            );
        return tokenAmount;
    }

    /// @notice Get total funds lent in USD
    /// @return Returns the total lent in USD
    function totalFundsLentInUSD() external view returns (uint256) {
        uint256 totalUSDLent = 0;
        for (uint256 i = 1; i <= collateralTokensLength; i += 1) {
            CollateralToken storage collateralToken = collateralTokens[i];
            if (collateralToken.enabled) {
                address _token = collateralToken.token;
                totalUSDLent = totalUSDLent.add(
                    usdAmountForToken(_token, totalFundsLent[_token])
                );
            }
        }
        return totalUSDLent;
    }

    /// @notice Get current active funds lent in USD
    /// @return Returns the current funds lent in USD
    function activeFundsLentInUSD() public view returns (uint256) {
        uint256 activeUSDLent = 0;
        for (uint256 i = 1; i <= collateralTokensLength; i += 1) {
            CollateralToken storage collateralToken = collateralTokens[i];
            if (collateralToken.enabled) {
                address _token = collateralToken.token;
                activeUSDLent = activeUSDLent.add(
                    usdAmountForToken(_token, activeFundsLent[_token])
                );
            }
        }
        return activeUSDLent;
    }

    /// @notice Get current active funds lent of `_user` in USD
    /// @param _user User address
    /// @return Returns the current funds lent amount in USD
    function userActiveFundsLentInUSD(address _user)
        public
        view
        returns (uint256)
    {
        uint256 activeUSDLent = 0;
        for (uint256 i = 1; i <= collateralTokensLength; i += 1) {
            CollateralToken storage collateralToken = collateralTokens[i];
            if (collateralToken.enabled) {
                address _token = collateralToken.token;
                activeUSDLent = activeUSDLent.add(
                    usdAmountForToken(
                        _token,
                        userActiveFundsLent[_token][_user]
                    )
                );
            }
        }
        return activeUSDLent;
    }

    /// @notice Get current locked collateral of `_user` for `_token`
    /// @param _token Collateral token address
    /// @param _user User address
    /// @return Returns the current locked collateral amount
    function lockedCollateral(address _token, address _user)
        public
        view
        returns (uint256)
    {
        return userActiveFundsLent[_token][_user].mul(collateralRatio).div(100);
    }

    /// @notice Get locked collateral of `_user` in USD
    /// @param _user User address
    /// @return Returns the locked collateral amount in USD
    function userLockedCollateralInUSD(address _user)
        public
        view
        returns (uint256)
    {
        return userActiveFundsLentInUSD(_user).mul(collateralRatio).div(100);
    }

    /// @notice Get locked collateral of `_user` in USD
    /// @return Returns the locked collateral amount in USD
    function totalLockedCollateralInUSD() public view returns (uint256) {
        return activeFundsLentInUSD().mul(collateralRatio).div(100);
    }

    receive() external payable {
        assert(msg.sender == weth); // only accept ETH via fallback from the WETH contract
    }
}
