// Records the demo for the submission video: runs the real validator node and agents against
// Monad testnet, streams their output into demo/stage.html next to the live explorer, and
// captures the page with headless Chrome's screencast (no OS screen-recording permission needed).
//
//   node demo/record.mjs            -> demo/out/demo.mp4 + demo/out/timeline.json
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = "demo/out";
const FRAMES = `${OUT}/frames`;
const PORT = 8790;
const CDP_PORT = 9333;
const t0 = Date.now();
const since = () => (Date.now() - t0) / 1000;
const timeline = [];
const mark = (label) => timeline.push({ t: since(), label });

// A validator that lied in the last take was slashed below the minimum bond and can no longer
// vote. Rebond everyone (and top up gas) before recording, off camera.
execFileSync("npx", ["tsx", "scripts/setup-actors.ts"], { stdio: "inherit" });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

// --- stage server -------------------------------------------------------------------------
const clients = new Set();
const send = (src, text) => {
  const data = `data: ${JSON.stringify({ src, text })}\n\n`;
  for (const c of clients) c.write(data);
};
createServer((req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(readFileSync("demo/stage.html"));
}).listen(PORT);

function run(src, cmd, args, env = {}) {
  send(src, `$ ${[cmd, ...args].join(" ")}`);
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const onData = (buf) =>
    buf
      .toString()
      .split("\n")
      .filter(Boolean)
      .forEach((line) => {
        send(src, line);
        timeline.push({ t: since(), src, line });
      });
  p.stdout.on("data", onData);
  p.stderr.on("data", onData);
  return p;
}
const done = (p) => new Promise((r) => p.on("exit", r));

// --- chrome screencast --------------------------------------------------------------------
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "witness-rec-"))}`, // fresh profile: no cached explorer build
  "--window-size=1920,1080",
  "--hide-scrollbars",
  "--autoplay-policy=no-user-gesture-required",
  "about:blank",
]);
await sleep(2000);
const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const cdp = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
const frames = [];
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method !== "Page.screencastFrame") return;
  const n = frames.length;
  writeFileSync(`${FRAMES}/${String(n).padStart(6, "0")}.jpg`, Buffer.from(msg.params.data, "base64"));
  frames.push(since());
  cdp("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
};
cdp("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
cdp("Page.enable");
await sleep(6000); // explorer loads its register from chain
cdp("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
mark("recording");

// --- the scenario -------------------------------------------------------------------------
await sleep(2000);
mark("node start");
const node = run("node", "npx", ["tsx", "node/validator.ts"], { LIAR: "2" });
await sleep(7000);
mark("honest start");
await done(run("agent", "npx", ["tsx", "agents/demo.ts", "honest"]));
mark("honest done");
await sleep(9000);
mark("rogue start");
await done(run("agent", "npx", ["tsx", "agents/demo.ts", "rogue"]));
mark("rogue done");
await sleep(10000);
mark("end");

cdp("Page.stopScreencast");
await sleep(500);
node.kill();
chrome.kill();

// --- frames -> mp4 (screencast frames arrive only on change, so each keeps its real duration)
const end = since();
const list = frames.map((t, i) => `file 'frames/${String(i).padStart(6, "0")}.jpg'\nduration ${((frames[i + 1] ?? end) - t).toFixed(3)}`);
writeFileSync(`${OUT}/frames.txt`, `ffconcat version 1.0\n${list.join("\n")}\nfile 'frames/${String(frames.length - 1).padStart(6, "0")}.jpg'\n`);
const start = timeline.find((e) => e.label === "recording").t;
writeFileSync(`${OUT}/timeline.json`, JSON.stringify(timeline.map((e) => ({ ...e, t: +(e.t - start).toFixed(2) })), null, 2));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${OUT}/frames.txt`, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", `${OUT}/demo.mp4`]);
console.log(`frames ${frames.length}, ${(end - start).toFixed(1)}s -> ${OUT}/demo.mp4`);
process.exit(0);
