import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import keyPairJson from "../keypair2.json" with { type: "json" };

const CTF_PACKAGE_ID = "0xd56e5075ba297f9e37085a37bb0abba69fabdf9987f8f4a6086a3693d88efbfd";
const ARENA_ID = "0xc211bf89f9acbf24ece070b1deb5f83b62828b7656237179759ee2135841ca3e";
// players Table object ID (dynamic fields live here, not on Arena directly)
const PLAYERS_TABLE_ID = "0x5866b885fa6dda42f05daf28f7fde161d4e93d9991f5ba8f8353d11f6bcbf13d";
const CLOCK_ID = "0x6";
const RPC_URL = "https://fullnode.testnet.sui.io:443";

const FRIENDLY_ADDRESSES = new Set([
  "0x63eb8d321f939a32b229f797d64c29e0b58efa8a6734150d3528ebcfb0613508", // wallet 1
  "0x22c5bb870047d22af071b46943eaa60c58d07d848c7a345d2256d471bc455b8c", // wallet 2
  "0x73d95993c2de535c6749f511256b5387e3c46fbf5ba62c22da7c29685721c662", // wallet 3
  "0xbf1cabdaff48602de4c2dc2491714a668a2974b96bcdeb965697e9b3574f0acc", // extra wallet
]);

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: RPC_URL,
});

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

interface PlayerState {
  shield: number;
  last_action_ms: number;
}

interface PlayerEntry {
  address: string;
  state: PlayerState;
}

async function getPlayerState(address: string): Promise<PlayerState | null> {
  try {
    const result = await rpc('suix_getDynamicFieldObject', [
      PLAYERS_TABLE_ID,
      { type: 'address', value: address },
    ]) as { data?: { content?: { fields?: { value?: { fields?: { shield: string; last_action_ms: string } } } } } };

    const fields = result?.data?.content?.fields?.value?.fields;
    if (!fields) return null;
    return {
      shield: Number(fields.shield),
      last_action_ms: Number(fields.last_action_ms),
    };
  } catch {
    return null;
  }
}

// Scan up to maxPages * 50 players to find high-shield opponents
async function scanPlayers(myAddress: string, maxPages = 4): Promise<PlayerEntry[]> {
  let cursor: string | null = null;
  const all: PlayerEntry[] = [];

  for (let page = 0; page < maxPages; page++) {
    const result = await rpc('suix_getDynamicFields', [PLAYERS_TABLE_ID, cursor, 50]) as {
      data: Array<{ name: { type: string; value: string } }>;
      nextCursor: string | null;
      hasNextPage: boolean;
    };

    const entries = await Promise.all(
      result.data
        .filter(f => f.name.type === 'address' && !FRIENDLY_ADDRESSES.has(f.name.value))
        .map(async f => {
          const state = await getPlayerState(f.name.value);
          return state ? { address: f.name.value, state } : null;
        })
    );
    all.push(...entries.filter((e): e is PlayerEntry => e !== null));

    if (!result.hasNextPage || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return all;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function claimFlag(address: string): Promise<boolean> {
  console.log("Shield threshold reached! Claiming flag...");
  const tx = new Transaction();
  const flag = tx.moveCall({
    target: `${CTF_PACKAGE_ID}::sabotage_arena::claim_flag`,
    arguments: [tx.object(ARENA_ID), tx.object(CLOCK_ID)],
  });
  tx.transferObjects([flag], address);
  const result = await suiClient.signAndExecuteTransaction({ transaction: tx, signer: keypair });
  if (result.Transaction) {
    console.log("Flag claimed!");
    console.log(`View: https://suiscan.xyz/testnet/tx/${result.Transaction.digest}`);
    return true;
  }
  console.error(`Claim failed. Digest: ${result.FailedTransaction?.digest}`);
  return false;
}

(async () => {
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`Wallet: ${address}`);

  // Fetch state with retries to handle indexer lag
  let player = await getPlayerState(address);
  for (let i = 0; i < 5 && !player; i++) {
    await sleep(2000);
    player = await getPlayerState(address);
  }

  if (!player) {
    console.log("Not registered. Registering...");
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${CTF_PACKAGE_ID}::sabotage_arena::register`,
        arguments: [tx.object(ARENA_ID), tx.object(CLOCK_ID)],
      });
      const result = await suiClient.signAndExecuteTransaction({ transaction: tx, signer: keypair });
      console.log(`Registered! Digest: ${result.Transaction?.digest}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('abort code: 0')) {
        console.log("Already registered (indexer lag on previous run). Continuing...");
      } else {
        throw e;
      }
    }
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      player = await getPlayerState(address);
      if (player) break;
      console.log(`Waiting for indexer... (${i + 1}/10)`);
    }
  }

  if (!player) throw new Error("Failed to fetch player state after registration");
  console.log(`Player state: shield=${player.shield}, last_action_ms=${player.last_action_ms}`);

  while (true) {
    player = await getPlayerState(address);
    if (!player) throw new Error("Player state not found");

    console.log(`Shield: ${player.shield}/12`);

    if (player.shield >= 12 && await claimFlag(address)) break;

    const now = Date.now();
    const cooldownUntil = player.last_action_ms + 600_000;

    if (now < cooldownUntil) {
      const waitMs = cooldownUntil - now + 1000;
      const waitMin = Math.floor(waitMs / 60000);
      const waitSec = Math.ceil((waitMs % 60000) / 1000);
      console.log(`Cooldown active. Waiting ${waitMin}m ${waitSec}s...`);
      await sleep(waitMs);
      continue;
    }

    // Cooldown ready — scan players and decide: attack or build?
    const opponents = (await scanPlayers(address))
      .sort((a, b) => b.state.shield - a.state.shield);

    const leader = opponents[0];
    // Only attack if we're within 3 of the leader (competitive) and they're worth hitting
    const shouldAttack = leader &&
      leader.state.shield >= 3 &&
      player.shield >= leader.state.shield - 3;

    if (shouldAttack) {
      // Try each opponent in descending shield order; skip any that fail (already claimed/left)
      let attacked = false;
      for (const opponent of opponents) {
        if (opponent.state.shield < 3) break; // not worth attacking
        console.log(`Attacking ${opponent.address} (shield=${opponent.state.shield})...`);
        const tx = new Transaction();
        tx.moveCall({
          target: `${CTF_PACKAGE_ID}::sabotage_arena::attack`,
          arguments: [tx.object(ARENA_ID), tx.pure.address(opponent.address), tx.object(CLOCK_ID)],
        });
        try {
          const result = await suiClient.signAndExecuteTransaction({ transaction: tx, signer: keypair });
          if (result.Transaction) {
            console.log(`Attacked! Digest: ${result.Transaction.digest}`);
            attacked = true;
            break;
          }
          console.log(`Attack on ${opponent.address} failed (already claimed?), trying next...`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message.slice(0, 120) : String(e);
          console.log(`Attack on ${opponent.address} threw (${msg}), trying next...`);
        }
      }

      if (!attacked) {
        console.log("No valid attack targets. Building instead...");
        const tx = new Transaction();
        tx.moveCall({
          target: `${CTF_PACKAGE_ID}::sabotage_arena::build`,
          arguments: [tx.object(ARENA_ID), tx.object(CLOCK_ID)],
        });
        const result = await suiClient.signAndExecuteTransaction({ transaction: tx, signer: keypair });
        console.log(`Built! Digest: ${result.Transaction?.digest}`);
      }
    } else {
      console.log(`No threats (leader shield=${leader?.state.shield ?? 0}). Building...`);
      const tx = new Transaction();
      tx.moveCall({
        target: `${CTF_PACKAGE_ID}::sabotage_arena::build`,
        arguments: [tx.object(ARENA_ID), tx.object(CLOCK_ID)],
      });
      const result = await suiClient.signAndExecuteTransaction({ transaction: tx, signer: keypair });
      console.log(`Built! Digest: ${result.Transaction?.digest}`);
    }

    // Wait for indexer, then immediately check if we can claim
    await sleep(2000);
    player = await getPlayerState(address);
    if (player && player.shield >= 12 && await claimFlag(address)) break;
  }
})();
