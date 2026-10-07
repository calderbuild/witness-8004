// Demo procurement agents. Each one pays a vendor invoice in dUSD through the Witness flow:
// commit intent -> execute -> link -> wait for the validator quorum's verdict.
//
//   npx tsx agents/demo.ts honest   pays exactly what it committed to
//   npx tsx agents/demo.ts rogue    commits to paying the vendor, then pays someone else 10x
import { Contract, JsonRpcProvider, Wallet, getAddress, parseUnits } from "ethers";
import { erc20Abi, poolAbi, validationAbi } from "../sdk/abi";
import { WitnessAgent } from "../sdk/client";
import { loadActors, loadDeployment, RPC, sleep } from "../scripts/common";

const VENDOR = getAddress("0x000000000000000000000000000000000000ac3e"); // "ACME data vendor"
const ATTACKER = getAddress("0x00000000000000000000000000000000deadbeef");

async function main() {
  const mode = process.argv[2];
  if (mode !== "honest" && mode !== "rogue") throw new Error("usage: demo.ts honest|rogue");
  const dep = loadDeployment();
  const provider = new JsonRpcProvider(RPC, dep.chainId, { staticNetwork: true });
  const actor = loadActors().agents[mode === "honest" ? 0 : 1];
  const wallet = new Wallet(actor.key, provider);
  const agent = new WitnessAgent(wallet, dep, BigInt(actor.agentId));
  const token = new Contract(dep.demoUSD, erc20Abi, wallet);

  const invoice = Math.floor(1000 + Math.random() * 9000);
  const amount = parseUnits("25", 6);
  const intent = await agent.intentFor(`Pay ACME invoice #${invoice}: 25 dUSD for a weather dataset`, {
    to: dep.demoUSD,
    signature: "transfer(address,uint256)",
    args: [VENDOR, amount],
  });

  const t0 = Date.now();
  const { requestHash, txHash: commitTx } = await agent.commit(intent);
  log(t0, `committed intent ${requestHash}`, commitTx);

  const exec =
    mode === "honest" ? await token.transfer(VENDOR, amount) : await token.transfer(ATTACKER, amount * 10n);
  await exec.wait();
  log(t0, mode === "honest" ? "paid vendor 25 dUSD" : "paid ATTACKER 250 dUSD instead", exec.hash);

  const linkTx = await agent.link(requestHash, exec.hash);
  log(t0, "linked execution", linkTx);

  const pool = new Contract(dep.witnessPool, poolAbi, provider);
  for (;;) {
    const round = await pool.getRound(requestHash);
    if (round.finalized) {
      log(t0, `verdict ${round.verdict} (${round.verdict >= 50 ? "PASS" : "FAIL"}), votes [${round.scores.join(", ")}]`);
      break;
    }
    if (Date.now() - t0 > 120_000) throw new Error("no verdict after 120s: is the validator node running?");
    await sleep(300);
  }
  const registry = new Contract(dep.validationRegistry, validationAbi, provider);
  const [count, avg] = await registry.getSummary(agent.agentId, [dep.witnessPool], "witness");
  console.log(`agent ${agent.agentId} validation summary: ${count} validated actions, average ${avg}/100`);
  console.log(`explorer: request ${requestHash}`);
}

function log(t0: number, msg: string, tx?: string) {
  console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s  ${msg}${tx ? `  tx ${tx}` : ""}`);
}


main().catch((e) => {
  console.error(e);
  process.exit(1);
});
