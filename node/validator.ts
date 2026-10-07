// Witness validator node. Runs one or more validator keys against the WitnessPool:
// watches ERC-8004 ValidationRequest events addressed to the pool, waits for the agent to link
// its execution tx, re-checks that tx against the committed intent, and votes.
//
//   npx tsx node/validator.ts            all validator keys in .keys/actors.json
//   LIAR=2 npx tsx node/validator.ts     validator #2 always votes 100 (demo of slashing)
import { Contract, Interface, JsonRpcProvider, Log, Wallet } from "ethers";
import { poolAbi, validationAbi } from "../sdk/abi";
import { Intent, fromDataURI, toDataURI, verifyExecution, Verdict } from "../sdk/intent";
import { loadActors, loadDeployment, RPC, sleep } from "../scripts/common";

const MAX_LOG_RANGE = 100; // Monad testnet RPC rejects wider eth_getLogs ranges
const POLL_MS = 400;
// Monad charges the gas limit, not gas used. The vote that reaches quorum also writes the
// validation response and reputation feedback, and any vote may turn out to be that one.
const VOTE_GAS = 750_000n; // finalize measured at ~540k on testnet with the canonical Reputation Registry

const dep = loadDeployment();
const provider = new JsonRpcProvider(RPC, dep.chainId, { staticNetwork: true });
const liar = process.env.LIAR === undefined ? -1 : Number(process.env.LIAR);
const signers = loadActors().validators.map((k) => new Wallet(k, provider));
const registryIface = new Interface(validationAbi);
const poolIface = new Interface(poolAbi);
const pool = new Contract(dep.witnessPool, poolAbi, provider);

type Pending = { intent: Intent; requestBlock: number; seenAt: number };
const pending = new Map<string, Pending>();

async function main() {
  console.log(`witness node: ${signers.length} validators, pool ${dep.witnessPool}${liar >= 0 ? `, LIAR=${liar}` : ""}`);
  let cursor = Number(process.env.FROM_BLOCK ?? (await provider.getBlockNumber()) - 20);
  for (;;) {
    const head = await provider.getBlockNumber();
    while (cursor <= head) {
      const to = Math.min(cursor + MAX_LOG_RANGE - 1, head);
      const logs = await provider.getLogs({
        address: [dep.validationRegistry, dep.witnessPool],
        fromBlock: cursor,
        toBlock: to,
      });
      for (const log of logs) await handle(log);
      cursor = to + 1;
    }
    await expire();
    await sleep(POLL_MS);
  }
}

async function handle(log: Log) {
  if (log.address.toLowerCase() === dep.validationRegistry.toLowerCase()) {
    const ev = registryIface.parseLog(log);
    if (ev?.name !== "ValidationRequest") return;
    if (ev.args.validatorAddress.toLowerCase() !== dep.witnessPool.toLowerCase()) return;
    const requestHash: string = ev.args.requestHash;
    try {
      const intent = fromDataURI<Intent>(ev.args.requestURI);
      pending.set(requestHash, { intent, requestBlock: log.blockNumber, seenAt: Date.now() });
      console.log(`[request] ${short(requestHash)} agent ${intent.agentId}: ${intent.purpose}`);
    } catch (e) {
      // An intent we cannot read cannot be validated: fail it rather than leave it open.
      console.log(`[request] ${short(requestHash)} unreadable intent, voting 0`);
      await voteAll(requestHash, { score: 0, checks: [{ name: "intent readable", ok: false, expected: "data:application/json", actual: String(e) }] });
    }
    return;
  }
  const ev = poolIface.parseLog(log);
  if (ev?.name === "ExecutionLinked") {
    const p = pending.get(ev.args.requestHash);
    if (!p) return; // request committed before this node started; FROM_BLOCK can replay it
    pending.delete(ev.args.requestHash);
    await validate(ev.args.requestHash, ev.args.txHash, p);
  } else if (ev?.name === "Finalized") {
    console.log(`[final]   ${short(ev.args.requestHash)} verdict ${ev.args.verdict} ${ev.args.passed ? "PASS" : "FAIL"}`);
  } else if (ev?.name === "Slashed") {
    console.log(`[slash]   ${short(ev.args.requestHash)} validator ${short(ev.args.validator)} lost ${ev.args.amount} wei`);
  }
}

async function validate(requestHash: string, txHash: string, p: Pending) {
  const [tx, receipt] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
  if (!tx || !receipt) {
    await voteAll(requestHash, { score: 0, checks: [{ name: "tx exists", ok: false, expected: txHash, actual: "not found" }] });
    return;
  }
  const block = await provider.getBlock(receipt.blockNumber);
  const verdict = verifyExecution(
    p.intent,
    { from: tx.from, to: tx.to, data: tx.data, value: tx.value, blockNumber: receipt.blockNumber },
    receipt.status === 1,
    { requestBlock: p.requestBlock, txTimestamp: block!.timestamp },
  );
  const failed = verdict.checks.filter((c) => !c.ok).map((c) => c.name);
  console.log(`[check]   ${short(requestHash)} score ${verdict.score}${failed.length ? ` failed: ${failed.join(", ")}` : ""}`);
  await voteAll(requestHash, verdict);
}

// Intents whose deadline passed with no linked execution are failed.
async function expire() {
  const now = Math.floor(Date.now() / 1000);
  for (const [hash, p] of pending) {
    if (p.intent.expiresAt >= now) continue;
    pending.delete(hash);
    console.log(`[expire]  ${short(hash)} no execution linked before expiry`);
    await voteAll(hash, { score: 0, checks: [{ name: "execution linked", ok: false, expected: `before ${p.intent.expiresAt}`, actual: "none" }] });
  }
}

async function voteAll(requestHash: string, verdict: Verdict) {
  await Promise.all(
    signers.map(async (s, i) => {
      if (await pool.hasVoted(requestHash, s.address)) return;
      const score = i === liar ? 100 : verdict.score;
      const evidence = toDataURI({ score, failed: verdict.checks.filter((c) => !c.ok) });
      try {
        const tx = await (pool.connect(s) as Contract).vote(requestHash, score, evidence, { gasLimit: VOTE_GAS });
        await tx.wait();
        console.log(`[vote]    ${short(requestHash)} v${i} ${short(s.address)} -> ${score} ${tx.hash}`);
      } catch (e) {
        console.log(`[vote]    ${short(requestHash)} v${i} failed: ${(e as Error).message.slice(0, 120)}`);
      }
    }),
  );
}

const short = (h: string) => `${h.slice(0, 8)}..${h.slice(-4)}`;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
