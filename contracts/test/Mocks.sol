// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Minimal stand-in for the ERC-8004 Identity Registry (agentIds start at 0, like the reference).
contract MockIdentity is ERC721 {
    uint256 private _lastId;

    constructor() ERC721("AgentIdentity", "AGENT") {}

    function register() external returns (uint256 agentId) {
        agentId = _lastId++;
        _mint(msg.sender, agentId);
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        address owner = ownerOf(agentId);
        return spender == owner || isApprovedForAll(owner, spender) || getApproved(agentId) == spender;
    }
}

/// @notice Records feedback with the reference Reputation Registry's self-feedback rule.
contract MockReputation {
    MockIdentity public immutable identity;

    event NewFeedback(uint256 indexed agentId, address indexed client, int128 value, string tag1, string tag2, bytes32 feedbackHash);

    constructor(MockIdentity identity_) {
        identity = identity_;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8,
        string calldata tag1,
        string calldata tag2,
        string calldata,
        string calldata,
        bytes32 feedbackHash
    ) external {
        require(!identity.isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed");
        emit NewFeedback(agentId, msg.sender, value, tag1, tag2, feedbackHash);
    }
}
