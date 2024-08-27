import { SchnorrAccountContractArtifact } from "@aztec/accounts/schnorr";
import { getInitialTestAccountsWallets } from "@aztec/accounts/testing";
import {
  AccountWallet,
  AztecAddress,
  BatchCall,
  ContractInstanceWithAddress,
  EthAddress,
  Fr,
  createDebugLogger,
  createPXEClient,
  waitForPXE,
  type DebugLogger,
  type PXE,
  type Wallet,
} from "@aztec/aztec.js";
import {
  deployInstance,
  registerContractClass,
} from "@aztec/aztec.js/deployment";
import { createAztecNodeClient } from "@aztec/circuit-types";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { TokenBridgeContract } from "./fixtures/TokenBridge.js";

import { RollupAbi } from "@aztec/l1-artifacts";
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { CrossChainTestHarness } from "./shared/cross_chain_test_harness.js";

const {
  PXE_URL = "http://localhost:8080",
  ETHEREUM_HOST = "http://localhost:8545",
} = process.env;
const MNEMONIC = "test test test test test test test test test test test junk";
const hdAccount = mnemonicToAccount(MNEMONIC);
const aztecNode = createAztecNodeClient(PXE_URL);
export const NO_L1_TO_L2_MSG_ERROR =
  /No non-nullified L1 to L2 message found for message hash|Tried to consume nonexistent L1-to-L2 message/;

async function publicDeployAccounts(
  sender: Wallet,
  accountsToDeploy: Wallet[],
  pxe: PXE
) {
  const accountAddressesToDeploy = await Promise.all(
    accountsToDeploy.map(async (a) => {
      const address = await a.getAddress();
      const isDeployed = await pxe.isContractPubliclyDeployed(address);
      return { address, isDeployed };
    })
  ).then((results) =>
    results
      .filter((result) => !result.isDeployed)
      .map((result) => result.address)
  );
  if (accountAddressesToDeploy.length === 0) return;
  const instances: ContractInstanceWithAddress[] = await Promise.all(
    accountAddressesToDeploy.map((account) =>
      sender.getContractInstance(account)
    )
  );
  const batch = new BatchCall(sender, [
    (
      await registerContractClass(sender, SchnorrAccountContractArtifact)
    ).request(),
    ...instances.map((instance) => deployInstance(sender, instance!).request()),
  ]);
  await batch.send().wait();
}

describe("e2e_cross_chain_messaging", () => {
  jest.setTimeout(90_000);

  let logger: DebugLogger;
  let wallets: AccountWallet[];
  let user1Wallet: AccountWallet;
  let user2Wallet: AccountWallet;
  let ethAccount: EthAddress;
  let ownerAddress: AztecAddress;

  let crossChainTestHarness: CrossChainTestHarness;
  let l2Token: TokenContract;
  let l2Bridge: TokenBridgeContract;
  let outbox: any;

  let rollup: any;

  beforeAll(async () => {
    console.log("Deploying accounts...");
    logger = createDebugLogger("aztec:e2e_uniswap");
    const pxe = createPXEClient(PXE_URL);
    await waitForPXE(pxe);
    console.log("Getting initial test accounts wallets...");
    wallets = await getInitialTestAccountsWallets(pxe);

    // deploy the accounts publicly to use public authwits
    console.log("Deploying accounts publicly...");
    await publicDeployAccounts(wallets[0], wallets, pxe);
  });

  beforeEach(async () => {
    logger = createDebugLogger("aztec:e2e_uniswap");
    const pxe = createPXEClient(PXE_URL);
    console.log("Waiting for PXE...");
    await waitForPXE(pxe);

    const walletClient = createWalletClient({
      account: hdAccount,
      chain: foundry,
      transport: http(ETHEREUM_HOST),
    });
    const publicClient = createPublicClient({
      chain: foundry,
      transport: http(ETHEREUM_HOST),
    });

    console.log("Creating cross chain test harness...");
    crossChainTestHarness = await CrossChainTestHarness.new(
      aztecNode,
      pxe,
      publicClient,
      walletClient,
      wallets[0],
      logger
    );

    rollup = getContract({
      address:
        crossChainTestHarness.l1ContractAddresses.rollupAddress.toString(),
      abi: RollupAbi,
      client: crossChainTestHarness.walletClient,
    });

    l2Token = crossChainTestHarness.l2Token;
    l2Bridge = crossChainTestHarness.l2Bridge;
    ethAccount = crossChainTestHarness.ethAccount;
    ownerAddress = crossChainTestHarness.ownerAddress;
    outbox = crossChainTestHarness.outbox;
    user1Wallet = wallets[0];
    user2Wallet = wallets[1];
  });
  it("Privately deposit funds from L1 -> L2 and withdraw back to L1", async () => {
    console.log("Privately deposit funds from L1 -> L2 and withdraw back to L1");
    // Generate a claim secret using pedersen
    const l1TokenBalance = 1000000n;
    const bridgeAmount = 100n;

    const [secretForL2MessageConsumption, secretHashForL2MessageConsumption] =
      crossChainTestHarness.generateClaimSecret();
    const [secretForRedeemingMintedNotes, secretHashForRedeemingMintedNotes] =
      crossChainTestHarness.generateClaimSecret();

    // 1. Mint tokens on L1
    await crossChainTestHarness.mintTokensOnL1(l1TokenBalance);

    // 2. Deposit tokens to the TokenPortal
    const msgHash = await crossChainTestHarness.sendTokensToPortalPrivate(
      secretHashForRedeemingMintedNotes,
      bridgeAmount,
      secretHashForL2MessageConsumption
    );
    expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(
      l1TokenBalance - bridgeAmount
    );

    await crossChainTestHarness.makeMessageConsumable(msgHash);

    // 3. Consume L1 -> L2 message and mint private tokens on L2
    await crossChainTestHarness.consumeMessageOnAztecAndMintPrivately(
      secretHashForRedeemingMintedNotes,
      bridgeAmount,
      secretForL2MessageConsumption
    );
    // tokens were minted privately in a TransparentNote which the owner (person who knows the secret) must redeem:
    await crossChainTestHarness.redeemShieldPrivatelyOnL2(
      bridgeAmount,
      secretForRedeemingMintedNotes
    );
    await crossChainTestHarness.expectPrivateBalanceOnL2(
      ownerAddress,
      bridgeAmount
    );

    // time to withdraw the funds again!
    logger.info("Withdrawing funds from L2");

    // 4. Give approval to bridge to burn owner's funds:
    const withdrawAmount = 9n;
    const nonce = Fr.random();
    await user1Wallet.createAuthWit({
      caller: l2Bridge.address,
      action: l2Token.methods.burn(ownerAddress, withdrawAmount, nonce),
    });

    // 5. Withdraw owner's funds from L2 to L1
    const l2ToL1Message =
      crossChainTestHarness.getL2ToL1MessageLeaf(withdrawAmount);
    const l2TxReceipt =
      await crossChainTestHarness.withdrawPrivateFromAztecToL1(
        withdrawAmount,
        nonce
      );
    await crossChainTestHarness.expectPrivateBalanceOnL2(
      ownerAddress,
      bridgeAmount - withdrawAmount
    );

    const [l2ToL1MessageIndex, siblingPath] =
      await aztecNode.getL2ToL1MessageMembershipWitness(
        l2TxReceipt.blockNumber!,
        l2ToL1Message
      );

    // Since the outbox is only consumable when the block is proven, we need to set the block to be proven
    await rollup.write.setAssumeProvenUntilBlockNumber([
      await rollup.read.pendingBlockCount(),
    ]);

    // Check balance before and after exit.
    expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(
      l1TokenBalance - bridgeAmount
    );
    await crossChainTestHarness.withdrawFundsFromBridgeOnL1(
      withdrawAmount,
      l2TxReceipt.blockNumber!,
      l2ToL1MessageIndex,
      siblingPath
    );
    expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(
      l1TokenBalance - bridgeAmount + withdrawAmount
    );
  });
  it("Publicly deposit funds from L1 -> L2 and withdraw back to L1", async () => {
    // Generate a claim secret using pedersen
    const l1TokenBalance = 1000000n;
    const bridgeAmount = 100n;

    const [secret, secretHash] = crossChainTestHarness.generateClaimSecret();

    // 1. Mint tokens on L1
    logger.verbose(`1. Mint tokens on L1`);
    await crossChainTestHarness.mintTokensOnL1(l1TokenBalance);

    // 2. Deposit tokens to the TokenPortal
    logger.verbose(`2. Deposit tokens to the TokenPortal`);
    const msgHash = await crossChainTestHarness.sendTokensToPortalPublic(
      bridgeAmount,
      secretHash
    );
    expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(
      l1TokenBalance - bridgeAmount
    );

    // Wait for the message to be available for consumption
    logger.verbose(`Wait for the message to be available for consumption`);
    await crossChainTestHarness.makeMessageConsumable(msgHash);

    // Get message leaf index, needed for claiming in public
    const maybeIndexAndPath = await aztecNode.getL1ToL2MessageMembershipWitness(
      "latest",
      msgHash,
      0n
    );
    expect(maybeIndexAndPath).toBeDefined();
    const messageLeafIndex = maybeIndexAndPath![0];

    // 3. Consume L1 -> L2 message and mint public tokens on L2
    logger.verbose("3. Consume L1 -> L2 message and mint public tokens on L2");
    await crossChainTestHarness.consumeMessageOnAztecAndMintPublicly(
      bridgeAmount,
      secret,
      messageLeafIndex
    );
    await crossChainTestHarness.expectPublicBalanceOnL2(
      ownerAddress,
      bridgeAmount
    );
    const afterBalance = bridgeAmount;

    // time to withdraw the funds again!
    logger.info("Withdrawing funds from L2");

    // 4. Give approval to bridge to burn owner's funds:
    const withdrawAmount = 9n;
    const nonce = Fr.random();
    await user1Wallet
      .setPublicAuthWit(
        {
          caller: l2Bridge.address,
          action: l2Token.methods
            .burn_public(ownerAddress, withdrawAmount, nonce)
            .request(),
        },
        true
      )
      .send()
      .wait();

    // 5. Withdraw owner's funds from L2 to L1
    logger.verbose("5. Withdraw owner funds from L2 to L1");
    const l2ToL1Message =
      crossChainTestHarness.getL2ToL1MessageLeaf(withdrawAmount);
    const l2TxReceipt = await crossChainTestHarness.withdrawPublicFromAztecToL1(
      withdrawAmount,
      nonce
    );
    await crossChainTestHarness.expectPublicBalanceOnL2(
      ownerAddress,
      afterBalance - withdrawAmount
    );

    // Check balance before and after exit.
    expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(
      l1TokenBalance - bridgeAmount
    );

    const [l2ToL1MessageIndex, siblingPath] =
      await aztecNode.getL2ToL1MessageMembershipWitness(
        l2TxReceipt.blockNumber!,
        l2ToL1Message
      );

    // wait 5 seconds for the block to be proven
    console.log("⚠ Waiting for block to be proven...");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    // await t.assumeProven();

    await crossChainTestHarness.withdrawFundsFromBridgeOnL1(
      withdrawAmount,
      l2TxReceipt.blockNumber!,
      l2ToL1MessageIndex,
      siblingPath
    );
    expect(await crossChainTestHarness.getL1BalanceOf(ethAccount)).toBe(
      l1TokenBalance - bridgeAmount + withdrawAmount
    );
  }, 120_000);
});
