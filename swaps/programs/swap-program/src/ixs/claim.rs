use anchor_lang::{
    prelude::*,
    solana_program::hash,
    solana_program::sysvar::instructions::load_instruction_at_checked,
    solana_program::instruction::Instruction,
    system_program
};

use crate::enums::*;
use crate::errors::*;
use crate::state::*;
use crate::events::*;
use crate::structs::*;

//Processes & checks the claim data - uses data from data_account if provided, otherwise uses data passed in secret param, emits ClaimEvent, throws on failure
pub fn process_claim(signer: &Signer, swap_data: &SwapData, ix_sysvar: &AccountInfo, data_account: &mut Option<UncheckedAccount>, secret: &[u8]) -> Result<()> {

    let event_secret = match data_account {
        Some(data_acc) => {
            require!(
                data_acc.is_writable,
                SwapErrorCode::InvalidAccountWritability
            );

            let event_secret;
            {
                let acc_data = data_acc.try_borrow_data()?;
                require!(
                    acc_data[0..32]==signer.key.to_bytes(),
                    SwapErrorCode::InvalidUserData
                );
        
                event_secret = check_claim(swap_data, ix_sysvar, &acc_data[32..])?;
            }
            
            let mut acc_balance = data_acc.try_borrow_mut_lamports()?;
            let balance: u64 = **acc_balance;
            **acc_balance = 0;

            let mut signer_balance = signer.try_borrow_mut_lamports()?;
            **signer_balance += balance;

            event_secret
        },
        None => check_claim(swap_data, ix_sysvar, secret)?
    };

    emit!(ClaimEvent {
        hash: swap_data.hash,
        secret: event_secret,
        sequence: swap_data.sequence
    });
    
    Ok(())
}

//Verifies if the claim is claimable by the claimer, provided the secret data (tx data or preimage for HTLC), returns the preimage (for HTLC, or TXHASH for PTLC)
pub fn check_claim(swap_data: &SwapData, ix_sysvar: &AccountInfo, secret: &[u8]) -> Result<[u8; 32]> {
    match swap_data.kind {
        SwapType::Htlc => check_claim_htlc(swap_data, secret),
        SwapType::Chain | SwapType::ChainNonced | SwapType::ChainTxhash => check_claim_chain(swap_data, ix_sysvar, secret)
    }
}

//Verifies claim of HTLC by checking that a secret (the first 32 bytes of the secret) properly hash to escrow state hash, returns the 32 byte secret
pub fn check_claim_htlc(swap_data: &SwapData, secret: &[u8]) -> Result<[u8; 32]> {
    //Check HTLC hash for lightning
    let hash_result = hash::hash(&secret[..32]).to_bytes();

    require!(
        hash_result == swap_data.hash,
        SwapErrorCode::InvalidSecret
    );

    Ok(secret[..32].try_into().unwrap())
}

//Verifies claim of PTLC by verifying the tx_hash with btc relay program, returns the transaction hash
pub fn check_claim_chain(swap_data: &SwapData, ix_sysvar: &AccountInfo, secret: &[u8]) -> Result<[u8; 32]> {
    //txhash to be checked with bitcoin relay program
    let tx_hash: [u8; 32] = match swap_data.kind {
        SwapType::ChainTxhash => swap_data.hash,
        SwapType::Chain | SwapType::ChainNonced => {
            //Extract output index from secret
            let output_index = u32::from_le_bytes(secret[0..4].try_into().unwrap());
            //Verify transaction, starting from byte 4 of the secret
            let opt_tx = crate::utils::btctx::verify_transaction(&secret[4..], output_index.into(), swap_data.kind==SwapType::ChainNonced);

            //Has to be properly parsed
            require!(
                opt_tx.is_some(),
                SwapErrorCode::InvalidTx
            );

            let tx = opt_tx.unwrap();

            //Has to contain the required vout
            require!(
                tx.out.is_some(),
                SwapErrorCode::InvalidVout
            );

            let tx_output = tx.out.unwrap();

            //Extract data from the vout
            let mut output_data = Vec::with_capacity(8+8+tx_output.script.len());
            output_data.extend_from_slice(&u64::to_le_bytes(swap_data.nonce));
            output_data.extend_from_slice(&u64::to_le_bytes(tx_output.value));
            output_data.extend_from_slice(tx_output.script);

            //Hash the nonce, output value and output script
            let hash_result = hash::hash(&output_data).to_bytes();
            require!(
                hash_result == swap_data.hash,
                SwapErrorCode::InvalidSecret
            );

            if swap_data.kind==SwapType::ChainNonced {
                //For the transaction nonce, we utilize nSequence and timelock,
                // this uniquelly identifies the transaction output, even if it's an address re-use
                let n_sequence_u64: u64 = (tx.n_sequence as u64) & 0x00FFFFFF;
                let locktime_u64: u64 = (tx.locktime as u64)-500000000;
                let tx_nonce: u64 = (locktime_u64<<24) | n_sequence_u64;
                require!(
                    tx_nonce == swap_data.nonce,
                    SwapErrorCode::InvalidNonce
                );
            }

            tx.hash
        },
        _ => panic!()
    };

    //Check that there was a previous instruction verifying
    // the transaction ID against btcrelay program
    let ix: Instruction = load_instruction_at_checked(0, ix_sysvar)?;
    
    //Throws on failure
    crate::utils::btcrelay::verify_tx_ix(&ix, &tx_hash, swap_data.confirmations as u32)?;

    Ok(tx_hash)
}

//Handles payout of claimer bounty & paying the rest back to initializer
pub fn pay_claimer_bounty<'info>(signer: &Signer, initializer: &AccountInfo<'info>, escrow_state: &Account<'info, EscrowState>) -> Result<()> {

    //Pay out claimer bounty to signer, rest goes back to initializer
    if escrow_state.claimer_bounty>0 {
        let data_starting_lamports = escrow_state.to_account_info().lamports();

        let signer_starting_lamports = signer.to_account_info().lamports();
        **signer.to_account_info().lamports.borrow_mut() = signer_starting_lamports.checked_add(escrow_state.claimer_bounty).unwrap();

        let initializer_starting_lamports = initializer.lamports();
        **initializer.lamports.borrow_mut() = initializer_starting_lamports.checked_add(data_starting_lamports - escrow_state.claimer_bounty).unwrap();
        
        **escrow_state.to_account_info().lamports.borrow_mut() = 0;
    
        escrow_state.to_account_info().assign(&system_program::ID);
        escrow_state.to_account_info().realloc(0, false).unwrap();
    } else {
        escrow_state.close(initializer.to_account_info()).unwrap();
    }

    Ok(())

}
