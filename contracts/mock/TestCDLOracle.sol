pragma solidity =0.6.2;

import "@openzeppelin/contracts-ethereum-package/contracts/access/Ownable.sol";
import "@openzeppelin/contracts-ethereum-package/contracts/math/SafeMath.sol";
import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";

contract TestCDLOracle is Initializable, OwnableUpgradeSafe {
    using SafeMath for uint256;

    mapping(address => uint256) public fakePrice;
    // Indicates decimals of price
    uint256 constant PRICE_DECIMALS = 18;

    function initialize() public initializer {
        __Ownable_init();
    }

    function setFakePrice(address token, uint256 price) external onlyOwner {
        fakePrice[token] = price;
    }

    function getTokenPrice(address token) external view returns (uint256) {
        return fakePrice[token];
    }

    function priceDecimals() external pure returns (uint8) {
        return uint8(PRICE_DECIMALS);
    }
}
