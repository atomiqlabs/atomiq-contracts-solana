import { Keypair, SignatureResult, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction } from "@solana/web3.js";
import { AnchorProvider, Program, workspace } from "@coral-xyz/anchor";
import { SwapProgram } from "../../target/types/swap_program";
import { assert } from "chai";
import { createHash, randomBytes } from "crypto";
import { getInitializeDefaultDataNotPayIn, InitializeIXDataNotPayIn } from "../utils/escrowState";
import { parseSwapProgramError, CombinedProgramErrorType } from "../utils/program";

const program = workspace.SwapProgram as Program<SwapProgram>;
const provider: AnchorProvider = AnchorProvider.local();

async function initializeWithSuccessActionCommitment(
    commitment: Buffer
): Promise<{ init: InitializeIXDataNotPayIn; secret: Buffer; commitment: Buffer }> {
    const secret = randomBytes(32);
    const hash = createHash("sha256").update(secret).digest();

    const init = await getInitializeDefaultDataNotPayIn(
        false,
        undefined,
        undefined,
        "htlc",
        Math.floor(Date.now() / 1000) + 3600,
        hash
    );

    const tx = await program.methods
        .initialize(
            {
                ...init.params.swapData,
                hash: Buffer.from(init.params.swapData.hash),
            } as any,
            init.params.securityDeposit,
            init.params.claimerBounty,
            Buffer.from(init.params.txoHash),
            init.params.authExpiry,
            commitment
        )
        .accounts({
            claimer: init.accounts.claimer.publicKey,
            offerer: init.accounts.offerer.publicKey,
            offererUserData: init.accounts.offererUserData,
            escrowState: init.accounts.escrowState,
            mint: init.accounts.mint,
            systemProgram: init.accounts.systemProgram,
            claimerUserData: init.accounts.claimerUserData,
            claimerAta: init.accounts.claimerAta,
        })
        .transaction();

    tx.feePayer = init.accounts.claimer.publicKey;

    const signature = await provider.connection.sendTransaction(tx, [init.accounts.claimer, init.accounts.offerer], {
        skipPreflight: true,
    });
    const result = await provider.connection.confirmTransaction(signature, "confirmed");
    assert(result.value.err == null, "initialize failed: " + JSON.stringify(result.value.err));

    return {
        init,
        secret,
        commitment,
    };
}

async function executeClaim(
    init: InitializeIXDataNotPayIn,
    secret: Buffer,
    commitment?: Buffer
): Promise<{ result: SignatureResult; error: CombinedProgramErrorType }> {
    const ix = commitment == null
        ? await program.methods
              .claim(secret)
              .accounts({
                  signer: init.accounts.claimer.publicKey,
                  initializer: init.accounts.claimer.publicKey,
                  escrowState: init.accounts.escrowState,
                  ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                  claimerUserData: init.accounts.claimerUserData,
                  data: null,
              })
              .instruction()
        : await program.methods
              .claimWithSuccessAction(secret, commitment)
              .accounts({
                  signer: init.accounts.claimer.publicKey,
                  initializer: init.accounts.claimer.publicKey,
                  escrowState: init.accounts.escrowState,
                  ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
                  claimerUserData: init.accounts.claimerUserData,
                  data: null,
              })
              .instruction();

    const tx = new Transaction();
    tx.add(ix);
    tx.feePayer = init.accounts.claimer.publicKey;

    const signature = await provider.connection.sendTransaction(tx, [init.accounts.claimer as Keypair], {
        skipPreflight: true,
    });
    const confirmed = await provider.connection.confirmTransaction(signature, "confirmed");

    return {
        result: confirmed.value,
        error: parseSwapProgramError(0, confirmed.value.err),
    };
}

describe("swap-program: V2 wrappers", () => {
    it("rejects plain claim when success_action_commitment is set", async () => {
        const commitment = randomBytes(32);
        const { init, secret } = await initializeWithSuccessActionCommitment(commitment);

        const { result, error } = await executeClaim(init, secret);

        assert(result.err != null, "claim unexpectedly succeeded");
        assert(error === "InvalidSuccessActionCommitment", "unexpected error: " + error);
    });

    it("accepts claimWithSuccessAction when commitment matches", async () => {
        const commitment = randomBytes(32);
        const { init, secret } = await initializeWithSuccessActionCommitment(commitment);

        const { result, error } = await executeClaim(init, secret, commitment);

        assert(result.err == null, "claimWithSuccessAction failed: " + error);
    });
});
