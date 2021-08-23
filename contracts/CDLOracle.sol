pragma solidity =0.6.2;

import "@openzeppelin/contracts-ethereum-package/contracts/access/Ownable.sol";
import "@openzeppelin/contracts-ethereum-package/contracts/math/SafeMath.sol";
import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";

contract CDLOracle is Initializable, OwnableUpgradeSafe {
    using SafeMath for uint256;

    event PriceFeedAdded(
        address indexed token0,
        address indexed token1,
        address indexed priceFeed
    );

    // Chainlink price feeds
    mapping(address => mapping(address => address)) public aggregatorV3Feed;
    // WETH token address
    address public weth;
    // Indicates decimals of price
    uint256 constant PRICE_DECIMALS = 18;

    modifier hasPriceFeed(address token0, address token1) {
        require(
            aggregatorV3Feed[token0][token1] != address(0),
            "CDLOracle: price feed does not exist"
        );
        _;
    }

    /// @notice CDLOracle initializer
    /// @param _weth WETH token address
    /// @param _ethUsdFeed Chainlink ETH / USD price feed
    function initialize(address _weth, address _ethUsdFeed) public initializer {
        __Ownable_init();
        weth = _weth;
        aggregatorV3Feed[_weth][address(0)] = _ethUsdFeed;
    }

    /// @notice Add new price feed
    /// @param token0 Token0 address
    /// @param token1 Token1 address, address(0) indicates USD.
    /// @param priceFeed Chainlink `Token0` / `Token1` price feed
    function addPriceFeed(
        address token0,
        address token1,
        address priceFeed
    ) external onlyOwner {
        aggregatorV3Feed[token0][token1] = priceFeed;
        emit PriceFeedAdded(token0, token1, priceFeed);
    }

    /// @notice Get price of token in USD value
    /// @param token Token address
    /// @return Returns USD price of token
    function getTokenPrice(address token) external view returns (uint256) {
        if (aggregatorV3Feed[token][address(0)] != address(0)) {
            return _getPrice(token, address(0));
        }
        return
            _getPrice(token, weth).mul(getETHPrice()).div(10**PRICE_DECIMALS);
    }

    /// @notice Get price of ETH in USD value
    /// @return Returns ETH price of token
    function getETHPrice() public view returns (uint256) {
        return _getPrice(weth, address(0));
    }

    /// @notice Get price of `token0` in `token1` value
    /// @param token0 Token0 address
    /// @param token1 Token1 address
    /// @return Returns `token1` price of `token0`
    function _getPrice(address token0, address token1)
        internal
        view
        hasPriceFeed(token0, token1)
        returns (uint256)
    {
        AggregatorV3Interface priceFeed =
            AggregatorV3Interface(aggregatorV3Feed[weth][address(0)]);
        (, int256 priceInt, , , ) = priceFeed.latestRoundData();
        require(priceInt >= 0, "invalid price");
        uint256 price = uint256(priceInt);
        uint256 decimals = uint256(priceFeed.decimals());
        if (decimals > PRICE_DECIMALS) {
            price = price.div(10**(decimals - PRICE_DECIMALS));
        } else if (decimals < PRICE_DECIMALS) {
            price = price.mul(10**(PRICE_DECIMALS - decimals));
        }
        return price;
    }

    function priceDecimals() external pure returns (uint8) {
        return uint8(PRICE_DECIMALS);
    }
}
