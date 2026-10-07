// Intent format, canonical hashing and the check every validator runs.
// Canonicalization follows SafeReceipt's canonicalize (sorted keys, no whitespace),
// which is the declared pre-existing foundation for this file.
import { Interface, getAddress, keccak256, toUtf8Bytes } from "ethers";

export const INTENT_TYPE = "witness.intent/v1";

export type Intent = {
  type: typeof INTENT_TYPE;
  chainId: number;
  agentId: string;
  from: string; // the wallet that will send the action tx
  purpose: string; // human-readable reason, shown in the explorer
  call: {
    to: string;
    signature: string; // e.g. "transfer(address,uint256)"
    args: string[]; // stringified, in order
    value: string; // max native value in wei
  };
  expiresAt: number; // unix seconds; the action must land before this
  nonce: string;
};

export type Check = { name: string; ok: boolean; expected: string; actual: string };
export type Verdict = { score: number; checks: Check[] };

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashIntent(intent: Intent): string {
  return keccak256(toUtf8Bytes(canonicalize(intent)));
}

export function toDataURI(obj: unknown): string {
  return `data:application/json,${encodeURIComponent(canonicalize(obj))}`;
}

export function fromDataURI<T>(uri: string): T {
  const prefix = "data:application/json,";
  if (!uri.startsWith(prefix)) throw new Error(`unsupported URI: ${uri.slice(0, 40)}`);
  return JSON.parse(decodeURIComponent(uri.slice(prefix.length))) as T;
}

type TxLike = { from: string; to: string | null; data: string; value: bigint; blockNumber: number | null };
type Timing = { requestBlock: number; txTimestamp: number };

/**
 * Compares an executed tx with the committed intent.
 * All checks pass -> 100. Any failure -> at most 20, so a single mismatch always fails the 50 threshold.
 */
export function verifyExecution(intent: Intent, tx: TxLike, succeeded: boolean, timing: Timing): Verdict {
  const iface = new Interface([`function ${intent.call.signature}`]);
  const fn = iface.getFunction(intent.call.signature)!;
  let decoded: string[] | null = null;
  try {
    decoded = iface.decodeFunctionData(fn, tx.data).map((a) => normalize(a));
  } catch {
    decoded = null;
  }
  const expectedArgs = intent.call.args.map(normalize);

  const checks: Check[] = [
    { name: "succeeded", ok: succeeded, expected: "status 1", actual: succeeded ? "status 1" : "reverted" },
    { name: "from", ok: same(tx.from, intent.from), expected: intent.from, actual: tx.from },
    { name: "to", ok: !!tx.to && same(tx.to, intent.call.to), expected: intent.call.to, actual: tx.to ?? "contract creation" },
    {
      name: "function",
      ok: tx.data.slice(0, 10).toLowerCase() === fn.selector,
      expected: `${intent.call.signature} ${fn.selector}`,
      actual: tx.data.slice(0, 10),
    },
    {
      name: "args",
      ok: !!decoded && canonicalize(decoded) === canonicalize(expectedArgs),
      expected: expectedArgs.join(", "),
      actual: decoded ? decoded.join(", ") : "undecodable",
    },
    {
      name: "value",
      ok: tx.value <= BigInt(intent.call.value),
      expected: `<= ${intent.call.value}`,
      actual: tx.value.toString(),
    },
    {
      name: "committed before acting",
      ok: tx.blockNumber !== null && tx.blockNumber > timing.requestBlock,
      expected: `block > ${timing.requestBlock}`,
      actual: `block ${tx.blockNumber}`,
    },
    {
      name: "before expiry",
      ok: timing.txTimestamp <= intent.expiresAt,
      expected: `<= ${intent.expiresAt}`,
      actual: String(timing.txTimestamp),
    },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const score = passed === checks.length ? 100 : Math.floor((20 * passed) / checks.length);
  return { score, checks };
}

function normalize(v: unknown): string {
  const s = String(v);
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? getAddress(s) : s;
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}
