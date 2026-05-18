use anchor_lang::{
    prelude::*, 
    solana_program::clock,
    system_program
};
use anchor_spl::token::{
    Mint
};
use std::cmp;

use crate::enums::*;
use crate::errors::*;
use crate::state::*;
use crate::events::*;
use crate::structs::*;

fn now_ts() -> Result<u64> {
    Ok(clock::Clock::get().unwrap().unix_timestamp.try_into().unwrap())
}

#[allow(clippy::too_many_arguments)]
pub fn process_initialize<'info>(
    escrow_state: &mut Account<'info, EscrowState>,
    offerer: &AccountInfo<'info>,
    claimer: &AccountInfo<'info>,
    initializer: &AccountInfo<'info>,
    claimer_ata: &Option<AccountInfo<'info>>,
    mint: &Account<'info, Mint>,

    swap_data: &SwapData,
    
    txo_hash: [u8; 32], //Only for on-chain,
    auth_expiry: u64,

    security_deposit: u64,
    claimer_bounty: u64,

    system_program_acc: &Program<'info, System>
) -> Result<()> {
    require!(
        auth_expiry > now_ts()?,
        SwapErrorCode::AuthExpired
    );

    require!(
        swap_data.confirmations <= crate::MAX_CONFIRMATIONS,
        SwapErrorCode::TooManyConfirmations
    );

    if swap_data.kind != SwapType::ChainNonced {
        require!(
            swap_data.nonce == 0,
            SwapErrorCode::InvalidSwapDataNonce
        );
    }

    escrow_state.data = swap_data.clone();

    escrow_state.offerer = *offerer.key;
    escrow_state.claimer = *claimer.to_account_info().key;

    if swap_data.pay_out {
        let claimer_ata = claimer_ata.as_ref().expect("Claimer ATA not provided for pay_out=true swap");
        escrow_state.claimer_ata = *claimer_ata.key;
    }
    escrow_state.mint = *mint.to_account_info().key;

    escrow_state.offerer_initializer = offerer.key == initializer.key;

    //We can calculate only the maximum of the two, not a sum,
    // since only one of them can ever be paid out:
    // swap success - security_deposit goes back to claimer, claimer_bounty is paid to watchtower
    // swap failed - claimer_bounty goes back to claimer, security_deposit is paid to offerer
    let required_lamports = cmp::max(security_deposit, claimer_bounty);

    //There is already some amount of lamports in the PDA, required for rent exemption
    //Only deposit more if it's required
    let dst_starting_lamports = escrow_state.to_account_info().lamports();
    if dst_starting_lamports < required_lamports {
        let difference = required_lamports - dst_starting_lamports;
        let cpi_program = system_program_acc.to_account_info();
        let transfer_lamports_instruction = system_program::Transfer{
            from: initializer.to_account_info(),
            to: escrow_state.to_account_info()
        };
        let cpi_ctx = CpiContext::new(cpi_program, transfer_lamports_instruction);
        system_program::transfer(cpi_ctx, difference)?;
    }
    
    escrow_state.security_deposit = security_deposit;
    escrow_state.claimer_bounty = claimer_bounty;

    emit!(InitializeEvent {
        hash: swap_data.hash,
        txo_hash,
        nonce: swap_data.nonce,
        kind: swap_data.kind,
        sequence: swap_data.sequence
    });

    Ok(())
}