// Human-readable ABIs shared by the SDK, the validator node and the explorer.

export const identityAbi = [
  "function register(string agentURI) returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

export const reputationAbi = [
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
];

export const validationAbi = [
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function getValidationStatus(bytes32) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
  "function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 avgResponse)",
  "function getAgentValidations(uint256) view returns (bytes32[])",
  "function getValidatorRequests(address) view returns (bytes32[])",
  "function requestBlock(bytes32) view returns (uint256)",
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
];

export const poolAbi = [
  "function bond() payable",
  "function exit()",
  "function linkExecution(bytes32 requestHash, bytes32 txHash)",
  "function vote(bytes32 requestHash, uint8 score, string evidenceURI)",
  "function getRound(bytes32) view returns (address[] voters, uint8[] scores, bool finalized, uint8 verdict, uint64 linkBlock, uint64 finalizeBlock)",
  "function executionOf(bytes32) view returns (bytes32)",
  "function hasVoted(bytes32, address) view returns (bool)",
  "function validators(address) view returns (uint256 bond, uint32 openVotes, uint32 votes, uint32 slashes, bool listed)",
  "function validatorList(uint256) view returns (address)",
  "function validatorCount() view returns (uint256)",
  "function minBond() view returns (uint256)",
  "function quorum() view returns (uint8)",
  "event ExecutionLinked(bytes32 indexed requestHash, uint256 indexed agentId, bytes32 txHash)",
  "event Voted(bytes32 indexed requestHash, address indexed validator, uint8 score, string evidenceURI)",
  "event Slashed(bytes32 indexed requestHash, address indexed validator, uint256 amount)",
  "event Rewarded(bytes32 indexed requestHash, address indexed validator, uint256 amount)",
  "event Finalized(bytes32 indexed requestHash, uint256 indexed agentId, uint8 verdict, bool passed)",
];

export const erc20Abi = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
];
