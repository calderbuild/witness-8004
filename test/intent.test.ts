import { expect } from "chai";
import { Interface, getAddress } from "ethers";
import { Intent, INTENT_TYPE, canonicalize, hashIntent, fromDataURI, toDataURI, verifyExecution } from "../sdk/intent";

const TOKEN = getAddress("0x75daf31135a3e087856e2a10f2517bdc30bca943");
const AGENT = getAddress("0x5d42899cef36f11f433be0cc172a31ebf5c87758");
const VENDOR = getAddress("0x000000000000000000000000000000000000ac3e");
const ATTACKER = getAddress("0x00000000000000000000000000000000deadbeef");
const erc20 = new Interface(["function transfer(address,uint256)", "function approve(address,uint256)"]);

const intent: Intent = {
  type: INTENT_TYPE,
  chainId: 10143,
  agentId: "1",
  from: AGENT,
  purpose: "pay invoice",
  call: { to: TOKEN, signature: "transfer(address,uint256)", args: [VENDOR, "25000000"], value: "0" },
  expiresAt: 2_000,
  nonce: "0x01",
};
const timing = { requestBlock: 100, txTimestamp: 1_000 };
const tx = (data: string, over: Partial<{ from: string; to: string; value: bigint; blockNumber: number }> = {}) => ({
  from: AGENT,
  to: TOKEN,
  data,
  value: 0n,
  blockNumber: 101,
  ...over,
});
const failed = (v: ReturnType<typeof verifyExecution>) => v.checks.filter((c) => !c.ok).map((c) => c.name);

describe("intent verification", () => {
  it("passes the exact committed action", () => {
    const v = verifyExecution(intent, tx(erc20.encodeFunctionData("transfer", [VENDOR, 25_000_000n])), true, timing);
    expect(v.score).to.equal(100);
    expect(failed(v)).to.deep.equal([]);
  });

  it("fails a different recipient or amount", () => {
    const v1 = verifyExecution(intent, tx(erc20.encodeFunctionData("transfer", [ATTACKER, 25_000_000n])), true, timing);
    const v2 = verifyExecution(intent, tx(erc20.encodeFunctionData("transfer", [VENDOR, 250_000_000n])), true, timing);
    expect(v1.score).to.be.lessThan(50);
    expect(failed(v1)).to.deep.equal(["args"]);
    expect(v2.score).to.be.lessThan(50);
  });

  it("fails a different function, contract, sender, revert or extra value", () => {
    const ok = erc20.encodeFunctionData("transfer", [VENDOR, 25_000_000n]);
    const cases = [
      verifyExecution(intent, tx(erc20.encodeFunctionData("approve", [VENDOR, 25_000_000n])), true, timing),
      verifyExecution(intent, tx(ok, { to: VENDOR }), true, timing),
      verifyExecution(intent, tx(ok, { from: ATTACKER }), true, timing),
      verifyExecution(intent, tx(ok), false, timing),
      verifyExecution(intent, tx(ok, { value: 1n }), true, timing),
    ];
    for (const v of cases) expect(v.score).to.be.lessThan(50);
  });

  it("fails an action executed before the intent was committed or after expiry", () => {
    const ok = erc20.encodeFunctionData("transfer", [VENDOR, 25_000_000n]);
    expect(verifyExecution(intent, tx(ok, { blockNumber: 100 }), true, timing).score).to.be.lessThan(50);
    expect(verifyExecution(intent, tx(ok), true, { requestBlock: 100, txTimestamp: 2_001 }).score).to.be.lessThan(50);
  });

  it("hashes independently of key order and round-trips through data URIs", () => {
    const reordered = JSON.parse(canonicalize(intent)) as Intent;
    expect(hashIntent({ ...reordered })).to.equal(hashIntent(intent));
    expect(fromDataURI<Intent>(toDataURI(intent))).to.deep.equal(JSON.parse(canonicalize(intent)));
  });
});
