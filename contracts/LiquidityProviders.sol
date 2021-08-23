pragma solidity =0.6.2;

import "@openzeppelin/contracts-ethereum-package/contracts/access/Ownable.sol";
import "@openzeppelin/contracts-ethereum-package/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-ethereum-package/contracts/Initializable.sol";
import "@openzeppelin/contracts-ethereum-package/contracts/math/SafeMath.sol";
import "./interfaces/IWETH.sol";

/// @notice To allow users to lock their ERC20 liquidity and earn fees in ERC20
contract LiquidityProviders is Initializable, OwnableUpgradeSafe {
    using SafeMath for uint256;

    // How many LP tokens each user has
    mapping(address => uint256) public amountLocked;
    // The price when you extracted your earnings so we can whether you got new earnings or not
    mapping(address => uint256) public lastPriceEarningsExtracted;
    // When the user started locking his LP tokens
    mapping(address => uint256) public lockingTime;
    // The token contract can be DAI, Tether, USDC TrueUSD, or WETH
    address public liquidityProviderToken;
    address public cdlContract;
    address public weth;
    // How many LP tokens are locked
    uint256 public totalLiquidityLocked;
    uint256 public feePrice;
    uint256 public accomulatedRewards;
    uint256 public pricePadding;
    uint256 public timeToExitLiquidity;

    modifier onlyCDL {
        require(
            msg.sender == cdlContract,
            "LiquidityProviders: Only the CDL contract can execute this function"
        );
        _;
    }

    function initialize(
        address _cdlContract,
        address _liquidityProviderToken,
        address _weth
    ) public initializer {
        __Ownable_init();
        pricePadding = 1e18;
        cdlContract = _cdlContract;
        liquidityProviderToken = _liquidityProviderToken;
        weth = _weth;
        timeToExitLiquidity = 365 days;
    }

    function setCdlContract(address _cdlContract) public onlyOwner {
        cdlContract = _cdlContract;
    }

    function setLiquidityProviderToken(address _liquidityProviderToken)
        public
        onlyOwner
    {
        liquidityProviderToken = _liquidityProviderToken;
    }

    function setTimeToExitLiquidity(uint256 _time) public onlyOwner {
        timeToExitLiquidity = _time;
    }

    /// @notice When fee is added, the price is increased
    /// Price is = (feeIn / totalLiquidityLocked) + currentPrice
    /// padded with 18 zeroes that get removed after the calculations
    /// if there are no locked LPs, the price is 0
    function addFeeAndUpdatePrice(uint256 _feeIn) public onlyCDL {
        accomulatedRewards = accomulatedRewards.add(_feeIn);
        if (totalLiquidityLocked == 0) {
            feePrice = 0;
        } else {
            feePrice = (_feeIn.mul(pricePadding).div(totalLiquidityLocked)).add(
                feePrice
            );
        }
    }

    /// @notice To transfer funds from a loan to the right user from this contract
    function giveLoan(address _to, uint256 _amount) public onlyCDL {
        if (liquidityProviderToken == weth) {
            IWETH(weth).withdraw(_amount);
            payable(_to).transfer(_amount);
        } else {
            IERC20(liquidityProviderToken).transfer(_to, _amount);
        }
    }

    /// @notice Take repayment amount from `_user`
    function takeRepayment(uint256 _amount, address _user) public onlyCDL {
        if (
            lastPriceEarningsExtracted[_user] != 0 &&
            lastPriceEarningsExtracted[_user] != feePrice
        ) {
            _extractEarningsFor(_user);
        }
        amountLocked[_user] = amountLocked[_user].sub(_amount);
        totalLiquidityLocked = totalLiquidityLocked.sub(_amount);
        IERC20(liquidityProviderToken).transfer(cdlContract, _amount);
    }

    function lockLiquidityETH() public payable {
        require(
            liquidityProviderToken == weth,
            "LiquidityProviders: Not ETH LP"
        );
        IWETH(weth).deposit.value(msg.value)();
        _lockLiquidityFor(msg.sender, msg.value);
    }

    function lockLiquidity(uint256 _amount) public {
        uint256 approval =
            IERC20(liquidityProviderToken).allowance(msg.sender, address(this));
        require(
            approval >= _amount,
            "LiquidityProviders: You must approve the desired amount of liquidity tokens to this contract first"
        );
        IERC20(liquidityProviderToken).transferFrom(
            msg.sender,
            address(this),
            _amount
        );
        _lockLiquidityFor(msg.sender, _amount);
    }

    function _lockLiquidityFor(address _user, uint256 _amount) internal {
        require(
            _amount > 0,
            "LiquidityProviders: Amount must be larger than zero"
        );
        totalLiquidityLocked = totalLiquidityLocked.add(_amount);
        // Extract earnings in case the user is not a new Locked LP
        if (
            lastPriceEarningsExtracted[_user] != 0 &&
            lastPriceEarningsExtracted[_user] != feePrice
        ) {
            _extractEarningsFor(_user);
        }
        // Set the initial price
        if (feePrice == 0) {
            feePrice = (accomulatedRewards.mul(pricePadding).div(_amount)).add(
                1e18
            );
            lastPriceEarningsExtracted[_user] = 1e18;
        } else {
            lastPriceEarningsExtracted[_user] = feePrice;
        }
        // The price doesn't change when locking liquidity. It changes when fees are generated from loan repayments
        amountLocked[_user] = amountLocked[_user].add(_amount);
        // Notice that the locking time is reset when new liquidity is added
        lockingTime[_user] = now;
    }

    function extractEarnings() public {
        _extractEarningsFor(msg.sender);
    }

    // We check for new earnings by seeing if the price the user last extracted his earnings
    // is the same or not to determine whether he can extract new earnings
    function _extractEarningsFor(address _user) internal {
        require(
            lastPriceEarningsExtracted[_user] != feePrice,
            "LiquidityProviders: You have already extracted your earnings"
        );
        // The amountLocked price minus the last price extracted
        uint256 myPrice = feePrice.sub(lastPriceEarningsExtracted[_user]);
        uint256 earnings = amountLocked[_user].mul(myPrice).div(pricePadding);
        lastPriceEarningsExtracted[_user] = feePrice;
        accomulatedRewards = accomulatedRewards.sub(earnings);
        if (liquidityProviderToken == weth) {
            IWETH(weth).withdraw(earnings);
            payable(_user).transfer(earnings);
        } else {
            IERC20(liquidityProviderToken).transfer(_user, earnings);
        }
    }

    // The user must lock the liquidity for 1 year and only then can extract his Locked LP tokens
    // he must extract all the LPs for simplicity and security purposes
    function extractLiquidity() public {
        require(
            amountLocked[msg.sender] > 0,
            "LiquidityProviders: You must have locked liquidity provider tokens to extract them"
        );
        require(
            now - lockingTime[msg.sender] >= timeToExitLiquidity,
            "LiquidityProviders: You must wait the specified locking time to extract your liquidity provider tokens"
        );
        // Extract earnings in case there are some
        if (
            lastPriceEarningsExtracted[msg.sender] != 0 &&
            lastPriceEarningsExtracted[msg.sender] != feePrice
        ) {
            extractEarnings();
        }
        uint256 locked = amountLocked[msg.sender];
        amountLocked[msg.sender] = 0;
        lockingTime[msg.sender] = now;
        lastPriceEarningsExtracted[msg.sender] = 0;
        totalLiquidityLocked = totalLiquidityLocked.sub(locked);
        if (liquidityProviderToken == weth) {
            IWETH(weth).withdraw(locked);
            msg.sender.transfer(locked);
        } else {
            IERC20(liquidityProviderToken).transfer(msg.sender, locked);
        }
    }

    function getAmountLocked(address _user) public view returns (uint256) {
        return amountLocked[_user];
    }

    function extractTokensIfStuck(address _token, uint256 _amount)
        public
        onlyOwner
    {
        IERC20(_token).transfer(owner(), _amount);
    }

    function extractETHIfStruck() public onlyOwner {
        payable(address(owner())).transfer(address(this).balance);
    }

    receive() external payable {
        assert(msg.sender == weth); // only accept ETH via fallback from the WETH contract
    }
}
