import { readFileSync } from "fs";
import type { Deployment } from "../sdk/client";

export const RPC = process.env.MONAD_RPC ?? "https://testnet-rpc.monad.xyz";

export function loadDeployment(): Deployment {
  return JSON.parse(readFileSync("deployments/monadTestnet.json", "utf8"));
}

export function loadActors(): { validators: string[]; agents: { name: string; key: string; agentId: string }[] } {
  return JSON.parse(readFileSync(".keys/actors.json", "utf8"));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
