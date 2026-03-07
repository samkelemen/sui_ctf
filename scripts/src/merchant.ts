import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import keyPairJson from "../keypair.json" with { type: "json" };

const PACKAGE_ID = "0xd56e5075ba297f9e37085a37bb0abba69fabdf9987f8f4a6086a3693d88efbfd";
const COST_PER_FLAG = 5_849_000n;
const USDC_PACKAGE = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29";
const USDC_TYPE = `${USDC_PACKAGE}::usdc::USDC`;

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiGrpcClient({
	network: 'testnet',
	baseUrl: 'https://fullnode.testnet.sui.io:443',
});

(async () => {
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`Wallet: ${address}`);

  const { objects: coins } = await suiClient.listCoins({ owner: address, coinType: USDC_TYPE });
  if (coins.length === 0) throw new Error("No USDC coins found in wallet");

  const totalBalance = coins.reduce((sum, c) => sum + BigInt(c.balance), 0n);
  console.log(`USDC balance: ${totalBalance} base units (${Number(totalBalance) / 1_000_000} USDC)`);

  const tx = new Transaction();

  if (coins.length > 1) {
    tx.mergeCoins(
      tx.object(coins[0].objectId),
      coins.slice(1).map(c => tx.object(c.objectId))
    );
  }

  const [payment] = tx.splitCoins(tx.object(coins[0].objectId), [COST_PER_FLAG]);

  const flag = tx.moveCall({
    target: `${PACKAGE_ID}::merchant::buy_flag`,
    arguments: [payment],
  });

  tx.transferObjects([flag], address);

  const result = await suiClient.signAndExecuteTransaction({ transaction: tx, signer: keypair });
  const digest = result.Transaction?.digest ?? result.FailedTransaction?.digest;
  console.log("Flag captured!");
  console.log("Digest:", digest);
  console.log(`View on explorer: https://suiscan.xyz/testnet/tx/${digest}`);
})();
