pragma solidity =0.6.2;

interface ICDLOracle {
    function getTokenPrice(address token) external view returns (uint256 price);

    function priceDecimals() external view returns (uint8);
}
