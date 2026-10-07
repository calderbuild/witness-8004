// Everything the explorer shows is read straight from Monad testnet. No indexer, no backend.
import { Contract, Interface, JsonRpcProvider, formatEther, formatUnits } from "ethers";
import dep from "../../deployments/monadTestnet.json";
import { identityAbi, poolAbi, reputationAbi, validationAbi } from "../../sdk/abi";
import { fromDataURI, verifyExecution, type Intent, type Verdict } from "../../sdk/intent";

export { dep };
export const RPC = "https://testnet-rpc.monad.xyz";
export const EXPLORER = "https://testnet.monadvision.com";
const LOG_RANGE = 100;

export const provider = new JsonRpcProvider(RPC, dep.chainId, { staticNetwork: true, batchMaxCount: 10 });
const registry = new Contract(dep.validationRegistry, validationAbi, provider);
const pool = new Contract(dep.witnessPool, poolAbi, provider);
const reputation = new Contract(dep.reputationRegistry, reputationAbi, provider);
const identity = new Contract(dep.identityRegistry, identityAbi, provider);
const registryIface = new Interface(validationAbi);
const poolIface = new Interface(poolAbi);

export type Round = {
  hash: string;
  agentId: string;
  intent: Intent | null;
  commitTx: string | null;
  requestBlock: number;
  linkBlock: number;
  finalizeBlock: number;
  finalized: boolean;
  verdict: number;
  voters: string[];
  scores: number[];
  executionTx: string | null;
  latency: { blocks: number; seconds: number } | null; // commit block -> verdict block
};

const finalCache = new Map<string, Round>();
const blockTimeCache = new Map<number, number>();

export async function listRequestHashes(): Promise<string[]> {
  const hashes: string[] = await registry.getValidatorRequests(dep.witnessPool);
  return [...hashes].reverse();
}

export async function loadRound(hash: string): Promise<Round> {
  const cached = finalCache.get(hash);
  if (cached) return cached;
  const [status, requestBlock, round, executionTx] = await Promise.all([
    registry.getValidationStatus(hash),
    registry.requestBlock(hash),
    pool.getRound(hash),
    pool.executionOf(hash),
  ]);
  const rb = Number(requestBlock);
  const logs = await provider.getLogs({
    address: dep.validationRegistry,
    fromBlock: rb,
    toBlock: rb,
    topics: [registryIface.getEvent("ValidationRequest")!.topicHash, null, null, hash],
  });
  let intent: Intent | null = null;
  try {
    intent = logs[0] ? fromDataURI<Intent>(registryIface.parseLog(logs[0])!.args.requestURI) : null;
  } catch {
    intent = null;
  }
  const finalizeBlock = Number(round.finalizeBlock);
  const r: Round = {
    hash,
    agentId: status.agentId.toString(),
    intent,
    commitTx: logs[0]?.transactionHash ?? null,
    requestBlock: rb,
    linkBlock: Number(round.linkBlock),
    finalizeBlock,
    finalized: round.finalized,
    verdict: Number(round.verdict),
    voters: [...round.voters],
    scores: [...round.scores].map(Number),
    executionTx: /^0x0+$/.test(executionTx) ? null : executionTx,
    latency: round.finalized
      ? { blocks: finalizeBlock - rb, seconds: (await blockTime(finalizeBlock)) - (await blockTime(rb)) }
      : null,
  };
  if (r.finalized) finalCache.set(hash, r);
  return r;
}

// Monad block timestamps are whole seconds, so latency is shown in blocks as well.
async function blockTime(n: number): Promise<number> {
  const hit = blockTimeCache.get(n);
  if (hit !== undefined) return hit;
  const t = (await provider.getBlock(n))!.timestamp;
  blockTimeCache.set(n, t);
  return t;
}

export type Vote = { validator: string; score: number; tx: string };
export type Detail = {
  verdict: Verdict | null; // re-computed in the browser with the validators' own check
  executed: { from: string; to: string | null; data: string; value: bigint; blockNumber: number } | null;
  votes: Vote[];
  slashes: { validator: string; amount: string }[];
  rewards: { validator: string; amount: string }[];
  finalizeTx: string | null;
};

export async function loadDetail(r: Round): Promise<Detail> {
  const detail: Detail = { verdict: null, executed: null, votes: [], slashes: [], rewards: [], finalizeTx: null };
  if (r.executionTx && r.intent) {
    const [tx, receipt] = await Promise.all([
      provider.getTransaction(r.executionTx),
      provider.getTransactionReceipt(r.executionTx),
    ]);
    if (tx && receipt) {
      const block = await provider.getBlock(receipt.blockNumber);
      detail.executed = { from: tx.from, to: tx.to, data: tx.data, value: tx.value, blockNumber: receipt.blockNumber };
      detail.verdict = verifyExecution(r.intent, detail.executed, receipt.status === 1, {
        requestBlock: r.requestBlock,
        txTimestamp: block!.timestamp,
      });
    }
  }
  if (r.finalized) {
    const to = r.finalizeBlock;
    const from = Math.max(r.linkBlock || r.requestBlock, to - LOG_RANGE + 1);
    const logs = await provider.getLogs({ address: dep.witnessPool, fromBlock: from, toBlock: to, topics: [null, r.hash] });
    for (const log of logs) {
      const ev = poolIface.parseLog(log);
      if (ev?.name === "Voted") detail.votes.push({ validator: ev.args.validator, score: Number(ev.args.score), tx: log.transactionHash });
      if (ev?.name === "Slashed") detail.slashes.push({ validator: ev.args.validator, amount: formatEther(ev.args.amount) });
      if (ev?.name === "Rewarded") detail.rewards.push({ validator: ev.args.validator, amount: formatEther(ev.args.amount) });
      if (ev?.name === "Finalized") detail.finalizeTx = log.transactionHash;
    }
  }
  return detail;
}

export type AgentInfo = { agentId: string; name: string; validated: number; average: number; reputation: string };

export async function loadAgent(agentId: string): Promise<AgentInfo> {
  const [summary, rep, uri] = await Promise.all([
    registry.getSummary(agentId, [dep.witnessPool], "witness"),
    reputation.getSummary(agentId, [dep.witnessPool], "witness", ""),
    identity.tokenURI(agentId).catch(() => ""),
  ]);
  let name = `Agent ${agentId}`;
  try {
    name = fromDataURI<{ name: string }>(uri).name || name;
  } catch {
    /* registration file is not inline JSON; keep the id */
  }
  return {
    agentId,
    name,
    validated: Number(summary.count),
    average: Number(summary.avgResponse),
    reputation: formatUnits(rep.summaryValue, rep.summaryValueDecimals),
  };
}

export type ValidatorInfo = { address: string; bond: string; votes: number; slashes: number };

export async function loadValidators(): Promise<ValidatorInfo[]> {
  const n = Number(await pool.validatorCount());
  const addrs: string[] = await Promise.all(Array.from({ length: n }, (_, i) => pool.validatorList(i)));
  return Promise.all(
    addrs.map(async (address) => {
      const v = await pool.validators(address);
      return { address, bond: formatEther(v.bond), votes: Number(v.votes), slashes: Number(v.slashes) };
    }),
  );
}
