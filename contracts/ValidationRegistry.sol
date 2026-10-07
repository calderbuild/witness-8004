// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ERC-8004 Validation Registry. Interface, events and storage semantics follow the
// reference ValidationRegistryUpgradeable (github.com/erc-8004/erc-8004-contracts, MIT),
// made non-upgradeable because no Validation Registry is deployed on Monad yet.

interface IIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

contract ValidationRegistry {
    event ValidationRequest(
        address indexed validatorAddress,
        uint256 indexed agentId,
        string requestURI,
        bytes32 indexed requestHash
    );

    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    struct ValidationStatus {
        address validatorAddress;
        uint256 agentId;
        uint8 response;
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
        bool hasResponse;
    }

    address private immutable _identityRegistry;
    mapping(bytes32 => ValidationStatus) private _validations;
    mapping(uint256 => bytes32[]) private _agentValidations;
    mapping(address => bytes32[]) private _validatorRequests;
    // Not in the reference: lets clients fetch the ValidationRequest event with a one-block
    // eth_getLogs, since Monad RPCs cap log queries at ~100 blocks.
    mapping(bytes32 => uint256) public requestBlock;

    constructor(address identityRegistry_) {
        require(identityRegistry_ != address(0), "bad identity");
        _identityRegistry = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        require(validatorAddress != address(0), "bad validator");
        require(_validations[requestHash].validatorAddress == address(0), "exists");

        IIdentityRegistry registry = IIdentityRegistry(_identityRegistry);
        address owner = registry.ownerOf(agentId);
        require(
            msg.sender == owner ||
                registry.isApprovedForAll(owner, msg.sender) ||
                registry.getApproved(agentId) == msg.sender,
            "Not authorized"
        );

        _validations[requestHash] = ValidationStatus({
            validatorAddress: validatorAddress,
            agentId: agentId,
            response: 0,
            responseHash: bytes32(0),
            tag: "",
            lastUpdate: block.timestamp,
            hasResponse: false
        });
        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);
        requestBlock[requestHash] = block.number;

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        ValidationStatus storage s = _validations[requestHash];
        require(s.validatorAddress != address(0), "unknown");
        require(msg.sender == s.validatorAddress, "not validator");
        require(response <= 100, "resp>100");
        s.response = response;
        s.responseHash = responseHash;
        s.tag = tag;
        s.lastUpdate = block.timestamp;
        s.hasResponse = true;
        emit ValidationResponse(s.validatorAddress, s.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate)
    {
        ValidationStatus memory s = _validations[requestHash];
        require(s.validatorAddress != address(0), "unknown");
        return (s.validatorAddress, s.agentId, s.response, s.responseHash, s.tag, s.lastUpdate);
    }

    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        uint256 totalResponse;
        bytes32[] storage requestHashes = _agentValidations[agentId];
        for (uint256 i; i < requestHashes.length; i++) {
            ValidationStatus storage s = _validations[requestHashes[i]];
            if (!s.hasResponse) continue;
            if (!_matches(s.validatorAddress, validatorAddresses)) continue;
            if (bytes(tag).length != 0 && keccak256(bytes(s.tag)) != keccak256(bytes(tag))) continue;
            totalResponse += s.response;
            count++;
        }
        avgResponse = count > 0 ? uint8(totalResponse / count) : 0;
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }

    function getVersion() external pure returns (string memory) {
        return "2.0.0";
    }

    function _matches(address v, address[] calldata list) private pure returns (bool) {
        if (list.length == 0) return true;
        for (uint256 j; j < list.length; j++) {
            if (list[j] == v) return true;
        }
        return false;
    }
}
