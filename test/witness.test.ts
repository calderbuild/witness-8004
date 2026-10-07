import { expect } from "chai";
import { ethers } from "hardhat";

const BOND = ethers.parseEther("1");
const QUORUM = 3;
const SLASH_BPS = 1000; // 10%

async function setup() {
  const [deployer, agentOwner, stranger, v1, v2, v3, v4] = await ethers.getSigners();
  const identity = await ethers.deployContract("MockIdentity");
  const reputation = await ethers.deployContract("MockReputation", [await identity.getAddress()]);
  const registry = await ethers.deployContract("ValidationRegistry", [await identity.getAddress()]);
  const pool = await ethers.deployContract("WitnessPool", [
    await registry.getAddress(),
    await reputation.getAddress(),
    await identity.getAddress(),
    BOND,
    QUORUM,
    SLASH_BPS,
  ]);
  await identity.connect(agentOwner).register();
  const agentId = 0n;
  for (const v of [v1, v2, v3, v4]) await pool.connect(v).bond({ value: BOND });
  return { deployer, agentOwner, stranger, v1, v2, v3, v4, identity, reputation, registry, pool, agentId };
}

async function commit(ctx: Awaited<ReturnType<typeof setup>>, label: string) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(label));
  await ctx.registry
    .connect(ctx.agentOwner)
    .validationRequest(await ctx.pool.getAddress(), ctx.agentId, `data:,${label}`, hash);
  return hash;
}

describe("ValidationRegistry", () => {
  it("only the agent owner can request, and request hashes are unique", async () => {
    const ctx = await setup();
    const pool = await ctx.pool.getAddress();
    const h = ethers.id("intent");
    await expect(
      ctx.registry.connect(ctx.stranger).validationRequest(pool, ctx.agentId, "x", h),
    ).to.be.revertedWith("Not authorized");
    await expect(ctx.registry.connect(ctx.agentOwner).validationRequest(pool, ctx.agentId, "x", h))
      .to.emit(ctx.registry, "ValidationRequest")
      .withArgs(pool, ctx.agentId, "x", h);
    await expect(
      ctx.registry.connect(ctx.agentOwner).validationRequest(pool, ctx.agentId, "x", h),
    ).to.be.revertedWith("exists");
  });

  it("only the named validator can respond", async () => {
    const ctx = await setup();
    const h = await commit(ctx, "a");
    await expect(
      ctx.registry.connect(ctx.stranger).validationResponse(h, 100, "", ethers.ZeroHash, "t"),
    ).to.be.revertedWith("not validator");
  });
});

describe("WitnessPool", () => {
  it("honest action: quorum passes, registry and reputation are written, nobody slashed", async () => {
    const ctx = await setup();
    const h = await commit(ctx, "honest");
    const tx = ethers.id("execution-tx");
    await expect(ctx.pool.connect(ctx.agentOwner).linkExecution(h, tx))
      .to.emit(ctx.pool, "ExecutionLinked")
      .withArgs(h, ctx.agentId, tx);

    await ctx.pool.connect(ctx.v1).vote(h, 100, "ipfs://e1");
    await ctx.pool.connect(ctx.v2).vote(h, 90, "ipfs://e2");
    const last = ctx.pool.connect(ctx.v3).vote(h, 100, "ipfs://e3");
    await expect(last).to.emit(ctx.pool, "Finalized").withArgs(h, ctx.agentId, 100, true);
    await expect(last).to.emit(ctx.registry, "ValidationResponse");
    await expect(last)
      .to.emit(ctx.reputation, "NewFeedback")
      .withArgs(ctx.agentId, await ctx.pool.getAddress(), 100, "witness", "pass", h);
    await expect(last).not.to.emit(ctx.pool, "Slashed");

    const status = await ctx.registry.getValidationStatus(h);
    expect(status.response).to.equal(100);
    expect(status.tag).to.equal("witness");
    const [count, avg] = await ctx.registry.getSummary(ctx.agentId, [], "witness");
    expect(count).to.equal(1n);
    expect(avg).to.equal(100);

    const round = await ctx.pool.getRound(h);
    const finalizeBlock = (await (await last).wait())!.blockNumber;
    expect(round.finalizeBlock).to.equal(finalizeBlock);
    expect(round.linkBlock).to.be.greaterThan(0n);
    expect(await ctx.registry.requestBlock(h)).to.be.greaterThan(0n);
  });

  it("rogue action: quorum fails it and the validator who covered for it is slashed to the others", async () => {
    const ctx = await setup();
    const h = await commit(ctx, "rogue");
    await ctx.pool.connect(ctx.v1).vote(h, 0, "");
    await ctx.pool.connect(ctx.v2).vote(h, 100, ""); // lies
    const last = ctx.pool.connect(ctx.v3).vote(h, 5, "");
    const cut = (BOND * BigInt(SLASH_BPS)) / 10_000n;
    await expect(last).to.emit(ctx.pool, "Finalized").withArgs(h, ctx.agentId, 5, false);
    await expect(last).to.emit(ctx.pool, "Slashed").withArgs(h, ctx.v2.address, cut);
    await expect(last)
      .to.emit(ctx.reputation, "NewFeedback")
      .withArgs(ctx.agentId, await ctx.pool.getAddress(), 5, "witness", "fail", h);

    expect((await ctx.pool.validators(ctx.v2.address)).bond).to.equal(BOND - cut);
    expect((await ctx.pool.validators(ctx.v2.address)).slashes).to.equal(1);
    expect((await ctx.pool.validators(ctx.v1.address)).bond).to.equal(BOND + cut / 2n);
    expect((await ctx.pool.validators(ctx.v3.address)).bond).to.equal(BOND + cut / 2n);
  });

  it("rejects unbonded, duplicate, late and foreign votes", async () => {
    const ctx = await setup();
    const h = await commit(ctx, "rules");
    await expect(ctx.pool.connect(ctx.stranger).vote(h, 100, "")).to.be.revertedWith("not bonded");
    await expect(ctx.pool.connect(ctx.v1).vote(h, 101, "")).to.be.revertedWith("score>100");
    await ctx.pool.connect(ctx.v1).vote(h, 100, "");
    await expect(ctx.pool.connect(ctx.v1).vote(h, 100, "")).to.be.revertedWith("voted");
    await ctx.pool.connect(ctx.v2).vote(h, 100, "");
    await ctx.pool.connect(ctx.v3).vote(h, 100, "");
    await expect(ctx.pool.connect(ctx.v4).vote(h, 100, "")).to.be.revertedWith("finalized");

    const foreign = ethers.id("foreign");
    await ctx.registry.connect(ctx.agentOwner).validationRequest(ctx.stranger.address, ctx.agentId, "", foreign);
    await expect(ctx.pool.connect(ctx.v1).vote(foreign, 100, "")).to.be.revertedWith("not our request");
  });

  it("only the agent can link its execution, once", async () => {
    const ctx = await setup();
    const h = await commit(ctx, "link");
    await expect(ctx.pool.connect(ctx.stranger).linkExecution(h, ethers.id("t"))).to.be.revertedWith("not agent");
    await ctx.pool.connect(ctx.agentOwner).linkExecution(h, ethers.id("t"));
    await expect(ctx.pool.connect(ctx.agentOwner).linkExecution(h, ethers.id("t2"))).to.be.revertedWith(
      "already linked",
    );
  });

  it("validators cannot exit with open votes, and get their bond back after", async () => {
    const ctx = await setup();
    const h = await commit(ctx, "exit");
    await ctx.pool.connect(ctx.v1).vote(h, 100, "");
    await expect(ctx.pool.connect(ctx.v1).exit()).to.be.revertedWith("open votes");
    await ctx.pool.connect(ctx.v2).vote(h, 100, "");
    await ctx.pool.connect(ctx.v3).vote(h, 100, "");
    await expect(ctx.pool.connect(ctx.v1).exit()).to.changeEtherBalance(ctx.v1, BOND);
    await expect(ctx.pool.connect(ctx.v1).vote(await commit(ctx, "after"), 100, "")).to.be.revertedWith("not bonded");
  });

  it("requires the minimum bond", async () => {
    const ctx = await setup();
    await expect(ctx.pool.connect(ctx.stranger).bond({ value: BOND - 1n })).to.be.revertedWith("bond < min");
  });
});
