pragma solidity =0.6.2;

interface ILiquidityProviders {
    function addFeeAndUpdatePrice(uint256 _feeIn) external;

    function totalLiquidityLocked() external view returns (uint256);

    function giveLoan(address _to, uint256 _amount) external;

    function amountLocked(address _user) external view returns (uint256);

    function takeRepayment(uint256 _amount, address _user) external;
}
