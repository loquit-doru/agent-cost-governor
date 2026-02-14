// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract AICostGovernor is Ownable {
    IERC20 public immutable usdc;
    uint256 public minStake;

    mapping(address => uint256) public stakes;

    event StakeAdded(address indexed user, uint256 amount, uint256 totalStake);
    event StakeWithdrawn(address indexed user, uint256 amount, uint256 remaining);
    event MinStakeUpdated(uint256 oldValue, uint256 newValue);

    constructor(address usdcToken, uint256 initialMinStake) Ownable(msg.sender) {
        require(usdcToken != address(0), "invalid_usdc");
        require(initialMinStake > 0, "invalid_min_stake");

        usdc = IERC20(usdcToken);
        minStake = initialMinStake;
    }

    function stakeForAction(uint256 amount) external {
        require(amount > 0, "invalid_amount");
        require(usdc.transferFrom(msg.sender, address(this), amount), "transfer_failed");

        stakes[msg.sender] += amount;
        emit StakeAdded(msg.sender, amount, stakes[msg.sender]);
    }

    function withdraw(uint256 amount) external {
        require(amount > 0, "invalid_amount");
        require(stakes[msg.sender] >= amount, "insufficient_stake");

        stakes[msg.sender] -= amount;
        require(usdc.transfer(msg.sender, amount), "transfer_failed");
        emit StakeWithdrawn(msg.sender, amount, stakes[msg.sender]);
    }

    function checkApproval(address user) external view returns (bool) {
        return stakes[user] >= minStake;
    }

    function setMinStake(uint256 newMinStake) external onlyOwner {
        require(newMinStake > 0, "invalid_min_stake");
        uint256 old = minStake;
        minStake = newMinStake;
        emit MinStakeUpdated(old, newMinStake);
    }
}
