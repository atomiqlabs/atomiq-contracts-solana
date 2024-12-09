use anchor_lang::{
    prelude::*, 
    solana_program::clock, 
    solana_program::hash,
    solana_program::sysvar::instructions::load_instruction_at_checked,
    solana_program::instruction::Instruction,
    system_program
};

use crate::errors::*;
use crate::state::*;
use crate::events::*;

fn now_ts() -> Result<u64> {
    Ok(clock::Clock::get().unwrap().unix_timestamp.try_into().unwrap())
}

//Processes & checks refund (either via coop close signature, or timeout), updates reputation of the
// claimer (if the swap was pay_out=false), emits ClaimEvent, throws on failure,
// returns whether the refund was cooperative or not
pub fn process_refund(auth_expiry: u64, escrow_state: &Account<EscrowState>, ix_sysvar: &Option<AccountInfo>, user_data_claimer: &mut Option<Account<UserAccount>>) -> Result<bool> {
    
    let is_cooperative = auth_expiry>0;

    if is_cooperative {
        verify_signature(auth_expiry, escrow_state, ix_sysvar.as_ref().unwrap())?;
    } else {
        verify_timeout(escrow_state, ix_sysvar)?;
    }

    //Update the on-chain reputation of claimer in case this was not pay_out swap
    if !escrow_state.data.pay_out {
        let user_data_claimer = user_data_claimer.as_mut().expect("Claimer UserData not provided for pay_out=false swap");

        if is_cooperative {
            user_data_claimer.coop_close_volume[escrow_state.data.kind as usize] = user_data_claimer.coop_close_volume[escrow_state.data.kind as usize].saturating_add(escrow_state.data.amount);
            user_data_claimer.coop_close_count[escrow_state.data.kind as usize] = user_data_claimer.coop_close_count[escrow_state.data.kind as usize].saturating_add(1);
        } else {
            user_data_claimer.fail_volume[escrow_state.data.kind as usize] = user_data_claimer.fail_volume[escrow_state.data.kind as usize].saturating_add(escrow_state.data.amount);
            user_data_claimer.fail_count[escrow_state.data.kind as usize] = user_data_claimer.fail_count[escrow_state.data.kind as usize].saturating_add(1);
        }
    }

    emit!(RefundEvent {
        hash: escrow_state.data.hash,
        sequence: escrow_state.data.sequence
    });

    Ok(is_cooperative)

}

//Verifies cooperative refund using the signature from claimer, throws on failure
pub fn verify_signature(auth_expiry: u64, escrow_state: &Account<EscrowState>, ix_sysvar: &AccountInfo) -> Result<()> {
    require!(
        auth_expiry > now_ts()?,
        SwapErrorCode::AuthExpired
    );

    //Load ed25519 verify instruction at 0-th index
    let ix: Instruction = load_instruction_at_checked(0, ix_sysvar)?;

    //Construct "refund" message
    let mut msg = Vec::with_capacity(6+8+8+8+32+8);
    msg.extend_from_slice(b"refund");
    msg.extend_from_slice(&escrow_state.data.amount.to_le_bytes());
    msg.extend_from_slice(&escrow_state.data.expiry.to_le_bytes());
    msg.extend_from_slice(&escrow_state.data.sequence.to_le_bytes());
    msg.extend_from_slice(&escrow_state.data.hash);
    msg.extend_from_slice(&auth_expiry.to_le_bytes());

    //Check that the ed25519 verify instruction verified the signature of the hash of the "refund" message
    //Throws on verify fail
    crate::utils::signature::verify_ed25519_ix(&ix, &escrow_state.claimer.to_bytes(), &hash::hash(&msg).to_bytes())?;

    Ok(())
}

//Verifies timeout refund using timestamp or btc relay blockheight, throws on failure
pub fn verify_timeout(escrow_state: &Account<EscrowState>, ix_sysvar: &Option<AccountInfo>) -> Result<()> {
    //Check if the contract is expired yet
    if escrow_state.data.expiry < crate::BLOCKHEIGHT_EXPIRY_THRESHOLD {
        //Expiry is expressed in bitcoin blockheight
        
        //Check that there was a previous instruction verifying
        // blockheight of btcrelay program
        // btc_relay.blockheight > escrow_state.expiry
        let ix: Instruction = load_instruction_at_checked(0, ix_sysvar.as_ref().unwrap())?;

        //Throws on failure
        crate::utils::btcrelay::verify_blockheight_ix(&ix, escrow_state.data.expiry.try_into().unwrap(), 2)?;
    } else {
        //Expiry is expressed as UNIX timestamp in seconds
        require!(
            escrow_state.data.expiry < now_ts()?,
            SwapErrorCode::NotExpiredYet
        );
    }

    Ok(())
}

//Pays out security deposit to offerer & pays the rest back to initializer
pub fn pay_security_deposit<'info>(escrow_state: &mut Account<'info, EscrowState>, offerer: &mut Signer<'info>, claimer: &mut AccountInfo<'info>, is_cooperative: bool) -> Result<()> {

    let initializer = if escrow_state.data.pay_in { offerer.to_account_info() } else { claimer.to_account_info() };
    if is_cooperative {
        //Coop closure, whole PDA amount (rent, security deposit & claimer bounty) is returned to initializer
        escrow_state.close(initializer).unwrap();
    } else {
        //Un-cooperative closure, security deposit goes to offerer, rest is paid out to the initializer
        if escrow_state.security_deposit>0 {
            let offerer_starting_lamports = offerer.to_account_info().lamports();
            let initializer_starting_lamports = initializer.lamports();
            let data_starting_lamports = escrow_state.to_account_info().lamports();

            **offerer.to_account_info().lamports.borrow_mut() = offerer_starting_lamports.checked_add(escrow_state.security_deposit).unwrap();
            **initializer.lamports.borrow_mut() = initializer_starting_lamports.checked_add(data_starting_lamports - escrow_state.security_deposit).unwrap();
            **escrow_state.to_account_info().lamports.borrow_mut() = 0;
        
            escrow_state.to_account_info().assign(&system_program::ID);
            escrow_state.to_account_info().realloc(0, false).unwrap();
        } else {
            escrow_state.close(initializer).unwrap();
        }
    }

    Ok(())
}
