// Agent-side SDK: register an ERC-8004 identity, commit an intent before acting, link the execution.
import { Contract, Signer, randomBytes, hexlify, Interface } from "ethers";
import { identityAbi, poolAbi, validationAbi } from "./abi";
import { INTENT_TYPE, Intent, hashIntent, toDataURI } from "./intent";

export type Deployment = {
  chainId: number;
  startBlock: number;
  identityRegistry: string;
  reputationRegistry: string;
  validationRegistry: string;
  witnessPool: string;
  demoUSD: string;
};

export class WitnessAgent {
  readonly identity: Contract;
  readonly registry: Contract;
  readonly pool: Contract;

  constructor(
    readonly signer: Signer,
    readonly dep: Deployment,
    public agentId?: bigint,
  ) {
    this.identity = new Contract(dep.identityRegistry, identityAbi, signer);
    this.registry = new Contract(dep.validationRegistry, validationAbi, signer);
    this.pool = new Contract(dep.witnessPool, poolAbi, signer);
  }

  /** Mints an ERC-8004 identity whose registration file declares Witness as its validation layer. */
  async register(name: string, description: string): Promise<bigint> {
    const registration = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name,
      description,
      services: [],
      supportedTrust: ["reputation", "crypto-economic"],
      registrations: [{ agentRegistry: `eip155:${this.dep.chainId}:${this.dep.identityRegistry}` }],
      witness: { validationRegistry: this.dep.validationRegistry, validatorAddress: this.dep.witnessPool },
    };
    const receipt = await (await this.identity.register(toDataURI(registration))).wait();
    const iface = new Interface(identityAbi);
    for (const log of receipt!.logs) {
      if (log.address.toLowerCase() !== this.dep.identityRegistry.toLowerCase()) continue;
      const parsed = iface.parseLog(log);
      if (parsed?.name === "Transfer") return (this.agentId = parsed.args.tokenId as bigint);
    }
    throw new Error("register: no Transfer event in receipt");
  }

  /** Builds the intent for a contract call the agent is about to make. */
  async intentFor(
    purpose: string,
    call: { to: string; signature: string; args: (string | bigint)[]; value?: bigint },
    ttlSeconds = 120,
  ): Promise<Intent> {
    if (this.agentId === undefined) throw new Error("agent not registered");
    return {
      type: INTENT_TYPE,
      chainId: this.dep.chainId,
      agentId: this.agentId.toString(),
      from: await this.signer.getAddress(),
      purpose,
      call: {
        to: call.to,
        signature: call.signature,
        args: call.args.map(String),
        value: (call.value ?? 0n).toString(),
      },
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
      nonce: hexlify(randomBytes(8)),
    };
  }

  /** ERC-8004 validationRequest naming the Witness pool as validator. Returns the request hash. */
  async commit(intent: Intent): Promise<{ requestHash: string; txHash: string }> {
    const requestHash = hashIntent(intent);
    const tx = await this.registry.validationRequest(this.dep.witnessPool, this.agentId, toDataURI(intent), requestHash);
    await tx.wait();
    return { requestHash, txHash: tx.hash };
  }

  async link(requestHash: string, executionTxHash: string): Promise<string> {
    const tx = await this.pool.linkExecution(requestHash, executionTxHash);
    await tx.wait();
    return tx.hash;
  }
}
