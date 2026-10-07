// Creates (once) and funds the demo actors on Monad testnet:
// 3 validators that bond into the WitnessPool, and 2 agents with ERC-8004 identities.
// Keys live in .keys/actors.json (gitignored). Re-running only tops up what is missing.
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { Contract, JsonRpcProvider, Wallet, parseEther, parseUnits } from "ethers";
import { erc20Abi, poolAbi } from "../sdk/abi";
import { WitnessAgent } from "../sdk/client";
import { loadDeployment, RPC } from "./common";

const KEYS = ".keys/actors.json";
const GAS_FLOAT = parseEther("2");

type Actors = { validators: string[]; agents: { name: string; key: string; agentId?: string }[] };

async function main() {
  const dep = loadDeployment();
  const provider = new JsonRpcProvider(RPC, dep.chainId);
  const funder = new Wallet(process.env.PRIVATE_KEY!, provider);
  const actors = loadOrCreateActors();

  const pool = new Contract(dep.witnessPool, poolAbi, provider);
  const minBond: bigint = await pool.minBond();

  for (const key of actors.validators) {
    const w = new Wallet(key, provider);
    await topUp(funder, w.address, GAS_FLOAT + minBond);
    const { bond } = await pool.validators(w.address);
    if (bond < minBond) await (await (pool.connect(w) as Contract).bond({ value: minBond - bond })).wait();
    console.log("validator", w.address, "bonded");
  }

  const token = new Contract(dep.demoUSD, erc20Abi, funder);
  for (const a of actors.agents) {
    const w = new Wallet(a.key, provider);
    await topUp(funder, w.address, GAS_FLOAT);
    if (!a.agentId) {
      const agent = new WitnessAgent(w, dep);
      a.agentId = (await agent.register(a.name, `${a.name}: demo procurement agent using Witness validation`)).toString();
      writeFileSync(KEYS, JSON.stringify(actors, null, 2));
    }
    if ((await token.balanceOf(w.address)) < parseUnits("1000", 6)) {
      await (await token.mint(w.address, parseUnits("10000", 6))).wait();
    }
    console.log("agent", a.name, w.address, "agentId", a.agentId);
  }
}

function loadOrCreateActors(): Actors {
  if (existsSync(KEYS)) return JSON.parse(readFileSync(KEYS, "utf8"));
  mkdirSync(".keys", { recursive: true });
  const actors: Actors = {
    validators: [0, 1, 2].map(() => Wallet.createRandom().privateKey),
    agents: ["honest-buyer", "rogue-buyer"].map((name) => ({ name, key: Wallet.createRandom().privateKey })),
  };
  writeFileSync(KEYS, JSON.stringify(actors, null, 2), { mode: 0o600 });
  return actors;
}

async function topUp(funder: Wallet, to: string, target: bigint) {
  const bal = await funder.provider!.getBalance(to);
  if (bal >= target) return;
  await (await funder.sendTransaction({ to, value: target - bal })).wait();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
