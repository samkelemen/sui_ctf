import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE_ID = "0xd56e5075ba297f9e37085a37bb0abba69fabdf9987f8f4a6086a3693d88efbfd";
const POOL_ID   = "0x58ff08fb7e6d2568784abee3021c6dcbad1cd6840d448efe843462d0f5d75ba8";
const CLOCK_ID  = "0x6";
const RPC_URL   = "https://fullnode.testnet.sui.io:443";

const RECEIPT_TYPE    = `${PACKAGE_ID}::staking::StakeReceipt`;
const NUM_RECEIPTS    = 168;            // one per required hour
const MS_PER_HOUR     = 3_600_000;
const MIN_STAKE_MIST  = 1_000_000_000n; // 1 SUI — needed for claim_flag amount check

const keypair   = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiGrpcClient({ network: 'testnet', baseUrl: RPC_URL });

// ── JSON-RPC helper ───────────────────────────────────────────────────────────

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const { result, error } = await res.json() as any;
  if (error) throw new Error(JSON.stringify(error));
  return result;
}

// ── Receipt query (handles pagination) ───────────────────────────────────────

type Receipt = { objectId: string; amount: bigint; hoursStaked: number; lastUpdateTimestamp: number };

async function getReceipts(address: string): Promise<Receipt[]> {
  const receipts: Receipt[] = [];
  let cursor: string | null = null;
  do {
    const result = await rpc('suix_getOwnedObjects', [
      address,
      { filter: { StructType: RECEIPT_TYPE }, options: { showContent: true } },
      cursor,
      50,
    ]);
    for (const item of result.data) {
      const f = item.data.content.fields;
      receipts.push({
        objectId: item.data.objectId,
        amount: BigInt(f.amount),
        hoursStaked: Number(f.hours_staked),
        lastUpdateTimestamp: Number(f.last_update_timestamp),
      });
    }
    cursor = result.hasNextPage ? result.nextCursor : null;
  } while (cursor !== null);
  return receipts;
}

// ── Phase 1: create NUM_RECEIPTS stake receipts in one PTB ───────────────────

async function phase1(address: string) {
  console.log(`Phase 1 — staking ${NUM_RECEIPTS} receipts in one transaction...`);

  const tx = new Transaction();

  // Split from the gas coin (tx.gas) — avoids the coin-also-used-as-gas conflict.
  // One full SUI for the amount-check requirement; the rest 1 MIST each.
  // Merged total will be ≥ 1 SUI so claim_flag passes.
  const amounts = [MIN_STAKE_MIST, ...Array(NUM_RECEIPTS - 1).fill(1n)];
  const splits  = tx.splitCoins(tx.gas, amounts);

  const receipts = amounts.map((_, i) =>
    tx.moveCall({
      target: `${PACKAGE_ID}::staking::stake`,
      arguments: [tx.object(POOL_ID), splits[i], tx.object(CLOCK_ID)],
    })
  );

  tx.transferObjects(receipts, address);

  const result = await suiClient.signAndExecuteTransaction({ transaction: tx, signer: keypair });
  const digest = result.Transaction?.digest ?? result.FailedTransaction?.digest;
  console.log(`Phase 1 complete. Digest: ${digest}`);
  console.log(`View: https://suiscan.xyz/testnet/tx/${digest}`);
  await suiClient.waitForTransaction({ digest: digest! });
}

// ── Phase 2: update all receipts, merge them, claim flag ─────────────────────

async function phase2(address: string, receipts: Receipt[]) {
  console.log(`Phase 2 — updating ${receipts.length} receipts, merging, claiming flag...`);

  const tx = new Transaction();

  // update_receipt on each → each gains hours_staked = 1 (≥1 h elapsed)
  const updated = receipts.map(r =>
    tx.moveCall({
      target: `${PACKAGE_ID}::staking::update_receipt`,
      arguments: [tx.object(r.objectId), tx.object(CLOCK_ID)],
    })
  );

  // Sequential merge: hours accumulate as: 1+1+1+... = NUM_RECEIPTS = 168
  let merged = updated[0];
  for (let i = 1; i < updated.length; i++) {
    merged = tx.moveCall({
      target: `${PACKAGE_ID}::staking::merge_receipts`,
      arguments: [merged, updated[i], tx.object(CLOCK_ID)],
    });
  }

  // claim_flag returns (Flag, Coin<SUI>)
  const claimResult = tx.moveCall({
    target: `${PACKAGE_ID}::staking::claim_flag`,
    arguments: [tx.object(POOL_ID), merged, tx.object(CLOCK_ID)],
  });

  tx.transferObjects([claimResult[0], claimResult[1]], address);

  const result = await suiClient.signAndExecuteTransaction({ transaction: tx, signer: keypair });
  const digest = result.Transaction?.digest ?? result.FailedTransaction?.digest;
  console.log("Flag captured!");
  console.log("Digest:", digest);
  console.log(`View on explorer: https://suiscan.xyz/testnet/tx/${digest}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`Wallet: ${address}`);

  let receipts = await getReceipts(address);

  if (receipts.length === 0) {
    await phase1(address);
    receipts = await getReceipts(address);
    console.log(`Created ${receipts.length} receipts.`);
  } else {
    console.log(`Found ${receipts.length} existing receipts.`);
  }

  if (receipts.length < NUM_RECEIPTS) {
    throw new Error(`Expected ${NUM_RECEIPTS} receipts but only found ${receipts.length}. Re-run to retry Phase 1.`);
  }

  // Wait until every receipt is at least 1 hour old (integer division requires full hour)
  const oldestTimestamp = Math.min(...receipts.map(r => r.lastUpdateTimestamp));
  const readyAt  = oldestTimestamp + MS_PER_HOUR + 5_000; // +5 s safety buffer
  const waitMs   = readyAt - Date.now();

  if (waitMs > 0) {
    const mins = Math.ceil(waitMs / 60_000);
    const eta  = new Date(readyAt).toLocaleTimeString();
    console.log(`Waiting ${mins} min (until ${eta}) for receipts to reach 1 hour...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  } else {
    console.log("Receipts already aged ≥1 hour. Proceeding immediately.");
  }

  await phase2(address, receipts);
})();
