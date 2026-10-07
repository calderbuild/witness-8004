import { useEffect, useMemo, useRef, useState } from "react";
import { Interface, formatUnits, getAddress } from "ethers";
import {
  EXPLORER,
  dep,
  listRequestHashes,
  loadAgent,
  loadDetail,
  loadRound,
  loadValidators,
  provider,
  type AgentInfo,
  type Detail,
  type Round,
  type ValidatorInfo,
} from "./chain";
import type { Intent } from "../../sdk/intent";

const LEDGER_SIZE = 20;
const POLL_MS = 2000;

const KNOWN: Record<string, string> = {
  [getAddress(dep.demoUSD)]: "dUSD token",
  [getAddress("0x000000000000000000000000000000000000ac3e")]: "ACME data vendor",
};
const ARG_LABELS: Record<string, string[]> = {
  "transfer(address,uint256)": ["Recipient", "Amount"],
  "approve(address,uint256)": ["Spender", "Amount"],
};

export default function App() {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(() => location.hash.match(/r=(0x[0-9a-f]{64})/i)?.[1] ?? null);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [validators, setValidators] = useState<ValidatorInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const seen = useRef<Map<string, boolean> | null>(null); // hash -> finalized, from the previous poll

  useEffect(() => {
    let stop = false;
    let failures = 0;
    async function tick() {
      try {
        const hashes = (await listRequestHashes()).slice(0, LEDGER_SIZE);
        // Monad's public RPC is load-balanced: a request one node already lists can revert on a
        // node a block behind. Skip that round for this poll; it shows up on the next one.
        const settled = await Promise.allSettled(hashes.map(loadRound));
        const next = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        if (hashes.length && !next.length) throw (settled[0] as PromiseRejectedResult).reason;
        if (stop) return;
        // A stamp presses in when a verdict lands while the page is open.
        const prev = seen.current;
        if (prev) setFresh(new Set(next.filter((r) => r.finalized && prev.get(r.hash) !== true).map((r) => r.hash)));
        seen.current = new Map(next.map((r) => [r.hash, r.finalized]));
        setRounds(next);
        failures = 0;
        setError(null);
        setLoaded(true);
        // The rolls lag a block behind on a lagging RPC node at worst; keep the last good values.
        const ids = [...new Set(next.map((r) => r.agentId))];
        Promise.all([Promise.all(ids.map(loadAgent)), loadValidators()])
          .then(([a, v]) => {
            if (stop) return;
            setAgents(a);
            setValidators(v);
          })
          .catch((e) => console.warn("agents/validators refresh failed, retrying next poll", e));
      } catch (e) {
        // One failed poll is usually a load-balanced RPC node a block behind; say so only when it repeats.
        console.warn("poll failed", e);
        if (!stop && ++failures >= 2) setError(`Monad testnet RPC did not answer (${(e as Error).message.slice(0, 80)}). Retrying every 3 seconds.`);
      }
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const shown = agentFilter ? rounds.filter((r) => r.agentId === agentFilter) : rounds;
  const current = rounds.find((r) => r.hash === selected) ?? shown[0] ?? null;

  function select(hash: string) {
    setSelected(hash);
    history.replaceState(null, "", `#r=${hash}`);
  }

  return (
    <div className="page">
      <Masthead />
      {error && <p className="notice" role="status">{error}</p>}
      <main className="desk">
        <section className="ledger" aria-label="Validation rounds">
          <header className="ledger-head">
            <h2>Register</h2>
            {agentFilter && (
              <button className="text-button" onClick={() => setAgentFilter(null)}>
                Show all agents
              </button>
            )}
          </header>
          {!loaded && !error && <p className="quiet">Reading the register from Monad testnet...</p>}
          {loaded && shown.length === 0 && (
            <p className="quiet">
              No intents committed yet. Run <code>npm run demo:honest</code> with a validator node up and the first round
              appears here.
            </p>
          )}
          <ol className="ledger-list">
            {shown.map((r) => (
              <li key={r.hash}>
                <button
                  className={`entry${current?.hash === r.hash ? " is-current" : ""}`}
                  onClick={() => select(r.hash)}
                  aria-current={current?.hash === r.hash}
                >
                  <span className="entry-agent">#{r.agentId}</span>
                  <span className="entry-purpose">{r.intent?.purpose ?? "Unreadable intent"}</span>
                  <span className="entry-meta">
                    {r.latency ? `${r.latency.blocks} blocks, ${r.latency.seconds}s` : "awaiting quorum"}
                  </span>
                  <Mark round={r} />
                </button>
              </li>
            ))}
          </ol>
        </section>
        {current ? <RoundForm key={current.hash} round={current} pressed={fresh.has(current.hash)} /> : <div />}
      </main>
      <section className="rolls">
        <AgentsRoll agents={agents} onPick={setAgentFilter} active={agentFilter} />
        <ValidatorsRoll validators={validators} />
      </section>
      <footer className="colophon">
        <span>
          ValidationRegistry <Addr a={dep.validationRegistry} /> · WitnessPool <Addr a={dep.witnessPool} /> · ERC-8004
          Identity <Addr a={dep.identityRegistry} /> · Reputation <Addr a={dep.reputationRegistry} />
        </span>
        <a href="https://github.com/calderbuild/witness-8004">Source on GitHub</a>
      </footer>
    </div>
  );
}

function Masthead() {
  const [head, setHead] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => provider.getBlockNumber().then(setHead).catch(() => setHead(null)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <header className="masthead">
      <h1 className="wordmark">Witness</h1>
      <p className="thesis">
        AI agents declare what they are about to do on chain. Bonded validators check the transaction against the
        declaration and record the verdict in ERC-8004.
      </p>
      <dl className="network">
        <div>
          <dt>Network</dt>
          <dd>Monad testnet · {dep.chainId}</dd>
        </div>
        <div>
          <dt>Block</dt>
          <dd className="mono">{head ? head.toLocaleString("en-US") : "..."}</dd>
        </div>
      </dl>
    </header>
  );
}

function Mark({ round }: { round: Round }) {
  if (!round.finalized) return <span className="mark mark-open">Open</span>;
  return round.verdict >= 50 ? (
    <span className="mark mark-pass">Pass {round.verdict}</span>
  ) : (
    <span className="mark mark-fail">Fail {round.verdict}</span>
  );
}

type Row = { label: string; declared: string; executed: string; ok: boolean | null };

function RoundForm({ round, pressed }: { round: Round; pressed: boolean }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  // Re-read until the verdict's logs are visible: the RPC node that answered may be a block behind.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      loadDetail(round)
        .then((d) => {
          if (!live) return;
          setDetail(d);
          if (!round.finalized || !d.finalizeTx) timer = setTimeout(load, 2000);
        })
        .catch(() => live && (timer = setTimeout(load, 2000)));
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [round]);

  const rows = useMemo(() => (round.intent ? buildRows(round, detail) : []), [round, detail]);
  const slashed = new Map(detail?.slashes.map((s) => [s.validator, s.amount]));
  const rewarded = new Map(detail?.rewards.map((s) => [s.validator, s.amount]));
  const votes = detail?.votes.length ? detail.votes : round.voters.map((v, i) => ({ validator: v, score: round.scores[i], tx: "" }));

  return (
    <article className="form" aria-label="Validation round">
      <header className="form-head">
        <div>
          <p className="form-title">Statement of intent, agent #{round.agentId}</p>
          <p className="form-purpose">{round.intent?.purpose ?? "The committed intent could not be read."}</p>
          <p className="form-ref mono">
            Request {round.hash.slice(0, 18)}... · committed block {round.requestBlock.toLocaleString("en-US")}
          </p>
        </div>
        <Stamp round={round} pressed={pressed} />
      </header>

      <table className="diff">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Declared before acting</th>
            <th scope="col">Executed on chain</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={r.ok === false ? "is-off" : undefined}>
              <th scope="row">
                {r.label}
                {r.ok === false && <span className="off-label">does not match</span>}
              </th>
              <td className="typed" data-col="Declared">{r.declared}</td>
              <td className="typed" data-col="Executed">{r.executed}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {round.intent && !round.executionTx && round.finalized && (
        <p className="quiet">The agent never linked an execution before the intent expired, so the quorum failed it.</p>
      )}

      <div className="form-foot">
        <section aria-label="Validator votes">
          <h3>Quorum of {votes.length || 3}</h3>
          <ul className="votes">
            {votes.map((v) => (
              <li key={v.validator}>
                <Addr a={v.validator} />
                <span className={`score${v.score >= 50 ? "" : " score-fail"}`}>{v.score}</span>
                {slashed.has(v.validator) && <span className="penalty">slashed {slashed.get(v.validator)} MON</span>}
                {rewarded.has(v.validator) && <span className="reward">+{rewarded.get(v.validator)} MON</span>}
                {v.tx && <TxLink tx={v.tx} label="vote" />}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="Transactions">
          <h3>Paper trail</h3>
          <ul className="trail">
            {round.commitTx && <li>Intent committed <TxLink tx={round.commitTx} /></li>}
            {round.executionTx && <li>Action executed <TxLink tx={round.executionTx} /></li>}
            {detail?.finalizeTx && <li>Verdict recorded <TxLink tx={detail.finalizeTx} /></li>}
            {round.latency && (
              <li>
                Intent to verdict: <strong>{round.latency.blocks} blocks</strong> ({round.latency.seconds}s)
              </li>
            )}
          </ul>
          {detail?.verdict && (
            <p className="recheck">
              Your browser re-ran the validators' check on this transaction: score {detail.verdict.score}.
            </p>
          )}
        </section>
      </div>
    </article>
  );
}

function Stamp({ round, pressed }: { round: Round; pressed: boolean }) {
  const cls = !round.finalized ? "stamp stamp-open" : round.verdict >= 50 ? "stamp stamp-pass" : "stamp stamp-fail";
  const word = !round.finalized ? "Awaiting quorum" : round.verdict >= 50 ? "Witnessed" : "Contradicted";
  return (
    <div className={`${cls}${pressed ? " is-pressed" : ""}`} role="img" aria-label={`${word}, score ${round.verdict}`}>
      <span className="stamp-word">{word}</span>
      {round.finalized && <span className="stamp-score">{round.verdict} / 100</span>}
    </div>
  );
}

function buildRows(round: Round, detail: Detail | null): Row[] {
  const intent = round.intent as Intent;
  const ex = detail?.executed ?? null;
  const ok = (name: string) => detail?.verdict?.checks.find((c) => c.name === name)?.ok ?? null;
  const none = detail ? (round.executionTx ? "not found" : "nothing linked") : "...";
  const iface = new Interface([`function ${intent.call.signature}`]);
  const fn = iface.getFunction(intent.call.signature)!;
  let decoded: string[] | null = null;
  if (ex) {
    try {
      decoded = iface.decodeFunctionData(fn, ex.data).map(String);
    } catch {
      decoded = null;
    }
  }
  const isToken = getAddress(intent.call.to) === getAddress(dep.demoUSD);
  const labels = ARG_LABELS[intent.call.signature] ?? fn.inputs.map((p, i) => `Argument ${i + 1} (${p.type})`);
  const fmt = (type: string, v: string) =>
    type === "address" ? name(v) : type === "uint256" && isToken ? `${formatUnits(v, 6)} dUSD` : v;

  const rows: Row[] = [
    { label: "Sender", declared: name(intent.from), executed: ex ? name(ex.from) : none, ok: ok("from") },
    { label: "Contract", declared: name(intent.call.to), executed: ex ? name(ex.to ?? "contract creation") : none, ok: ok("to") },
    {
      label: "Function",
      declared: intent.call.signature,
      executed: ex ? (decoded ? intent.call.signature : `other (${ex.data.slice(0, 10)})`) : none,
      ok: ok("function"),
    },
  ];
  fn.inputs.forEach((p, i) => {
    const d = intent.call.args[i];
    const e = decoded?.[i];
    rows.push({
      label: labels[i],
      declared: fmt(p.type, d),
      executed: e === undefined ? none : fmt(p.type, e),
      ok: e === undefined ? null : same(d, e),
    });
  });
  rows.push(
    {
      label: "Order",
      declared: `commit at block ${round.requestBlock.toLocaleString("en-US")}`,
      executed: ex ? `executed at block ${ex.blockNumber.toLocaleString("en-US")}` : none,
      ok: ok("committed before acting"),
    },
    {
      label: "Outcome",
      declared: "succeeds",
      executed: detail?.verdict ? (ok("succeeded") ? "succeeded" : "reverted") : none,
      ok: ok("succeeded"),
    },
  );
  return rows;
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function name(a: string) {
  try {
    const k = getAddress(a);
    return KNOWN[k] ? `${KNOWN[k]} ${k.slice(0, 6)}..${k.slice(-4)}` : `${k.slice(0, 6)}..${k.slice(-4)}`;
  } catch {
    return a;
  }
}

function Addr({ a }: { a: string }) {
  return (
    <a className="mono addr" href={`${EXPLORER}/address/${a}`} target="_blank" rel="noreferrer">
      {a.slice(0, 6)}..{a.slice(-4)}
    </a>
  );
}

function TxLink({ tx, label }: { tx: string; label?: string }) {
  return (
    <a className="mono txlink" href={`${EXPLORER}/tx/${tx}`} target="_blank" rel="noreferrer">
      {label ?? `${tx.slice(0, 10)}..`}
    </a>
  );
}

function AgentsRoll({
  agents,
  onPick,
  active,
}: {
  agents: AgentInfo[];
  onPick: (id: string | null) => void;
  active: string | null;
}) {
  return (
    <section className="roll" aria-label="Agents">
      <h2>Agents</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">ERC-8004 id</th>
            <th scope="col">Name</th>
            <th scope="col">Validated</th>
            <th scope="col">Average</th>
            <th scope="col">Reputation feedback</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.agentId} className={active === a.agentId ? "is-current" : undefined}>
              <td>
                <button className="text-button mono" onClick={() => onPick(active === a.agentId ? null : a.agentId)}>
                  #{a.agentId}
                </button>
              </td>
              <td>{a.name}</td>
              <td className="num">{a.validated}</td>
              <td className={`num${a.average < 50 ? " score-fail" : ""}`}>{a.average}</td>
              <td className="num">{a.reputation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ValidatorsRoll({ validators }: { validators: ValidatorInfo[] }) {
  return (
    <section className="roll" aria-label="Validators">
      <h2>Validators</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Address</th>
            <th scope="col">Bond (MON)</th>
            <th scope="col">Votes</th>
            <th scope="col">Slashed</th>
          </tr>
        </thead>
        <tbody>
          {validators.map((v) => (
            <tr key={v.address}>
              <td>
                <Addr a={v.address} />
              </td>
              <td className="num">{Number(v.bond).toFixed(3)}</td>
              <td className="num">{v.votes}</td>
              <td className={`num${v.slashes ? " score-fail" : ""}`}>{v.slashes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
