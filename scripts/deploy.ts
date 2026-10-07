import { ethers, network } from "hardhat";
import { writeFileSync } from "fs";

// Canonical ERC-8004 registries on Monad testnet (checked with eth_getCode on 2026-10-07).
const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const MIN_BOND = ethers.parseEther("0.5");
const QUORUM = 3;
const SLASH_BPS = 1000;

async function main() {
  const [deployer] = await ethers.getSigners();
  const startBlock = await ethers.provider.getBlockNumber();
  const registry = await ethers.deployContract("ValidationRegistry", [IDENTITY]);
  await registry.waitForDeployment();
  const pool = await ethers.deployContract("WitnessPool", [
    await registry.getAddress(),
    REPUTATION,
    IDENTITY,
    MIN_BOND,
    QUORUM,
    SLASH_BPS,
  ]);
  await pool.waitForDeployment();
  const token = await ethers.deployContract("DemoUSD");
  await token.waitForDeployment();

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    startBlock,
    deployer: deployer.address,
    identityRegistry: IDENTITY,
    reputationRegistry: REPUTATION,
    validationRegistry: await registry.getAddress(),
    witnessPool: await pool.getAddress(),
    demoUSD: await token.getAddress(),
    deployTxs: {
      validationRegistry: registry.deploymentTransaction()!.hash,
      witnessPool: pool.deploymentTransaction()!.hash,
      demoUSD: token.deploymentTransaction()!.hash,
    },
    params: { minBond: MIN_BOND.toString(), quorum: QUORUM, slashBps: SLASH_BPS },
  };
  writeFileSync(`deployments/${network.name}.json`, JSON.stringify(out, null, 2) + "\n");
  console.log(out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
