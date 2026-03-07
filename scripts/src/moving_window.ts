import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE_ID = "0xd56e5075ba297f9e37085a37bb0abba69fabdf9987f8f4a6086a3693d88efbfd";
const CLOCK_ID = "0x6";

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiGrpcClient({
	network: 'testnet',
	baseUrl: 'https://fullnode.testnet.sui.io:443',
});

// Returns milliseconds until the next open window (0 if already open).
// Windows: seconds 0-300 and 1800-2100 within each hour.
function msUntilNextWindow(): number {
  const secondsInHour = Math.floor(Date.now() / 1000) % 3600;

  if ((secondsInHour >= 0 && secondsInHour < 300) || (secondsInHour >= 1800 && secondsInHour < 2100)) {
    return 0;
  }

  let secsUntilNext: number;
  if (secondsInHour < 1800) {
    secsUntilNext = 1800 - secondsInHour;
  } else {
    secsUntilNext = 3600 - secondsInHour;
  }

  return (secsUntilNext + 3) * 1000; // +3s buffer for on-chain clock skew
}

(async () => {
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`Wallet: ${address}`);

  const waitMs = msUntilNextWindow();
  if (waitMs > 0) {
    console.log(`Window is closed. Waiting ${Math.ceil(waitMs / 1000)}s until next window opens...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  console.log("Window is open! Submitting transaction...");

  const tx = new Transaction();
  const flag = tx.moveCall({
    target: `${PACKAGE_ID}::moving_window::extract_flag`,
    arguments: [tx.object(CLOCK_ID)],
  });
  tx.transferObjects([flag], address);

  const result = await suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
  });

  const digest = result.Transaction?.digest ?? result.FailedTransaction?.digest;
  console.log("Flag captured!");
  console.log("Digest:", digest);
  console.log(`View on explorer: https://suiscan.xyz/testnet/tx/${digest}`);
})();