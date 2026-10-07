// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IValidationRegistry {
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate);

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;
}

interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}

interface IAgentIdentity {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

/// @title WitnessPool
/// @notice The validation protocol behind one ERC-8004 validatorAddress. An agent commits its
/// intent with ValidationRegistry.validationRequest(address(this), ...), links the tx that
/// executed it, and bonded validators vote 0-100 on whether the tx matches the intent. When
/// `quorum` votes are in, the median is written back as the ERC-8004 validationResponse and as
/// feedback on the Reputation Registry. Validators on the losing side of pass/fail lose part of
/// their bond to the validators who agreed with the verdict.
contract WitnessPool {
    uint8 public constant PASS_THRESHOLD = 50;
    string public constant TAG = "witness";

    IValidationRegistry public immutable registry;
    IReputationRegistry public immutable reputation;
    IAgentIdentity public immutable identity;
    uint256 public immutable minBond;
    uint8 public immutable quorum;
    uint16 public immutable slashBps;

    struct Validator {
        uint256 bond;
        uint32 openVotes;
        uint32 votes;
        uint32 slashes;
        bool listed;
    }

    struct Round {
        address[] voters;
        uint8[] scores;
        bool finalized;
        uint8 verdict;
    }

    mapping(address => Validator) public validators;
    address[] public validatorList;
    mapping(bytes32 => Round) private _rounds;
    mapping(bytes32 => mapping(address => bool)) public hasVoted;
    mapping(bytes32 => bytes32) public executionOf;

    event Bonded(address indexed validator, uint256 amount, uint256 totalBond);
    event Exited(address indexed validator, uint256 amount);
    event ExecutionLinked(bytes32 indexed requestHash, uint256 indexed agentId, bytes32 txHash);
    event Voted(bytes32 indexed requestHash, address indexed validator, uint8 score, string evidenceURI);
    event Slashed(bytes32 indexed requestHash, address indexed validator, uint256 amount);
    event Rewarded(bytes32 indexed requestHash, address indexed validator, uint256 amount);
    event Finalized(bytes32 indexed requestHash, uint256 indexed agentId, uint8 verdict, bool passed);

    constructor(
        address registry_,
        address reputation_,
        address identity_,
        uint256 minBond_,
        uint8 quorum_,
        uint16 slashBps_
    ) {
        require(quorum_ > 0 && slashBps_ <= 10_000, "bad params");
        registry = IValidationRegistry(registry_);
        reputation = IReputationRegistry(reputation_);
        identity = IAgentIdentity(identity_);
        minBond = minBond_;
        quorum = quorum_;
        slashBps = slashBps_;
    }

    function bond() external payable {
        Validator storage v = validators[msg.sender];
        v.bond += msg.value;
        require(v.bond >= minBond, "bond < min");
        if (!v.listed) {
            v.listed = true;
            validatorList.push(msg.sender);
        }
        emit Bonded(msg.sender, msg.value, v.bond);
    }

    // ponytail: no unbonding delay; a validator can leave as soon as it has no open votes.
    // Add a withdrawal queue if slashing ever depends on evidence submitted after finalization.
    function exit() external {
        Validator storage v = validators[msg.sender];
        require(v.openVotes == 0, "open votes");
        uint256 amount = v.bond;
        v.bond = 0;
        emit Exited(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }

    /// @notice Agent owner or operator links the tx that executed a committed intent.
    function linkExecution(bytes32 requestHash, bytes32 txHash) external {
        (address validatorAddress, uint256 agentId, , , , ) = registry.getValidationStatus(requestHash);
        require(validatorAddress == address(this), "not our request");
        require(executionOf[requestHash] == bytes32(0), "already linked");
        require(_isAgentController(msg.sender, agentId), "not agent");
        executionOf[requestHash] = txHash;
        emit ExecutionLinked(requestHash, agentId, txHash);
    }

    function vote(bytes32 requestHash, uint8 score, string calldata evidenceURI) external {
        Validator storage v = validators[msg.sender];
        require(v.bond >= minBond, "not bonded");
        require(score <= 100, "score>100");
        (address validatorAddress, uint256 agentId, , , , ) = registry.getValidationStatus(requestHash);
        require(validatorAddress == address(this), "not our request");
        Round storage r = _rounds[requestHash];
        require(!r.finalized, "finalized");
        require(!hasVoted[requestHash][msg.sender], "voted");

        hasVoted[requestHash][msg.sender] = true;
        r.voters.push(msg.sender);
        r.scores.push(score);
        v.openVotes++;
        v.votes++;
        emit Voted(requestHash, msg.sender, score, evidenceURI);

        if (r.voters.length == quorum) _finalize(requestHash, agentId, r);
    }

    function getRound(bytes32 requestHash)
        external
        view
        returns (address[] memory voters, uint8[] memory scores, bool finalized, uint8 verdict)
    {
        Round storage r = _rounds[requestHash];
        return (r.voters, r.scores, r.finalized, r.verdict);
    }

    function validatorCount() external view returns (uint256) {
        return validatorList.length;
    }

    function _finalize(bytes32 requestHash, uint256 agentId, Round storage r) private {
        uint8 verdict = _median(r.scores);
        bool passed = verdict >= PASS_THRESHOLD;
        r.finalized = true;
        r.verdict = verdict;

        uint256 pot;
        uint256 winners;
        for (uint256 i; i < r.voters.length; i++) {
            Validator storage v = validators[r.voters[i]];
            v.openVotes--;
            if ((r.scores[i] >= PASS_THRESHOLD) == passed) {
                winners++;
                continue;
            }
            uint256 cut = (v.bond * slashBps) / 10_000;
            v.bond -= cut;
            v.slashes++;
            pot += cut;
            emit Slashed(requestHash, r.voters[i], cut);
        }
        if (pot > 0) _reward(requestHash, r, passed, pot, winners);

        emit Finalized(requestHash, agentId, verdict, passed);
        registry.validationResponse(requestHash, verdict, "", keccak256(abi.encode(r.voters, r.scores)), TAG);
        reputation.giveFeedback(
            agentId,
            int128(uint128(verdict)),
            0,
            TAG,
            passed ? "pass" : "fail",
            "",
            "",
            requestHash
        );
    }

    // The median always sits on the winning side, so winners >= 1 whenever pot > 0.
    function _reward(bytes32 requestHash, Round storage r, bool passed, uint256 pot, uint256 winners) private {
        uint256 share = pot / winners;
        uint256 dust = pot - share * winners;
        for (uint256 i; i < r.voters.length; i++) {
            if ((r.scores[i] >= PASS_THRESHOLD) != passed) continue;
            uint256 amount = share + dust;
            dust = 0;
            validators[r.voters[i]].bond += amount;
            emit Rewarded(requestHash, r.voters[i], amount);
        }
    }

    function _median(uint8[] storage scores) private view returns (uint8) {
        uint256 n = scores.length;
        uint8[] memory s = new uint8[](n);
        for (uint256 i; i < n; i++) {
            uint8 x = scores[i];
            uint256 j = i;
            while (j > 0 && s[j - 1] > x) {
                s[j] = s[j - 1];
                j--;
            }
            s[j] = x;
        }
        return s[n / 2];
    }

    function _isAgentController(address who, uint256 agentId) private view returns (bool) {
        address owner = identity.ownerOf(agentId);
        return who == owner || identity.isApprovedForAll(owner, who) || identity.getApproved(agentId) == who;
    }
}
